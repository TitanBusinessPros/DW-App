// sendPushToUser/logInAppNotification tests — run directly against the
// Firestore emulator. No Auth or Functions emulator needed: these are
// plain internal helpers, not an exported Cloud Function reachable over
// HTTP, so they're unit-tested by requiring functions/index.js directly
// and calling them through the test-only `exports.__testables` (see that
// export's comment in functions/index.js for why this is safe to ship —
// it never becomes a deployed endpoint).
//
// Every user seeded here either has no fcmTokens or notificationsEnabled:
// false, so sendPushToUser always takes its "in-app only" early-return
// path and never calls the real FCM API — same safe pattern Town-Talk's
// own tests rely on (no real device ever registers an FCM token against
// an emulator, so a test that required a real send could never pass here
// anyway).
//
// functions/ and testing/ each have their own separate node_modules/
// firebase-admin copy, so functions/index.js's own initializeApp() call
// (inside its own copy) does NOT initialize a default app in THIS file's
// copy — same reason run-admin-pin-tests.js does its own explicit
// initializeApp() rather than assuming one exists. Both copies independently
// talking to the same physical emulator (via FIRESTORE_EMULATOR_HOST) is
// exactly how this is supposed to work; they just can't share app state.
const PROJECT_ID = "dw-app-2beee";
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.GCLOUD_PROJECT = PROJECT_ID;

const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { sendPushToUser, logInAppNotification } = require("../../functions/index.js").__testables;

const app = initializeApp({ projectId: PROJECT_ID });
const db = getFirestore(app);

async function notificationsFor(uid) {
  return db.collection("users").doc(uid).collection("notifications").get();
}

async function main() {
  // 1. logInAppNotification writes a real notification doc with the fields passed in.
  {
    await logInAppNotification("alice", { type: "test", title: "Hi", body: "Hello", clickAction: "/x" });
    const snap = await notificationsFor("alice");
    if (snap.size !== 1) throw new Error(`expected 1 notification doc for alice, got ${snap.size}`);
    const doc = snap.docs[0].data();
    if (doc.title !== "Hi" || doc.body !== "Hello" || doc.clickAction !== "/x" || doc.read !== false) {
      throw new Error("notification doc fields don't match what was passed in: " + JSON.stringify(doc));
    }
  }

  // 2. clickAction defaults to "/" when omitted.
  {
    await logInAppNotification("alice", { type: "test", title: "Hi2", body: "Hello2" });
    const snap = await notificationsFor("alice");
    const doc2 = snap.docs.find((d) => d.data().title === "Hi2").data();
    if (doc2.clickAction !== "/") throw new Error(`expected default clickAction "/", got ${doc2.clickAction}`);
  }

  // 3. sendPushToUser with no users/{uid} doc at all: still logs in-app, doesn't throw.
  {
    await sendPushToUser("no-such-user", { type: "test", title: "Hi", body: "Hello" });
    const snap = await notificationsFor("no-such-user");
    if (snap.size !== 1) throw new Error("expected an in-app notification even with no users doc");
  }

  // 4. notificationsEnabled: false — logs in-app, does NOT attempt a real
  // FCM send (which would throw without real credentials if it tried).
  {
    await db.collection("users").doc("bob").set({
      approved: true,
      notificationsEnabled: false,
      fcmTokens: ["fake-token"],
    });
    await sendPushToUser("bob", { type: "test", title: "Hi", body: "Hello" });
    const snap = await notificationsFor("bob");
    if (snap.size !== 1) throw new Error("expected an in-app notification for bob");
  }

  // 5. notificationsEnabled: true but empty fcmTokens — same safe in-app-only path.
  {
    await db.collection("users").doc("carol").set({
      approved: true,
      notificationsEnabled: true,
      fcmTokens: [],
    });
    await sendPushToUser("carol", { type: "test", title: "Hi", body: "Hello" });
    const snap = await notificationsFor("carol");
    if (snap.size !== 1) throw new Error("expected an in-app notification for carol");
  }

  console.log("✓ notification plumbing tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
