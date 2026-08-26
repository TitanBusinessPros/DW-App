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

    console.log("✓ firestore.rules tests passed");
  } finally {
    await testEnv.cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
