// onNewSignup / onProfileSubmitted Cloud Function tests — real Firestore
// triggers, so this needs the Auth + Firestore + Functions emulators
// together: Auth to mint real accounts for admins (notifyAdminsOfSignup
// resolves admin email -> uid via getAuth().getUserByEmail(), the
// authoritative source — see functions/index.js for why), Firestore to
// hold the users/{uid} docs whose writes fire the triggers, Functions to
// actually run them.
//
// Every admin's own users/{uid} doc here has no fcmTokens, so
// sendPushToUser always takes its safe in-app-only path — same pattern as
// run-notification-plumbing-tests.js and Town-Talk's own tests. Triggers
// fire asynchronously in the emulator, so assertions poll with a timeout
// rather than checking immediately after a write.
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

async function waitFor(conditionFn, { timeoutMs = 15000, intervalMs = 300 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await conditionFn()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Fixed grace period for a negative assertion ("this should NOT have
// notified") — can't wait-for-absence indefinitely, so this accepts the
// same small residual flakiness risk any such test does, in exchange for
// actually being able to assert a negative at all.
async function settle(ms = 2000) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // --- Setup: two admins with real Auth accounts, one admin email with none ---
  await auth.createUser({ uid: "admin1-uid", email: "admin1@example.com", emailVerified: true });
  await auth.createUser({ uid: "admin2-uid", email: "admin2@example.com", emailVerified: true });
  await db.collection("admins").doc("admin1@example.com").set({});
  await db.collection("admins").doc("admin2@example.com").set({});
  await db.collection("admins").doc("ghost-admin@example.com").set({}); // no Auth account — must not crash the flow
  // Note: these two writes each already carry a real profile.name, so they
  // themselves fire onNewSignup and cross-notify the other admin (proof the
  // logic works before test 1 even runs) — admin1/admin2 never start from a
  // guaranteed-empty inbox, and a fixed delay can't reliably guarantee a
  // trigger has finished by a given wall-clock moment (that's exactly what
  // broke test 1 in CI's slower/differently-timed environment the first time
  // this was written — awaiting a write only guarantees the write, not the
  // trigger it fires), so every test below either polls with waitFor() or
  // measures a before/after delta rather than assuming an absolute count.
  await db.collection("users").doc("admin1-uid").set({ approved: true, profile: { name: "Admin One" } });
  await db.collection("users").doc("admin2-uid").set({ approved: true, profile: { name: "Admin Two" } });
  // Wait for BOTH setup cross-notifications to actually land (not just a
  // fixed delay) before capturing the baseline test 1 compares against.
  await waitFor(async () => (await notificationsRef("admin1-uid").get()).size >= 1);
  await waitFor(async () => (await notificationsRef("admin2-uid").get()).size >= 1);
  const baseline1 = (await notificationsRef("admin1-uid").get()).size;
  const baseline2 = (await notificationsRef("admin2-uid").get()).size;

  // 1. onNewSignup: a users/{uid} doc created WITHOUT a name doesn't notify anyone.
  {
    await db.collection("users").doc("no-name-uid").set({ approved: false, everApproved: false, role: "owner", townId: "x" });
    await settle();
    const snap1 = await notificationsRef("admin1-uid").get();
    const snap2 = await notificationsRef("admin2-uid").get();
    if (snap1.size !== baseline1 || snap2.size !== baseline2) {
      throw new Error(
        `expected no NEW notifications for a nameless signup, went from baseline ${baseline1}/${baseline2} to ${snap1.size}/${snap2.size}`
      );
    }
  }

  // 2. onNewSignup: a users/{uid} doc created WITH a name notifies both real admins.
  {
    await db.collection("users").doc("named-at-creation-uid").set({
      approved: false,
      everApproved: false,
      role: "owner",
      townId: "x",
      profile: { name: "Fresh Frank" },
    });
    const hasFrankNotification = async (uid) => {
      const snap = await notificationsRef(uid).get();
      return snap.docs.some((d) => (d.data().body || "").includes("Fresh Frank"));
    };
    await waitFor(() => hasFrankNotification("admin1-uid"));
    await waitFor(() => hasFrankNotification("admin2-uid"));
  }

  // 3. onProfileSubmitted: a bare doc, then a later update adding the name — notifies.
  {
    await db.collection("users").doc("two-step-uid").set({ approved: false, everApproved: false, role: "walker", townId: "x" });
    await settle(1000); // let onNewSignup run first (no-ops, no name yet) before the update
    await db.collection("users").doc("two-step-uid").update({ profile: { name: "Gradual Gina" } });
    await waitFor(async () => {
      const snap = await notificationsRef("admin1-uid").get();
      return snap.docs.some((d) => (d.data().body || "").includes("Gradual Gina"));
    });
  }

  // 4. onProfileSubmitted: a LATER unrelated update (name unchanged) does not re-notify.
  {
    const before = (await notificationsRef("admin1-uid").get()).size;
    await db.collection("users").doc("two-step-uid").update({ "profile.bio": "I love dogs" });
    await settle();
    const after = (await notificationsRef("admin1-uid").get()).size;
    if (after !== before) throw new Error(`expected no new notification from an unrelated update, went from ${before} to ${after}`);
  }

  // 5. An admin email with no Auth account yet doesn't crash the whole notify
  // flow — the other real admins still get notified normally.
  {
    const before1 = (await notificationsRef("admin1-uid").get()).size;
    const before2 = (await notificationsRef("admin2-uid").get()).size;
    await db.collection("users").doc("another-signup-uid").set({
      approved: false,
      everApproved: false,
      role: "owner",
      townId: "x",
      profile: { name: "Another Amy" },
    });
    await waitFor(async () => (await notificationsRef("admin1-uid").get()).size > before1);
    await waitFor(async () => (await notificationsRef("admin2-uid").get()).size > before2);
  }

  // 6. An admin's OWN profile submission doesn't self-notify, but the OTHER
  // real admin still gets notified about it.
  {
    const before2 = (await notificationsRef("admin2-uid").get()).size;
    await db.collection("users").doc("admin1-uid").set({
      approved: true,
      profile: { name: "" }, // clear it first so the next update is a genuine "first real name appears"
    });
    await settle(500);
    await db.collection("users").doc("admin1-uid").update({ profile: { name: "Admin One Reborn" } });
    await waitFor(async () => (await notificationsRef("admin2-uid").get()).size > before2);
    await settle(1500); // grace period for the negative half of this assertion
    const admin1Snap = await notificationsRef("admin1-uid").get();
    const selfNotified = admin1Snap.docs.some((d) => (d.data().body || "").includes("Admin One Reborn"));
    if (selfNotified) throw new Error("admin1 should not have been notified about their own signup");
  }

  console.log("✓ onNewSignup / onProfileSubmitted tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
