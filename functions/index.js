// Dog Walker Cloud Functions.
//
// Implemented:
//   - verifyAdminPin        — second-factor PIN gate for the admin panel embedded in public/dashboard.html
//   - sendPushToUser /
//     logInAppNotification  — shared notification plumbing, ported from Town-Talk/Town Fuss
//                              (see docs/ARCHITECTURE.md); not exported themselves, exist as a
//                              prerequisite for the notification-sending functions below
//   - onNewSignup /
//     onProfileSubmitted    — push notification to admins on a new/completed signup, ported from
//                              Town-Talk/Town Fuss
//   - checkImageSafeSearch  — Cloud Vision moderation on users/walkerProfiles photo uploads only
//                              (NOT dogs — dog profiles are private to the owner, see
//                              firestore.rules), ported from Town-Talk/Town Fuss
//   - onFirstMessageNotify  — push notification on the first message in a conversation,
//                              ported from Town-Talk/Town Fuss
//   - onBookingRequested    — push notification to the walker on a new booking
//   - onBookingStatusChange — push notification on accept/decline/cancel/complete
//
// Planned, adapted from patterns in a sibling Firebase project (see docs/ARCHITECTURE.md):
//   - beforeSignInBlocking  — stamp a users/{uid} stub + lastKnownIp on first sign-in
//   - stripeWebhook         — mark walkerProfiles/{uid}.listingPaidUntil on payment
//   - expireWalkerListings  — scheduled job to unpublish lapsed listings

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { defineSecret } = require("firebase-functions/params");
const { ImageAnnotatorClient } = require("@google-cloud/vision");
const crypto = require("node:crypto");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();
const visionClient = new ImageAnnotatorClient();

const ADMIN_PIN = defineSecret("ADMIN_PIN");

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const ALLOWED_ORIGINS = new Set([
  "https://dw-app-2beee.web.app",
  "https://dw-app-2beee.firebaseapp.com",
  "http://127.0.0.1:5000",
  "http://localhost:5000",
]);

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function withCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// -----------------------------------------------------------------------
// Notification plumbing — ported from the sibling Town-Talk/Town Fuss
// project's sendPushToUser()/logInAppNotification() (see docs/ARCHITECTURE.md).
// No exported Cloud Function calls these yet; they exist as a prerequisite
// for the notification-sending functions planned above (onFirstMessageNotify,
// onProfileSubmitted, etc.) so each of those can just call sendPushToUser()
// instead of re-deriving this logic. Covered by tests in
// testing/functions/run-notification-plumbing-tests.js even though nothing
// exports them yet, since check-function-coverage.js only checks exported
// functions and these two are real, non-trivial logic worth verifying now
// rather than trusting untested for however long until the first consumer
// lands.
// -----------------------------------------------------------------------

// Writes the in-app notification-bell entry — the one thing every
// notification always gets, independent of whether a push is also sent.
async function logInAppNotification(uid, { type, title, body, clickAction }) {
  try {
    await db.collection("users").doc(uid).collection("notifications").add({
      type,
      title,
      body,
      clickAction: clickAction || "/",
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`logInAppNotification(${uid}): failed:`, err);
  }
}

// Logs the in-app notification, then also sends a push IF the user has
// notifications enabled and at least one registered device token — silently
// falls back to in-app-only otherwise (no user doc, disabled, or no tokens),
// which is the normal case in every test environment (no real device ever
// registers an FCM token against the emulator), so this never makes a live
// FCM API call in CI.
async function sendPushToUser(uid, { type, title, body, clickAction }) {
  await logInAppNotification(uid, { type, title, body, clickAction });

  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) {
    console.log(`sendPushToUser(${uid}, ${type}): no users doc — in-app only`);
    return;
  }
  const userData = userSnap.data();

  if (!userData.notificationsEnabled) {
    console.log(`sendPushToUser(${uid}, ${type}): notificationsEnabled is false — in-app only`);
    return;
  }
  const tokens = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
  if (tokens.length === 0) {
    console.log(`sendPushToUser(${uid}, ${type}): notificationsEnabled but 0 fcmTokens — in-app only`);
    return;
  }

  // Real unread count at send time (includes the one logInAppNotification
  // just added above), carried in the data payload so the service worker
  // can set the home-screen icon's badge number correctly even while the
  // app is fully closed. FCM data payload values must be strings.
  const unreadSnap = await db
    .collection("users")
    .doc(uid)
    .collection("notifications")
    .where("read", "==", false)
    .count()
    .get();
  const badgeCount = String(unreadSnap.data().count);

  const message = {
    notification: { title, body },
    data: { click_action: clickAction || "/", badgeCount },
    tokens,
  };

  const response = await messaging.sendEachForMulticast(message);
  console.log(
    `sendPushToUser(${uid}, ${type}): sent to ${tokens.length} token(s), ` +
      `${response.successCount} succeeded, ${response.failureCount} failed` +
      (response.failureCount > 0
        ? ` — errors: ${response.responses.filter((r) => !r.success).map((r) => r.error?.code).join(", ")}`
        : "")
  );

  // Remove any token FCM says is no longer valid, so future sends don't
  // keep wasting a call on a dead device.
  const deadTokens = [];
  response.responses.forEach((resp, i) => {
    if (!resp.success) {
      const code = resp.error?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
        deadTokens.push(tokens[i]);
      }
    }
  });
  if (deadTokens.length > 0) {
    await db
      .collection("users")
      .doc(uid)
      .update({ fcmTokens: FieldValue.arrayRemove(...deadTokens) });
  }
}

