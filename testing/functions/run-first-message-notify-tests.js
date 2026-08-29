// onFirstMessageNotify Cloud Function tests — real Firestore trigger, so
// this needs Auth + Firestore + Functions emulators together (Auth so the
// notification is checked against a real users/{uid} doc the same way
// sendPushToUser reads it).
//
// Every user here has no fcmTokens, so sendPushToUser always takes its
// safe in-app-only path — same pattern as every other function test in
// this suite. Triggers fire asynchronously, so assertions poll with a
// timeout rather than checking immediately after a write.
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

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

async function addMessage(conversationId, messageId, senderId, text) {
  await db
    .collection("conversations")
    .doc(conversationId)
    .collection("messages")
    .doc(messageId)
    .set({ senderId, text, sentAt: FieldValue.serverTimestamp() });
}

async function main() {
  // No admins needed here — this notifies the OTHER conversation
  // participant directly, not admins.
  await auth.createUser({ uid: "owner-uid", email: "owner@example.com", emailVerified: true });
  await auth.createUser({ uid: "walker-uid", email: "walker@example.com", emailVerified: true });
  await db.collection("users").doc("owner-uid").set({ approved: true, profile: { name: "Olivia Owner" } });
  await db.collection("users").doc("walker-uid").set({ approved: true, profile: { name: "Wendy Walker" } });
  // Let the two onNewSignup firings from the seeds above settle before
  // any test starts polling — there's no admin to receive them, but
  // giving them a moment avoids any incidental overlap with test timing.
  await settle(1500);

  await db.collection("conversations").doc("owner-uid_walker-uid").set({
    participants: ["owner-uid", "walker-uid"],
  });

  // 1. The FIRST message in a conversation notifies the OTHER participant,
  // naming the real sender (looked up via users/{uid}, not trusted from
  // the client).
  {
    await addMessage("owner-uid_walker-uid", "msg1", "owner-uid", "Hi, are you free Tuesday?");
    await waitFor(async () => {
      const snap = await notificationsRef("walker-uid").get();
      return snap.docs.some((d) => (d.data().body || "").includes("Olivia Owner"));
    });
    // The SENDER doesn't get a copy of their own "first message" notification.
    const senderSnap = await notificationsRef("owner-uid").get();
    if (senderSnap.docs.some((d) => (d.data().type || "") === "message")) {
      throw new Error("sender should not be notified about their own first message");
    }
  }

  // 2. A SECOND message in the SAME conversation does NOT re-notify —
  // only the first message in a conversation triggers this.
  {
    const before = (await notificationsRef("walker-uid").get()).size;
    await addMessage("owner-uid_walker-uid", "msg2", "owner-uid", "Following up on that...");
    await settle();
    const after = (await notificationsRef("walker-uid").get()).size;
    if (after !== before) throw new Error(`expected no new notification for a 2nd message, went from ${before} to ${after}`);
  }

  // 3. A reply INTO the same conversation (from the other participant) also
  // does not re-notify — "first message in the conversation" already
  // happened in test 1, regardless of who sends next.
  {
    const before = (await notificationsRef("owner-uid").get()).size;
    await addMessage("owner-uid_walker-uid", "msg3", "walker-uid", "Yes, Tuesday works!");
    await settle();
    const after = (await notificationsRef("owner-uid").get()).size;
    if (after !== before) {
      throw new Error(`expected no new notification for a reply into an already-started conversation, went from ${before} to ${after}`);
    }
  }

  // 4. A DIFFERENT, brand-new conversation's first message DOES notify —
  // confirms "first message" is scoped per-conversation, not global.
  {
    await auth.createUser({ uid: "walker2-uid", email: "walker2@example.com", emailVerified: true });
    await db.collection("users").doc("walker2-uid").set({ approved: true, profile: { name: "Wade Walker Two" } });
    await settle(1000); // let that seed's own onNewSignup settle first
    await db.collection("conversations").doc("owner-uid_walker2-uid").set({
      participants: ["owner-uid", "walker2-uid"],
    });
    await addMessage("owner-uid_walker2-uid", "msg1", "owner-uid", "Hi, different conversation");
    await waitFor(async () => {
      const snap = await notificationsRef("walker2-uid").get();
      return snap.docs.some((d) => (d.data().body || "").includes("Olivia Owner"));
    });
  }

  console.log("✓ onFirstMessageNotify tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
