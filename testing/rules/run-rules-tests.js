// Firestore security rules unit tests — run against the Firestore emulator.
// Expand alongside firestore.rules as new collections/branches are added.
const fs = require("node:fs");
const path = require("node:path");
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require("@firebase/rules-unit-testing");

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
          .set({ senderId: "amy", text: "hi" })
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
          .set({ senderId: "amy", text: "should be blocked" })
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
          .set({ senderId: "zoe", text: "should also be blocked" })
      );
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