// Notifies every allowlisted admin, resolved to a real uid to push to.
//
// Adapted, not a straight port: Town-Talk's admins/{uid} collection is
// keyed by uid, so it can call sendPushToUser(adminDoc.id, ...) directly.
// Dog Walker's admins/{email} is deliberately keyed by EMAIL instead (see
// docs/ARCHITECTURE.md — lets an address be pre-authorized before it's
// ever signed in), so there's no uid sitting on the doc to push to. This
// resolves email -> uid via the Auth admin SDK (the authoritative source,
// rather than assuming any particular Firestore field holds it) — and an
// admin who's never signed in yet simply has no Auth account to resolve,
// which is expected, not an error, so that admin is just skipped, and the
// rest still get notified normally. `excludeUid` skips one admin (e.g. an
// admin shouldn't be notified about their own signup).
async function notifyAllAdmins({ type, title, body, clickAction }, excludeUid) {
  const adminsSnap = await db.collection("admins").get();
  if (adminsSnap.empty) return;

  await Promise.all(
    adminsSnap.docs.map(async (adminDoc) => {
      const email = adminDoc.id;
      let adminUid;
      try {
        adminUid = (await getAuth().getUserByEmail(email)).uid;
      } catch (err) {
        console.log(`notifyAllAdmins: admin ${email} has no Auth account yet — skipping push`);
        return;
      }
      if (excludeUid && adminUid === excludeUid) return;

      await sendPushToUser(adminUid, { type, title, body, clickAction });
    })
  );
}

async function notifyAdminsOfSignup(newUid, name) {
  await notifyAllAdmins(
    {
      type: "signup",
      title: "Dog Walker — New Sign-Up",
      body: `${name} just signed up and is waiting on approval.`,
      clickAction: "/dashboard.html",
    },
    newUid
  );
}

// Dog Walker's signup flow is two steps (see docs/ARCHITECTURE.md /
// decision log): Google sign-in creates the users/{uid} doc first — via
// the client-side create rule, which requires role/townId/approved but
// NOT a name — then the user fills out profile.name (and the rest of
// their profile) in a separate step afterward. So exactly like Town-Talk,
// two triggers are needed: one for the (currently unused, but rules-legal)
// case where a name is already present at creation, and one for the
// expected case where it's added later.
exports.onNewSignup = onDocumentCreated("users/{uid}", async (event) => {
  const newUser = event.data?.data();
  if (!newUser?.profile?.name) return; // no real name yet — the normal case for this app's flow
  const { uid } = event.params;
  await notifyAdminsOfSignup(uid, newUser.profile.name);
});

exports.onProfileSubmitted = onDocumentUpdated("users/{uid}", async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;
  if (before.profile?.name || !after.profile?.name) return; // only the first time a REAL name appears
  const { uid } = event.params;
  await notifyAdminsOfSignup(uid, after.profile.name);
});

