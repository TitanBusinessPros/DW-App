// onBookingRequested / onBookingStatusChange Cloud Function tests — real
// Firestore triggers, so this needs Auth + Firestore + Functions emulators
// together. Every user here has no fcmTokens, so sendPushToUser always
// takes its safe in-app-only path — same pattern as every other function
// test in this suite.
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT_ID = "dw-app-2beee";
const app = initializeApp({ projectId: PROJECT_ID });
const auth = getAuth(app);
const db = getFirestore(app);

function notificationsRef(uid) {
  return db.collection("users").doc(uid).collection("notifications");
}

async function waitFor(conditionFn, { timeoutMs = 20000, intervalMs = 300 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await conditionFn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function settle(ms = 2000) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasNotificationContaining(uid, substring) {
  const snap = await notificationsRef(uid).get();
  return snap.docs.some((d) => (d.data().body || "").includes(substring));
}

async function main() {
  await auth.createUser({ uid: "owner-uid", email: "owner@example.com", emailVerified: true });
  await auth.createUser({ uid: "walker-uid", email: "walker@example.com", emailVerified: true });
  await db.collection("users").doc("owner-uid").set({ approved: true, profile: { name: "Olivia Owner" } });
  await db.collection("users").doc("walker-uid").set({ approved: true, profile: { name: "Wendy Walker" } });
  await settle(1500); // let the two onNewSignup firings from the seeds above settle first

  // 1. onBookingRequested notifies the WALKER, naming the real owner.
  await db.collection("bookings").doc("bk1").set({ ownerId: "owner-uid", walkerId: "walker-uid", status: "requested" });
  await waitFor(() => hasNotificationContaining("walker-uid", "Olivia Owner"));
  // The owner doesn't get a copy of their own request notification.
  if (await hasNotificationContaining("owner-uid", "requested a walk")) {
    throw new Error("owner should not be notified about their own booking request");
  }

  // 2. accepted -> notifies the OWNER only, naming the real walker.
  await db.collection("bookings").doc("bk1").update({ status: "accepted" });
  await waitFor(() => hasNotificationContaining("owner-uid", "Wendy Walker accepted"));

  // 3. declined -> notifies the OWNER only.
  await db.collection("bookings").doc("bk2").set({ ownerId: "owner-uid", walkerId: "walker-uid", status: "requested" });
  await waitFor(() => hasNotificationContaining("walker-uid", "requested a walk")); // the bk2 request notification lands first
  await db.collection("bookings").doc("bk2").update({ status: "declined" });
  await waitFor(() => hasNotificationContaining("owner-uid", "Wendy Walker declined"));

  // 4. cancelled -> notifies BOTH parties.
  await db.collection("bookings").doc("bk3").set({ ownerId: "owner-uid", walkerId: "walker-uid", status: "accepted" });
  await settle(1500); // no onBookingRequested fires here (status isn't "requested"), just settle
  await db.collection("bookings").doc("bk3").update({ status: "cancelled" });
  await waitFor(() => hasNotificationContaining("owner-uid", "cancelled"));
  await waitFor(() => hasNotificationContaining("walker-uid", "cancelled"));

  // 5. completed -> notifies BOTH parties.
  await db.collection("bookings").doc("bk4").set({ ownerId: "owner-uid", walkerId: "walker-uid", status: "accepted" });
  await settle(1500);
  await db.collection("bookings").doc("bk4").update({ status: "completed" });
  await waitFor(() => hasNotificationContaining("owner-uid", "marked complete"));
  await waitFor(() => hasNotificationContaining("walker-uid", "marked complete"));

  console.log("✓ onBookingRequested / onBookingStatusChange tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
