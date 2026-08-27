// verifyAdminPin Cloud Function tests — run against the Auth/Firestore/
// Functions emulators together (needs a real ID token, which only Auth
// can mint, and a real admins/{email} doc, which only Firestore can hold).
//
// verifyAdminPin is a plain HTTPS function (onRequest), not a Firebase
// callable — see functions/index.js for why (invoker: "public" only
// works on onRequest in this SDK version). So this hits it with a plain
// fetch + manual Authorization header, and checks real HTTP status codes
// + a plain {error} JSON body, not the callable {data}/{result} protocol.
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
    body: JSON.stringify({ pin }),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  await db.collection("admins").doc("admin@example.com").set({});

  // 0. The whole point: a fresh, no-auth OPTIONS preflight must not be
  // rejected at the infrastructure/IAM layer (a raw, non-JSON 403 from
  // Google's frontend, not our code) — this is exactly the production
  // bug this rewrite fixes.
  {
    const res = await fetch(FUNCTIONS_URL, { method: "OPTIONS" });
    if (res.status !== 204) {
      throw new Error(`expected OPTIONS preflight to get 204 from our own CORS handling, got ${res.status}`);
    }
  }

  // 1. No auth at all.
  {
    const { status } = await callFn(null, TEST_PIN);
    if (status !== 401) throw new Error(`expected 401 with no auth, got ${status}`);
  }

  // 2. Signed in, but not on the admins allowlist.
  {
    const token = await getIdToken("rando-uid", "rando@example.com");
    const { status } = await callFn(token, TEST_PIN);
    if (status !== 403) throw new Error(`expected 403 for a non-admin email, got ${status}`);
  }

  // 3. Admin email, wrong PIN.
  {
    const token = await getIdToken("admin-uid", "admin@example.com");
    const { status } = await callFn(token, "not-the-pin");
    if (status !== 403) throw new Error(`expected 403 for the wrong PIN, got ${status}`);
  }

  // 4. Admin email, correct PIN.
  {
    const token = await getIdToken("admin-uid", "admin@example.com");
    const { status, body } = await callFn(token, TEST_PIN);
    if (status !== 200 || body.ok !== true) {
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
      if (status !== 403) throw new Error(`expected attempt ${i + 1} (wrong PIN) to be 403, got ${status}`);
    }

    const { status, body } = await callFn(token, TEST_PIN); // correct PIN, but locked out
    if (status !== 429) {
      throw new Error(`expected the 6th attempt to be locked out (429) even with the correct PIN, got ${status}`);
    }
    if (!/too many attempts/i.test(body.error || "")) {
      throw new Error("expected a lockout error message, got: " + JSON.stringify(body));
    }
  }

  console.log("✓ verifyAdminPin tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