// Wraps the actual Vision API call behind a seam so tests can exercise the
// real Storage trigger end-to-end (path matching, flagging decision,
// Firestore writes, admin notification) without ever calling the real,
// paid, network-dependent Vision API — which has no local emulator at
// all, unlike Firestore/Auth/Storage. DOG_WALKER_VISION_TEST_MODE is
// never set in production, only by testing/functions/run-safe-search-tests.js
// and its CI step — when unset (always true in production), this calls
// the real API exactly as it always would.
async function detectSafeSearch(gcsUri, fileName) {
  if (process.env.DOG_WALKER_VISION_TEST_MODE === "1") {
    // Deterministic fake result, driven by the file NAME rather than
    // gcsUri/actual image bytes, so one test run can cover both a flagged
    // and an unflagged upload just by choosing what to name the test file.
    const flagged = fileName.includes("UNSAFE_TEST_TRIGGER");
    return [
      {
        safeSearchAnnotation: flagged
          ? { adult: "VERY_LIKELY", racy: "VERY_LIKELY" }
          : { adult: "VERY_UNLIKELY", racy: "VERY_UNLIKELY" },
      },
    ];
  }
  return visionClient.safeSearchDetection(gcsUri);
}

// Runs Cloud Vision's SafeSearch on every users/{uid} or walkerProfiles/{uid}
// photo the moment it's uploaded — first upload AND every re-upload (a
// Storage trigger fires per file-write event). Scoped to users/ and
// walkerProfiles/ only, NOT dogs/{dogId} — confirmed with the user: dog
// profiles are kept private to the owner only (see firestore.rules), so
// there's no admin-review/approved concept for a dog to pull back into,
// and no broader-audience exposure this would be protecting against on
// that path.
//
// A flagged image sets approved: false + safeSearchFlag directly on the
// profile doc — Dog Walker's admin dashboard already queries approved ==
// false to build its review queue (see docs/ARCHITECTURE.md), so unlike
// Town-Talk's version, there's no separate reviewQueue collection to also
// write to here.
//
// Never auto-deletes the image or auto-rejects the profile outright —
// SafeSearch has real false positives (swimwear, medical, art), so a
// human still makes the actual call; this only makes sure they're the one
// making it.
//
// No explicit region override (Town-Talk needed one for a specific bucket
// region outlier among its 7 projects) — dw-app-2beee has a single default
// bucket, so this deploys to the same default region as every other
// function here. Worth revisiting only if a real deploy ever fails with a
// region-mismatch error.
//
// bucket is pinned explicitly (matches public/firebase-init.js's
// storageBucket) rather than left to auto-resolve — confirmed this
// matters: the Firebase CLI resolves the default bucket via a live,
// authenticated API call, which works locally but silently differs in an
// unauthenticated CI runner, causing the trigger to listen on the wrong
// bucket and never fire at all. Pinning it removes that ambiguity in both
// environments.
exports.checkImageSafeSearch = onObjectFinalized({ bucket: "dw-app-2beee.firebasestorage.app" }, async (event) => {
  const filePath = event.data.name;
  const contentType = event.data.contentType || "";
  if (!contentType.startsWith("image/")) return;

  // users/{uid}/{fileName} or walkerProfiles/{uid}/{fileName} — flat paths,
  // no /images/ subfolder (see storage.rules); dogs/{dogId}/... never matches.
  const match = filePath.match(/^(users|walkerProfiles)\/([^/]+)\/(.+)$/);
  if (!match) return; // not a path this feature screens
  const [, collection, uid, fileName] = match;

  const gcsUri = `gs://${event.data.bucket}/${filePath}`;
  let safe;
  try {
    const [result] = await detectSafeSearch(gcsUri, fileName);
    safe = result.safeSearchAnnotation;
  } catch (err) {
    console.error(`checkImageSafeSearch(${filePath}): Vision API call failed:`, err);
    return;
  }
  if (!safe) return;

  // VERY_UNLIKELY / UNLIKELY / POSSIBLE / LIKELY / VERY_LIKELY — POSSIBLE
  // is deliberately excluded from triggering a flag (Vision's own docs
  // note it produces real false positives at that level; LIKELY and up is
  // where it's actually being confident).
  const LIKELY_OR_WORSE = new Set(["LIKELY", "VERY_LIKELY"]);
  const flaggedCategories = ["adult", "racy"].filter((category) => LIKELY_OR_WORSE.has(safe[category]));
  if (flaggedCategories.length === 0) return;

  const reason = flaggedCategories.map((category) => `${category}: ${safe[category]}`).join(", ");
  console.warn(`checkImageSafeSearch: FLAGGED ${filePath} — ${reason}`);

  await db.collection(collection).doc(uid).set(
    {
      approved: false,
      safeSearchFlag: { flagged: true, reason, fileName, checkedAt: Timestamp.now() },
    },
    { merge: true }
  );

  await notifyAllAdmins({
    type: "safesearch",
    title: "Dog Walker — Flagged Image",
    body: `An uploaded ${collection === "users" ? "profile" : "walker listing"} photo was flagged (${reason}) and pulled for review.`,
    clickAction: "/dashboard.html",
  });
});

