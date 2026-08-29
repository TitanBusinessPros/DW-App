// Playwright globalSetup — seeds the Firestore/Auth emulators before the
// e2e tests run, using the Admin SDK (bypasses security rules, same as
// production Cloud Functions would). Only ever touches the emulator: it
// points at FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST, never a
// real project.
//
// Also mints custom-auth-tokens for an allowlisted-admin test user and a
// regular (complete-profile) test user, and writes them to
// .auth-tokens.json (gitignored, regenerated every run) — tests/admin.spec.js
// and tests/signup-login.spec.js use these to simulate being signed in as
// each, via signInWithCustomToken, since there's no way to automate a real
// Google OAuth popup in CI. A "brand-new signup, no profile yet" fixture is
// NOT seeded here — signup-login.spec.js mints its own fresh one per test
// instead, since the emulator persists real writes across tests within a
// run and a shared "fresh" fixture would stop being fresh after the first
// test that actually completes its profile.
const fs = require("node:fs");
const path = require("node:path");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

const PROJECT_ID = "dw-app-2beee"; // must match public/firebase-init.js — see note above
const ADMIN_UID = "admin-test-uid";
const ADMIN_EMAIL = "admin-test@example.com";
const NONADMIN_UID = "nonadmin-test-uid";
const NONADMIN_EMAIL = "nonadmin-test@example.com";
const PENDING_UID = "pending-test-uid";
const APPROVED_WALKER_UID = "approved-walker-test-uid";
const APPROVED_WALKER_EMAIL = "approved-walker-test@example.com";
const OTHER_TOWN_WALKER_UID = "other-town-walker-test-uid";
const OTHER_TOWN_WALKER_EMAIL = "other-town-walker-test@example.com";

module.exports = async function globalSetup() {
  process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
  process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

  const app = initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore(app);
  const auth = getAuth(app);

  await db.collection("towns").doc("pauls-valley").set({
    name: "Pauls Valley",
    county: "Garvin",
    population: 6112,
    walkerCap: 61,
    approvedWalkerCount: 0,
    status: "open",
  });
  // A second town, only for browse.spec.js's town-scoping test.
  await db.collection("towns").doc("wynnewood").set({
    name: "Wynnewood",
    county: "Garvin",
    population: 2166,
    walkerCap: 22,
    approvedWalkerCount: 1,
    status: "open",
  });

  // The admin allowlist entry the "admin" test user needs to pass isAdmin().
  await db.collection("admins").doc(ADMIN_EMAIL).set({ note: "admin" });

  // A pending user for the admin.spec.js "approve" test to act on. Nested
  // profile.name, not a flat displayName — matches firestore.rules' update
  // rule (profile is the self-service field) and the onNewSignup/
  // onProfileSubmitted Cloud Functions, which both read profile?.name.
  await db.collection("users").doc(PENDING_UID).set({
    profile: { name: "Pending Test User" },
    role: "owner",
    townId: "pauls-valley",
    approved: false,
    everApproved: false,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });

  await auth.createUser({ uid: ADMIN_UID, email: ADMIN_EMAIL, emailVerified: true }).catch(() => {});
  await auth.createUser({ uid: NONADMIN_UID, email: NONADMIN_EMAIL, emailVerified: true }).catch(() => {});
  // A real, COMPLETE profile — deliberately, so admin.spec.js's use of this
  // as "just some regular signed-in user" doesn't accidentally also depend
  // on dashboard.html's separate "no profile yet" redirect behavior. That
  // edge case is covered by signup-login.spec.js's own freshly-minted
  // "no profile yet" users instead (see that file).
  await db.collection("users").doc(NONADMIN_UID).set({
    profile: { name: "Nonadmin Test User" },
    role: "owner",
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  // An approved walker with a real, approved listing in Pauls Valley — for
  // browse.spec.js, which only ever READS these two fixtures, never
  // mutates them, so sharing them across multiple tests is safe (unlike
  // the "fresh signup"/"fresh walker" fixtures elsewhere, which get
  // minted per-test specifically because they DO get mutated).
  await auth.createUser({ uid: APPROVED_WALKER_UID, email: APPROVED_WALKER_EMAIL, emailVerified: true }).catch(() => {});
  await db.collection("users").doc(APPROVED_WALKER_UID).set({
    profile: { name: "Wendy Walker" },
    role: "walker",
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  await db.collection("walkerProfiles").doc(APPROVED_WALKER_UID).set({
    approved: true,
    everApproved: true,
    townId: "pauls-valley",
    bio: "I've been walking dogs in Pauls Valley for 3 years.",
    hourlyRate: 20,
    serviceRadius: 5,
    availability: "Weekday mornings, weekends",
  });

  // Same shape, but in Wynnewood — browse.spec.js asserts this one does
  // NOT show up when browsing from Pauls Valley (town-scoping).
  await auth.createUser({ uid: OTHER_TOWN_WALKER_UID, email: OTHER_TOWN_WALKER_EMAIL, emailVerified: true }).catch(() => {});
  await db.collection("users").doc(OTHER_TOWN_WALKER_UID).set({
    profile: { name: "Wyatt Wynnewood" },
    role: "walker",
    townId: "wynnewood",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  await db.collection("walkerProfiles").doc(OTHER_TOWN_WALKER_UID).set({
    approved: true,
    everApproved: true,
    townId: "wynnewood",
    bio: "Wynnewood's own dog walker.",
    hourlyRate: 18,
    serviceRadius: 8,
    availability: "Flexible",
  });

  const adminToken = await auth.createCustomToken(ADMIN_UID);
  const nonAdminToken = await auth.createCustomToken(NONADMIN_UID);

  fs.writeFileSync(
    path.join(__dirname, ".auth-tokens.json"),
    JSON.stringify({ adminToken, nonAdminToken, pendingUid: PENDING_UID }, null, 2)
  );
};
