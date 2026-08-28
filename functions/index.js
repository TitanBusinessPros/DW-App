// Dog Walker Cloud Functions.
//
// Implemented:
//   - verifyAdminPin        — second-factor PIN gate for the admin panel embedded in public/dashboard.html
//   - sendPushToUser /
//     logInAppNotification  — shared notification plumbing, ported from Town-Talk/Town Fuss
//                              (see docs/ARCHITECTURE.md); not exported themselves, exist as a
//                              prerequisite for the notification-sending functions below
//
// Planned, adapted from patterns in a sibling Firebase project (see docs/ARCHITECTURE.md):
//   - beforeSignInBlocking  — stamp a users/{uid} stub + lastKnownIp on first sign-in
//   - checkImageSafeSearch  — Cloud Vision moderation on profile/dog/walker photo uploads
//   - onBookingRequested    — push notification to the walker on a new booking
//   - onBookingStatusChange — push notification to the owner on accept/decline
//   - onFirstMessageNotify  — push notification on the first message in a conversation
//   - onProfileSubmitted /
//     onNewSignup           — push notification to admins on a new/completed signup
//   - stripeWebhook         — mark walkerProfiles/{uid}.listingPaidUntil on payment
//   - expireWalkerListings  — scheduled job to unpublish lapsed listings

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("node:crypto");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

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

// Exposed only so testing/functions/ can unit-test this logic directly —
// sendPushToUser/logInAppNotification are plain helper functions, not
// Cloud Functions, so Firebase's deploy-time function discovery (which
// only picks up exports built via onRequest/onCall/onDocument*/onSchedule/
// etc.) ignores this export entirely; it never becomes a deployed endpoint.
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
