// Firestore security rules unit tests — run against the Firestore emulator.
// Expand alongside firestore.rules as new collections/branches are added.
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");
const { serverTimestamp } = require("firebase/firestore");

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: "dog-walker-rules-test",
    firestore: {
      rules: fs.readFileSync(
        path.resolve(__dirname, "../../firestore.rules"),
        "utf8"
      ),
    },
  });

  // Seed a town, bypassing rules — this represents a town that already
  // has a walker-cap counter doc (i.e. someone already signed up from it),
  // as opposed to the "brand new town" self-registration tested below.
  // Also seed an admin allowlist entry, keyed by email (see firestore.rules).
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context
      .firestore()
      .collection("towns")
      .doc("pauls-valley")
      .set({
        name: "Pauls Valley",
        county: "Garvin",
        population: 6112,
        walkerCap: 61,
        approvedWalkerCount: 0,
        status: "open",
      });
    await context.firestore().collection("admins").doc("admin@example.com").set({});
  });

  const adminDb = testEnv
    .authenticatedContext("admin-uid", { email: "admin@example.com", email_verified: true })
    .firestore();

  try {
    // An unapproved, unauthenticated client can't read anyone's profile.
    {
      const db = testEnv.unauthenticatedContext().firestore();
      await assertFails(db.collection("users").doc("someone").get());
    }

    // Anyone — even signed out — can read the town list (needed on the
    // signup page before an account exists).
    {
      const db = testEnv.unauthenticatedContext().firestore();
      await assertSucceeds(db.collection("towns").doc("pauls-valley").get());
    }

    // Any signed-in user can self-register a BRAND NEW town doc with a
    // well-formed, fresh counter — this is how the signup page bootstraps
    // a town the first time someone from it signs up (see public/signup.html).
    {
      const db = testEnv.authenticatedContext("alice").firestore();
      await assertSucceeds(
        db.collection("towns").doc("new-town").set({
          name: "New Town",
          county: "Some County",
          population: 1000,
          walkerCap: 10,
          approvedWalkerCount: 0,
          status: "open",
        })
      );
    }

    // ...but they can't create it with a nonzero counter, a wrong-shaped
    // field, or an extra field — only a fresh, correct counter is allowed.
    {
      const db = testEnv.authenticatedContext("alice").firestore();
      await assertFails(
        db.collection("towns").doc("cheater-town").set({
          name: "Cheater Town",
          county: "Some County",
          population: 1000,
          walkerCap: 10,
          approvedWalkerCount: 5, // not allowed — must start at 0
          status: "open",
        })
      );
    }

    // ...and they can't overwrite/edit a town that already exists —
    // admin/Cloud-Functions-only from that point on.
    {
      const db = testEnv.authenticatedContext("alice").firestore();
      await assertFails(
        db.collection("towns").doc("pauls-valley").set({
          name: "Pauls Valley",
          county: "Garvin",
          population: 6112,
          walkerCap: 9999, // trying to inflate the cap
          approvedWalkerCount: 0,
          status: "open",
        })
      );
    }

    // A signed-in user can create their own (not-yet-approved) profile,
    // referencing a real town.
    {
      const db = testEnv.authenticatedContext("alice").firestore();
      await assertSucceeds(
        db.collection("users").doc("alice").set({
          approved: false,
          everApproved: false,
          role: "owner",
          townId: "pauls-valley",
        })
      );
    }

    // ...but not someone else's.
    {
      const db = testEnv.authenticatedContext("alice").firestore();
      await assertFails(
        db.collection("users").doc("bob").set({
          approved: false,
          everApproved: false,
          role: "owner",
          townId: "pauls-valley",
        })
      );
    }

    // A profile can't reference a town that doesn't exist — this is the
    // actual mechanism that keeps the app Oklahoma-only (see docs/ARCHITECTURE.md).
    {
      const db = testEnv.authenticatedContext("carol").firestore();
      await assertFails(
        db.collection("users").doc("carol").set({
          approved: false,
          everApproved: false,
          role: "owner",
          townId: "some-town-in-texas",
        })
      );
    }

    // An invalid role is rejected too.
    {
      const db = testEnv.authenticatedContext("dave").firestore();
      await assertFails(
        db.collection("users").doc("dave").set({
          approved: false,
          everApproved: false,
          role: "admin", // not a real role
          townId: "pauls-valley",
        })
      );
    }

    // Admin allowlist is keyed by email, not uid — a signed-in user can
    // read their OWN admin doc (used to decide whether to show the admin
    // portal link) but not anyone else's, and can never write to it at all.
    {
      const db = testEnv
        .authenticatedContext("admin-uid", { email: "admin@example.com", email_verified: true })
        .firestore();
      await assertSucceeds(db.collection("admins").doc("admin@example.com").get());
      await assertFails(db.collection("admins").doc("someone-else@example.com").get());
      await assertFails(db.collection("admins").doc("admin@example.com").set({ extra: true }));
    }

    // A real admin (email on the allowlist) CAN update an existing town —
    // e.g. raising a cap — where a random signed-in user can't (tested above).
    {
      await assertSucceeds(
        adminDb.collection("towns").doc("pauls-valley").update({ walkerCap: 100 })
      );
    }

    // ...and can approve a pending user, which a regular signed-in user
    // (even the user themselves) can't do directly.
    {
      const db = testEnv.authenticatedContext("erin").firestore();
      await assertSucceeds(
        db.collection("users").doc("erin").set({
          approved: false,
          everApproved: false,
          role: "owner",
          townId: "pauls-valley",
        })
      );
      await assertFails(
        db.collection("users").doc("erin").update({ approved: true, everApproved: true })
      );
      await assertSucceeds(
        adminDb.collection("users").doc("erin").update({ approved: true, everApproved: true })
      );
    }

    // --- conversations/messages + blocks -----------------------------------
    // Seed two approved pairs directly (bypassing rules — only `approved`
    // matters for isApproved()). One pair is named so ownerUid < walkerUid
    // (conversationId already matches the sorted blocks pairId "by luck"),
    // the other so ownerUid > walkerUid (conversationId does NOT match the
    // sorted pairId) — this second case is what the exists(blocks/$(conversationId))
    // bug missed, and what isBlockedPair() must catch instead.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      for (const uid of ["amy", "bob", "zoe", "adam"]) {
        await db.collection("users").doc(uid).set({ approved: true, everApproved: true });
      }
    });

    // Sanity: an unblocked, approved pair can message each other.
    {
      const db = testEnv.authenticatedContext("amy").firestore();
      await assertSucceeds(
        db
          .collection("conversations")
          .doc("amy_bob")
          .collection("messages")
          .doc("m1")
          .set({ senderId: "amy", text: "hi", sentAt: serverTimestamp() })
      );
    }

    // sentAt must be the real server timestamp — not omitted, and not a
    // client-forged value — since onFirstMessageNotify orders by this field
    // to find the chronologically-first message race-proof; a spoofable
    // value would break that guarantee.
    {
      const db = testEnv.authenticatedContext("amy").firestore();
      await assertFails(
        db
          .collection("conversations")
          .doc("amy_bob")
          .collection("messages")
          .doc("m1-no-sentat")
          .set({ senderId: "amy", text: "missing sentAt" })
      );
      await assertFails(
        db
          .collection("conversations")
          .doc("amy_bob")
          .collection("messages")
          .doc("m1-forged-sentat")
          .set({ senderId: "amy", text: "forged sentAt", sentAt: new Date("2020-01-01") })
      );
    }

    // Blocked pair where conversationId ("amy_bob") already equals the sorted
    // pairId ("amy_bob") — this direction passed even with the old buggy check.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().collection("blocks").doc("amy_bob").set({});
    });
    {
      const db = testEnv.authenticatedContext("amy").firestore();
      await assertFails(
        db
          .collection("conversations")
          .doc("amy_bob")
          .collection("messages")
          .doc("m2")
          .set({ senderId: "amy", text: "should be blocked", sentAt: serverTimestamp() })
      );
    }

    // Blocked pair where conversationId ("zoe_adam") does NOT equal the sorted
    // pairId ("adam_zoe") — this is the case the old exists(blocks/$(conversationId))
    // check missed entirely, since it checked "zoe_adam" and found nothing.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context.firestore().collection("blocks").doc("adam_zoe").set({});
    });
    {
      const db = testEnv.authenticatedContext("zoe").firestore();
      await assertFails(
        db
          .collection("conversations")
          .doc("zoe_adam")
          .collection("messages")
          .doc("m3")
          .set({ senderId: "zoe", text: "should also be blocked", sentAt: serverTimestamp() })
      );
    }

    // --- walkerProfiles/{uid} -----------------------------------------------
    {
      const db = testEnv.authenticatedContext("frank").firestore();
      await assertSucceeds(
        db.collection("walkerProfiles").doc("frank").set({ approved: false, everApproved: false })
      );
      // Can't create a listing profile for someone else.
      await assertFails(
        db.collection("walkerProfiles").doc("someone-else").set({ approved: false, everApproved: false })
      );
    }

    // --- dogs/{dogId} --------------------------------------------------------
    {
      const db = testEnv.authenticatedContext("frank").firestore();
      await assertSucceeds(db.collection("dogs").doc("dog1").set({ ownerId: "frank" }));
      // Can't claim a dog under someone else's ownerId.
      await assertFails(db.collection("dogs").doc("dog2").set({ ownerId: "not-frank" }));

      // Private to the owner + admin only — NOT any approved user (breed/
      // photo data being broadly readable is a real theft-targeting risk).
      await assertSucceeds(db.collection("dogs").doc("dog1").get()); // frank reads his own dog
      await assertSucceeds(adminDb.collection("dogs").doc("dog1").get()); // admin can read any dog
      // amy is a different, approved user — still can't read frank's dog.
      const amyDb = testEnv.authenticatedContext("amy").firestore();
      await assertFails(amyDb.collection("dogs").doc("dog1").get());
    }

    // --- bookings/{bookingId} -------------------------------------------------
    {
      // Uses "henry" as the walker, not "bob" — amy/bob were already blocked
      // in the messages tests above, and that block persists for the rest of
      // this run, which would make an amy/bob booking fail for the wrong reason.
      const db = testEnv.authenticatedContext("amy").firestore();
      await assertSucceeds(
        db.collection("bookings").doc("b1").set({ ownerId: "amy", walkerId: "henry", status: "requested" })
      );
      // ownerId must match the requester — can't file a booking as someone else.
      await assertFails(
        db.collection("bookings").doc("b2").set({ ownerId: "someone-else", walkerId: "henry", status: "requested" })
      );
    }
    // A blocked pair (zoe/adam, blocked above) can't create a booking either —
    // isBlockedPair() gates bookings the same way it now gates messages.
    {
      const db = testEnv.authenticatedContext("zoe").firestore();
      await assertFails(
        db.collection("bookings").doc("b3").set({ ownerId: "zoe", walkerId: "adam", status: "requested" })
      );
    }

    // --- bookings/{bookingId} status transitions ------------------------------
    {
      const amyDb = testEnv.authenticatedContext("amy").firestore();
      const henryDb = testEnv.authenticatedContext("henry").firestore();

      // Only the WALKER can accept/decline a request — not the owner.
      await amyDb.collection("bookings").doc("b4").set({ ownerId: "amy", walkerId: "henry", status: "requested" });
      await assertFails(amyDb.collection("bookings").doc("b4").update({ status: "accepted" }));
      await assertSucceeds(henryDb.collection("bookings").doc("b4").update({ status: "accepted" }));

      await amyDb.collection("bookings").doc("b5").set({ ownerId: "amy", walkerId: "henry", status: "requested" });
      await assertSucceeds(henryDb.collection("bookings").doc("b5").update({ status: "declined" }));

      // Can't skip straight from requested to completed.
      await amyDb.collection("bookings").doc("b6").set({ ownerId: "amy", walkerId: "henry", status: "requested" });
      await assertFails(henryDb.collection("bookings").doc("b6").update({ status: "completed" }));

      // Either party can cancel an accepted booking.
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection("bookings").doc("b7").set({ ownerId: "amy", walkerId: "henry", status: "accepted" });
      });
      await assertSucceeds(amyDb.collection("bookings").doc("b7").update({ status: "cancelled" }));

      // Terminal states don't move — a declined booking can't be revived.
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection("bookings").doc("b8").set({ ownerId: "amy", walkerId: "henry", status: "declined" });
      });
      await assertFails(henryDb.collection("bookings").doc("b8").update({ status: "accepted" }));

      // Either party can mark an accepted booking complete.
      await testEnv.withSecurityRulesDisabled(async (context) => {
        await context.firestore().collection("bookings").doc("b9").set({ ownerId: "amy", walkerId: "henry", status: "accepted" });
      });
      await assertSucceeds(henryDb.collection("bookings").doc("b9").update({ status: "completed" }));
    }

    // --- reviews/{reviewId} ----------------------------------------------------
    {
      const db = testEnv.authenticatedContext("amy").firestore();
      await assertSucceeds(db.collection("reviews").doc("r1").set({ reviewerId: "amy", rating: 5 }));
      // Rating must be 1-5.
      await assertFails(db.collection("reviews").doc("r2").set({ reviewerId: "amy", rating: 6 }));
    }

    // --- reports/{reportId} ------------------------------------------------------
    {
      const db = testEnv.authenticatedContext("amy").firestore();
      await assertSucceeds(db.collection("reports").doc("rep1").set({ reporterId: "amy" }));
      // Reports are admin-read-only — even the reporter can't read it back.
      await assertFails(db.collection("reports").doc("rep1").get());
      await assertSucceeds(adminDb.collection("reports").doc("rep1").get());
    }

    // --- bugReports/{reportId} -----------------------------------------------------
    {
      const db = testEnv.authenticatedContext("amy").firestore();
      await assertSucceeds(db.collection("bugReports").doc("br1").set({ reporterId: "amy" }));
      // Can't file a bug report under someone else's reporterId.
      await assertFails(db.collection("bugReports").doc("br2").set({ reporterId: "someone-else" }));
    }

    // --- messageLimits/{uid} / bookingLimits/{uid} ----------------------------------
    // Both are written only by Cloud Functions (Admin SDK bypasses rules) —
    // the owner can read their own counter but never write it directly.
    for (const collectionName of ["messageLimits", "bookingLimits"]) {
      const db = testEnv.authenticatedContext("amy").firestore();
      await assertSucceeds(db.collection(collectionName).doc("amy").get());
      await assertFails(db.collection(collectionName).doc("amy").set({ count: 0 }));
    }

    // --- users/{uid}/notifications/{notifId} ----------------------------------------
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await context
        .firestore()
        .collection("users")
        .doc("frank")
        .collection("notifications")
        .doc("n1")
        .set({ type: "test", title: "Hi", read: false });
    });
    {
      const frankDb = testEnv.authenticatedContext("frank").firestore();
      const bobDb = testEnv.authenticatedContext("bob").firestore();

      await assertSucceeds(frankDb.collection("users").doc("frank").collection("notifications").doc("n1").get());
      // Someone else can't read frank's notifications.
      await assertFails(bobDb.collection("users").doc("frank").collection("notifications").doc("n1").get());

      // Frank can mark his own notification read...
      await assertSucceeds(
        frankDb.collection("users").doc("frank").collection("notifications").doc("n1").update({ read: true })
      );
      // ...but can't change anything else about it.
      await assertFails(
        frankDb.collection("users").doc("frank").collection("notifications").doc("n1").update({ title: "changed" })
      );
      // Nobody creates or deletes one directly — Cloud-Function-only.
      await assertFails(
        frankDb.collection("users").doc("frank").collection("notifications").doc("n2").set({ type: "x", title: "x", read: false })
      );
      await assertFails(frankDb.collection("users").doc("frank").collection("notifications").doc("n1").delete());
    }

    console.log("✓ firestore.rules tests passed");
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