// Fires on every new message, but only actually sends a push if this is
// the FIRST message ever created in that conversation — checking whether
// THIS message is the chronologically-oldest one (via the sentAt field
// firestore.rules now requires to be the real server timestamp), not a
// live count(). A live count is racy: if a second and third message land
// before this trigger actually runs, the count is already >1 and a
// genuinely-first message gets wrongly skipped. Checking "am I the
// oldest" is race-proof regardless of how many later messages already
// exist by the time this runs. Ported from Town-Talk's version of the
// same function.
exports.onFirstMessageNotify = onDocumentCreated(
  "conversations/{conversationId}/messages/{messageId}",
  async (event) => {
    const message = event.data?.data();
    if (!message) return;
    const { conversationId, messageId } = event.params;

    const messagesRef = db.collection("conversations").doc(conversationId).collection("messages");
    const oldestSnap = await messagesRef.orderBy("sentAt", "asc").limit(1).get();
    if (oldestSnap.empty || oldestSnap.docs[0].id !== messageId) return; // not the first message — skip

    const convoSnap = await db.collection("conversations").doc(conversationId).get();
    if (!convoSnap.exists) return;
    const convo = convoSnap.data();

    const recipientUid = (convo.participants || []).find((uid) => uid !== message.senderId);
    if (!recipientUid) return;

    // Looks up the sender's display name via users/{uid} rather than
    // trusting a client-supplied field (Town-Talk uses participantNames on
    // the conversation doc itself; Dog Walker's conversations create rule
    // doesn't validate/require any such field, so there's nothing to trust
    // there) — one extra read, but nothing new to validate in rules.
    let senderName = "Someone";
    try {
      const senderSnap = await db.collection("users").doc(message.senderId).get();
      if (senderSnap.exists) senderName = senderSnap.data().profile?.name || senderName;
    } catch {
      // Fall back to the generic name rather than failing the notification.
    }

    // TODO: clickAction should point at a real conversation-scoped route
    // once the messaging UI (Rover-parity item — see docs/ARCHITECTURE.md)
    // actually exists; dashboard.html is the closest existing page today.
    await sendPushToUser(recipientUid, {
      type: "message",
      title: "Dog Walker — New Message",
      body: `${senderName} sent you a message for the first time.`,
      clickAction: "/dashboard.html",
    });
  }
);

// Notifies the walker of a brand-new walk request.
exports.onBookingRequested = onDocumentCreated("bookings/{bookingId}", async (event) => {
  const booking = event.data?.data();
  if (!booking) return;

  const ownerSnap = await db.collection("users").doc(booking.ownerId).get();
  const ownerName = ownerSnap.exists ? ownerSnap.data().profile?.name || "A dog owner" : "A dog owner";

  await sendPushToUser(booking.walkerId, {
    type: "booking",
    title: "Dog Walker — New Booking Request",
    body: `${ownerName} requested a walk.`,
    clickAction: "/dashboard.html",
  });
});

// Notifies on accept/decline/cancel/complete. Who gets notified depends on
// who's ALLOWED to have caused each transition (see firestore.rules'
// isValidBookingTransition()) — accepted/declined can only come from the
// walker, so only the owner needs telling; cancelled/completed can come
// from either party (there's no actor field on the doc to know which),
// so both get notified for those, accepting a little redundancy for the
// one who made the change themselves rather than under-notifying.
exports.onBookingStatusChange = onDocumentUpdated("bookings/{bookingId}", async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after || before.status === after.status) return;

  const [ownerSnap, walkerSnap] = await Promise.all([
    db.collection("users").doc(after.ownerId).get(),
    db.collection("users").doc(after.walkerId).get(),
  ]);
  const ownerName = ownerSnap.exists ? ownerSnap.data().profile?.name || "The dog owner" : "The dog owner";
  const walkerName = walkerSnap.exists ? walkerSnap.data().profile?.name || "The walker" : "The walker";

  if (after.status === "accepted") {
    await sendPushToUser(after.ownerId, {
      type: "booking",
      title: "Dog Walker — Request Accepted",
      body: `${walkerName} accepted your walk request!`,
      clickAction: "/dashboard.html",
    });
  } else if (after.status === "declined") {
    await sendPushToUser(after.ownerId, {
      type: "booking",
      title: "Dog Walker — Request Declined",
      body: `${walkerName} declined your walk request.`,
      clickAction: "/dashboard.html",
    });
  } else if (after.status === "cancelled") {
    await Promise.all([
      sendPushToUser(after.ownerId, {
        type: "booking",
        title: "Dog Walker — Booking Cancelled",
        body: `Your booking with ${walkerName} was cancelled.`,
        clickAction: "/dashboard.html",
      }),
      sendPushToUser(after.walkerId, {
        type: "booking",
        title: "Dog Walker — Booking Cancelled",
        body: `Your booking with ${ownerName} was cancelled.`,
        clickAction: "/dashboard.html",
      }),
    ]);
  } else if (after.status === "completed") {
    await Promise.all([
      sendPushToUser(after.ownerId, {
        type: "booking",
        title: "Dog Walker — Walk Completed",
        body: `Your walk with ${walkerName} is marked complete.`,
        clickAction: "/dashboard.html",
      }),
      sendPushToUser(after.walkerId, {
        type: "booking",
        title: "Dog Walker — Walk Completed",
        body: `Your walk with ${ownerName} is marked complete.`,
        clickAction: "/dashboard.html",
      }),
    ]);
  }
});

