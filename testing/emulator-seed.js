// Playwright globalSetup — seeds the Firestore emulator with a town before
// the e2e tests run, using the Admin SDK (bypasses security rules, same as
// production Cloud Functions would). Only ever touches the emulator: it
// points at FIRESTORE_EMULATOR_HOST, never a real project.
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

module.exports = async function globalSetup() {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  // Must match the projectId baked into public/firebase-init.js (dw-app-2beee) —
  // connectFirestoreEmulator() only redirects *where* requests go, not the
  // project namespace they're scoped to within the emulator. A mismatched
  // project id here silently queries a different, empty logical database.
  const app = initializeApp({ projectId: "dw-app-2beee" });
  const db = getFirestore(app);

  await db.collection("towns").doc("pauls-valley").set({
    name: "Pauls Valley",
    county: "Garvin",
    population: 6112,
    walkerCap: 61,
    approvedWalkerCount: 0,
    status: "open",
  });
};
