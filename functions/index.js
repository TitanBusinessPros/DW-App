// Dog Walker Cloud Functions — draft v1.
//
// Nothing is implemented yet. Planned, adapted from patterns in a sibling
// Firebase project (see docs/ARCHITECTURE.md):
//
//   - beforeSignInBlocking  — stamp a users/{uid} stub + lastKnownIp on first sign-in
//   - checkImageSafeSearch  — Cloud Vision moderation on profile/dog/walker photo uploads
//   - onBookingRequested    — push notification to the walker on a new booking
//   - onBookingStatusChange — push notification to the owner on accept/decline
//   - onFirstMessageNotify  — push notification on the first message in a conversation
//   - stripeWebhook         — mark walkerProfiles/{uid}.listingPaidUntil on payment
//   - expireWalkerListings  — scheduled job to unpublish lapsed listings

const { initializeApp } = require("firebase-admin/app");
initializeApp();
