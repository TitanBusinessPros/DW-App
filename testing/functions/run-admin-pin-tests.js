// verifyAdminPin Cloud Function tests — run against the Auth/Firestore/
// Functions emulators together (needs a real ID token, which only Auth
// can mint, and a real admins/{email} doc, which only Firestore can hold).
//
// Uses a local-only test PIN from functions/.secret.local (gitignored,
// never the real production ADMIN_PIN) — see functions/.secret.local and
// the "Still needed from you" note in docs/ARCHITECTURE.md for how the
// real one gets set in production.
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT_ID = "dw-app-2beee";
const TEST_PIN = "00000000-local-test-only"; // must match functions/.secret.local
const FUNCTIONS_URL = `http://127.0.0.1:5001/${PROJECT_ID}/us-central1/verifyAdminPin`;

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

const app = initializeApp({ projectId: PROJECT_ID });
const auth = getAuth(app);
const db = getFirestore(app);

async function getIdToken(uid, email) {
  await auth.createUser({ uid, email, emailVerified: true }).catch(() => {});
  const customToken = await auth.createCustomToken(uid);
  const res = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error("Failed to mint an ID token: " + JSON.stringify(data));
  return data.idToken;
}

async function callFn(idToken, pin) {
  const res = await fetch(FUNCTIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ data: { pin } }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  await db.collection("admins").doc("admin@example.com").set({});

  // 1. No auth at all.
  {
    const { status } = await callFn(null, TEST_PIN);
    if (status === 200) throw new Error("expected failure calling with no auth");
  }

  // 2. Signed in, but not on the admins allowlist.
  {
    const token = await getIdToken("rando-uid", "rando@example.com");
    const { status } = await callFn(token, TEST_PIN);
    if (status === 200) throw new Error("expected failure for a non-admin email");
  }

  // 3. Admin email, wrong PIN.
  {
    const token = await getIdToken("admin-uid", "admin@example.com");
    const { status } = await callFn(token, "not-the-pin");
    if (status === 200) throw new Error("expected failure for the wrong PIN");
  }

  // 4. Admin email, correct PIN.
  {
    const token = await getIdToken("admin-uid", "admin@example.com");
    const { status, body } = await callFn(token, TEST_PIN);
    if (status !== 200 || !body.result || body.result.ok !== true) {
      throw new Error("expected success for the correct PIN, got: " + JSON.stringify(body));
    }
  }

  // 5. Lockout: 5 wrong attempts from a fresh uid locks it out, and even
  // the CORRECT PIN is then rejected until the lockout window passes.
  {
    const token = await getIdToken("lockout-uid", "lockout-admin@example.com");
    await db.collection("admins").doc("lockout-admin@example.com").set({});

    for (let i = 0; i < 5; i++) {
      const { status } = await callFn(token, "wrong-pin-" + i);
      if (status === 200) throw new Error(`expected attempt ${i + 1} (wrong PIN) to fail`);
    }

    const { status, body } = await callFn(token, TEST_PIN); // correct PIN, but locked out
    if (status === 200) {
      throw new Error("expected the 6th attempt to be locked out even with the correct PIN");
    }
    if (!body.error || !/too many attempts/i.test(body.error.message || "")) {
      throw new Error("expected a lockout error message, got: " + JSON.stringify(body));
    }
  }

  console.log("✓ verifyAdminPin tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
