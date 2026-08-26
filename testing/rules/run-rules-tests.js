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

  // Seed a town, bypassing rules — this is data setup, not something
  // exercised by rules themselves (that's covered by the towns/{townId}
  // read/write tests below).
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await context
      .firestore()
      .collection("towns")
      .doc("pauls-valley")
      .set({ name: "Pauls Valley", walkerCap: 50, approvedWalkerCount: 0 });
  });

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

    // A random signed-in user can't write to towns — admin-only.
    {
      const db = testEnv.authenticatedContext("alice").firestore();
      await assertFails(
        db.collection("towns").doc("new-town").set({ name: "New Town", walkerCap: 10 })
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

    console.log("✓ firestore.rules tests passed");
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
