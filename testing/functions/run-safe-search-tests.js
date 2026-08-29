// checkImageSafeSearch Cloud Function tests — real Storage trigger, so
// this needs Storage + Firestore + Functions + Auth emulators together
// (Auth so notifyAllAdmins can resolve the admin's email -> uid, same as
// run-signup-notify-tests.js).
//
// DOG_WALKER_VISION_TEST_MODE=1 (set by the CI step / see below) makes the
// function use a deterministic fake SafeSearch result instead of calling
// the real, paid, network-dependent Vision API — see that env var's
// comment in functions/index.js. The fake result is driven by whether the
// uploaded file's NAME contains "UNSAFE_TEST_TRIGGER", so this test
// controls the outcome just by choosing what to name each upload.
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
process.env.FIREBASE_STORAGE_EMULATOR_HOST = "127.0.0.1:9199";
process.env.DOG_WALKER_VISION_TEST_MODE = "1";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

const PROJECT_ID = "dw-app-2beee";
// Matches the real bucket in public/firebase-init.js — Firebase's default
// bucket naming changed at some point (older projects: *.appspot.com),
// and this project uses the newer *.firebasestorage.app domain.
const BUCKET = `${PROJECT_ID}.firebasestorage.app`;
const app = initializeApp({ projectId: PROJECT_ID, storageBucket: BUCKET });
const auth = getAuth(app);
const db = getFirestore(app);
const bucket = getStorage(app).bucket();

// Tiny 1x1 PNG — content doesn't matter since DOG_WALKER_VISION_TEST_MODE
// never actually decodes it, but it needs to be non-empty, real bytes.
const FAKE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

async function upload(path, { contentType = "image/png" } = {}) {
  await bucket.file(path).save(FAKE_PNG, { contentType });
}

async function waitFor(conditionFn, { timeoutMs = 30000, intervalMs = 300 } = {}) {
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

async function main() {
  // --- Setup: one real admin (for the flagged-upload notification check) ---
  await auth.createUser({ uid: "admin1-uid", email: "admin1@example.com", emailVerified: true });
  await db.collection("admins").doc("admin1@example.com").set({});
  await db.collection("users").doc("admin1-uid").set({ approved: true, profile: { name: "Admin One" } });

  // 1. A SAFE image upload to users/{uid} does not touch the profile doc.
  {
    await db.collection("users").doc("safe-user-uid").set({ approved: true, profile: { name: "Safe Sam" } });
    await upload("users/safe-user-uid/photo.png");
    await settle(2000);
    const doc = (await db.collection("users").doc("safe-user-uid").get()).data();
    if (doc.approved !== true || doc.safeSearchFlag) {
      throw new Error(`expected a safe upload to leave the profile untouched, got: ${JSON.stringify(doc)}`);
    }
  }

  // 2. An UNSAFE image upload to users/{uid} flags the profile and notifies admins.
  {
    await db.collection("users").doc("flagged-user-uid").set({ approved: true, profile: { name: "Flagged Fred" } });
    await upload("users/flagged-user-uid/UNSAFE_TEST_TRIGGER.png");
    await waitFor(async () => {
      const doc = (await db.collection("users").doc("flagged-user-uid").get()).data();
      return doc.approved === false && doc.safeSearchFlag?.flagged === true;
    });
    const doc = (await db.collection("users").doc("flagged-user-uid").get()).data();
    if (!doc.safeSearchFlag.reason.includes("adult") || !doc.safeSearchFlag.reason.includes("racy")) {
      throw new Error(`expected safeSearchFlag.reason to name both categories, got: ${doc.safeSearchFlag.reason}`);
    }
    if (doc.safeSearchFlag.fileName !== "UNSAFE_TEST_TRIGGER.png") {
      throw new Error(`expected fileName to be recorded, got: ${doc.safeSearchFlag.fileName}`);
    }
    await waitFor(async () => {
      const snap = await db.collection("users").doc("admin1-uid").collection("notifications").get();
      return snap.docs.some((d) => (d.data().type || "") === "safesearch");
    });
  }

  // 3. Same, but for walkerProfiles/{uid} — confirms the OTHER scanned
  // collection routes correctly too, not just users/.
  {
    await db.collection("walkerProfiles").doc("flagged-walker-uid").set({ approved: true });
    await upload("walkerProfiles/flagged-walker-uid/UNSAFE_TEST_TRIGGER.png");
    await waitFor(async () => {
      const doc = (await db.collection("walkerProfiles").doc("flagged-walker-uid").get()).data();
      return doc.approved === false && doc.safeSearchFlag?.flagged === true;
    });
  }

  // 4. dogs/{dogId} photos are deliberately NOT screened — even an
  // "unsafe" filename there must not touch anything (dogs have no
  // approved/safeSearchFlag concept at all — confirmed with the user,
  // dog profiles are private to the owner only).
  {
    await db.collection("dogs").doc("some-dog-id").set({ ownerId: "safe-user-uid" });
    await upload("dogs/some-dog-id/UNSAFE_TEST_TRIGGER.png");
    await settle(2000);
    const doc = (await db.collection("dogs").doc("some-dog-id").get()).data();
    if ("approved" in doc || "safeSearchFlag" in doc) {
      throw new Error(`expected a dogs/ upload to never be screened at all, got: ${JSON.stringify(doc)}`);
    }
  }

  // 5. A non-image content type is ignored entirely, even at a scanned path.
  {
    await db.collection("users").doc("non-image-uid").set({ approved: true });
    await upload("users/non-image-uid/UNSAFE_TEST_TRIGGER.txt", { contentType: "text/plain" });
    await settle(2000);
    const doc = (await db.collection("users").doc("non-image-uid").get()).data();
    if (doc.approved !== true || doc.safeSearchFlag) {
      throw new Error(`expected a non-image upload to be ignored, got: ${JSON.stringify(doc)}`);
    }
  }

  console.log("✓ checkImageSafeSearch tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