// Exposed only so testing/functions/ can unit-test this logic directly —
// these are plain helper functions, not Cloud Functions, so Firebase's
// deploy-time function discovery (which only picks up exports built via
// onRequest/onCall/onDocument*/onSchedule/etc.) ignores this export
// entirely; it never becomes a deployed endpoint.
exports.__testables = { sendPushToUser, logInAppNotification };

// Called from the admin panel embedded in public/dashboard.html once
// someone is signed in with Google. Being on the `admins/{email}`
// allowlist is the real authorization check (mirrored in firestore.rules);
// this PIN is a second factor on top of that so the admin panel doesn't
// open just because a browser/device happens to be signed into an admin's
// Google account.
//
// This is a plain onRequest function, not onCall, specifically so
// invoker: "public" actually takes effect — in this firebase-functions
// version, that option is only wired up for the httpsTrigger (onRequest)
// code path, not callableTrigger (onCall); the type system accepts it on
// either, but it's silently a no-op on a callable (confirmed by reading
// node_modules/firebase-functions/lib/v2/providers/https.js directly, and
// by a deploy that produced zero setIamPolicy calls either way). Without
// this, Cloud Run's own IAM layer rejects every request with a raw 403
// before it ever reaches this code, regardless of the PIN — which is
// exactly what happened in production. Firebase auth is still verified
// manually below via the caller's ID token; that's the real gate, this
// option just lets requests reach that check in the first place.
exports.verifyAdminPin = onRequest({ secrets: [ADMIN_PIN], invoker: "public" }, async (req, res) => {
  withCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: "Sign in first." });
    return;
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(idToken);
  } catch {
    res.status(401).json({ error: "Sign in first." });
    return;
  }

  const email = decoded.email;
  if (!email || !decoded.email_verified) {
    res.status(403).json({ error: "Not authorized." });
    return;
  }

  const adminSnap = await db.collection("admins").doc(email).get();
  if (!adminSnap.exists) {
    res.status(403).json({ error: "Not authorized." });
    return;
  }

  const attemptRef = db.collection("adminPinAttempts").doc(decoded.uid);
  const attemptSnap = await attemptRef.get();
  const attemptData = attemptSnap.exists ? attemptSnap.data() : {};
  const now = Date.now();

  if (attemptData.lockedUntil && attemptData.lockedUntil > now) {
    const minutesLeft = Math.ceil((attemptData.lockedUntil - now) / 60000);
    res.status(429).json({ error: `Too many attempts. Try again in ${minutesLeft} minute(s).` });
    return;
  }

  const submittedPin = String((req.body && req.body.pin) || "");

  if (!safeEqual(submittedPin, ADMIN_PIN.value())) {
    const failCount = (attemptData.failCount || 0) + 1;
    const update = { failCount, lastAttemptAt: FieldValue.serverTimestamp() };
    if (failCount >= MAX_ATTEMPTS) {
      update.lockedUntil = now + LOCKOUT_MS;
      update.failCount = 0;
    }
    await attemptRef.set(update, { merge: true });
    res.status(403).json({ error: "Incorrect code." });
    return;
  }

  await attemptRef.set(
    { failCount: 0, lockedUntil: FieldValue.delete(), lastSuccessAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  res.status(200).json({ ok: true });
});
