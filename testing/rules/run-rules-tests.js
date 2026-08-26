// Firestore security rules unit tests — run against the Firestore emulator.
// Expand alongside firestore.rules as new collections/branches are added.
const assert = require("node:assert/strict");
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

  try {
    // An unapproved, unauthenticated client can't read anyone's profile.
    {
      const db = testEnv.unauthenticatedContext().firestore();
      await assertFails(db.collection("users").doc("someone").get());
    }

    // A signed-in user can create their own (not-yet-approved) profile.
    {
      const db = testEnv.authenticatedContext("alice").firestore();
      await assertSucceeds(
        db.collection("users").doc("alice").set({
          approved: false,
          everApproved: false,
          role: "owner",
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
