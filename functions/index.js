// Dog Walker Cloud Functions.
//
// Implemented:
//   - verifyAdminPin       — second-factor PIN gate for the admin portal (public/admin.html)
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
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const crypto = require("node:crypto");

initializeApp();

const ADMIN_PIN = defineSecret("ADMIN_PIN");

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Callable from public/admin.html once someone is signed in with Google.
// Being on the `admins/{email}` allowlist is the real authorization check
// (mirrored in firestore.rules); this PIN is a second factor on top of
// that so the admin portal doesn't open just because a browser/device
// happens to be signed into an admin's Google account.
exports.verifyAdminPin = onCall({ secrets: [ADMIN_PIN] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in first.");
  }
  const email = request.auth.token.email;
  if (!email || !request.auth.token.email_verified) {
    throw new HttpsError("permission-denied", "Not authorized.");
  }

  const db = getFirestore();
  const adminSnap = await db.collection("admins").doc(email).get();
  if (!adminSnap.exists) {
    throw new HttpsError("permission-denied", "Not authorized.");
  }

  const attemptRef = db.collection("adminPinAttempts").doc(request.auth.uid);
  const attemptSnap = await attemptRef.get();
  const attemptData = attemptSnap.exists ? attemptSnap.data() : {};
  const now = Date.now();

  if (attemptData.lockedUntil && attemptData.lockedUntil > now) {
    const minutesLeft = Math.ceil((attemptData.lockedUntil - now) / 60000);
    throw new HttpsError("resource-exhausted", `Too many attempts. Try again in ${minutesLeft} minute(s).`);
  }

  const submittedPin = String((request.data && request.data.pin) || "");

  if (!safeEqual(submittedPin, ADMIN_PIN.value())) {
    const failCount = (attemptData.failCount || 0) + 1;
    const update = { failCount, lastAttemptAt: FieldValue.serverTimestamp() };
    if (failCount >= MAX_ATTEMPTS) {
      update.lockedUntil = now + LOCKOUT_MS;
      update.failCount = 0;
    }
    await attemptRef.set(update, { merge: true });
    throw new HttpsError("permission-denied", "Incorrect code.");
  }

  await attemptRef.set(
    { failCount: 0, lockedUntil: FieldValue.delete(), lastSuccessAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  return { ok: true };
});
