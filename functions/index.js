// Dog Walker Cloud Functions.
//
// Implemented:
//   - verifyAdminPin       — second-factor PIN gate for the admin panel embedded in public/dashboard.html
//
// Planned, adapted from patterns in a sibling Firebase project (see docs/ARCHITECTURE.md):
//   - beforeSignInBlocking  — stamp a users/{uid} stub + lastKnownIp on first sign-in
//   - checkImageSafeSearch  — Cloud Vision moderation on profile/dog/walker photo uploads
//   - onBookingRequested    — push notification to the walker on a new booking
//   - onBookingStatusChange — push notification to the owner on accept/decline
//   - onFirstMessageNotify  — push notification on the first message in a conversation
//   - stripeWebhook         — mark walkerProfiles/{uid}.listingPaidUntil on payment
//   - expireWalkerListings  — scheduled job to unpublish lapsed listings

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("node:crypto");

initializeApp();

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

  const db = getFirestore();
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
