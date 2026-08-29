// Regression coverage for the walker-listing section of dashboard.html —
// lets a "walker"/"both"-role user create/edit the walkerProfiles/{uid}
// listing that browse.html (see browse.spec.js) reads from. Runs against
// the Auth + Firestore + Storage emulators.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const tokens = require("../.auth-tokens.json");

// Named explicitly, same reason as signup-login.spec.js's own admin app.
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const adminApp = initializeApp({ projectId: "dw-app-2beee" }, "walker-listing-spec");
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

// Every test that creates/edits a listing mints its OWN fresh walker user —
// same reason signup-login.spec.js does this for fresh signups: the
// emulator persists real writes across tests in a run, so a shared
// "no listing yet" fixture would stop being fresh after the first test
// that actually creates one.
async function mintWalkerUser({ role = "walker", withListing = null } = {}) {
  const uid = `fresh-walker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await adminAuth.createUser({ uid, email: `${uid}@example.com`, emailVerified: true });
  await adminDb.collection("users").doc(uid).set({
    profile: { name: "Fresh Walker Test" },
    role,
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  if (withListing) {
    await adminDb.collection("walkerProfiles").doc(uid).set({
      approved: false,
      everApproved: false,
      townId: "pauls-valley",
      ...withListing,
    });
  }
  const token = await adminAuth.createCustomToken(uid);
  return { uid, token };
}

async function signInThenGoTo(page, token, url) {
  await page.goto("/");
  await page.evaluate(async (t) => {
    const mod = await import("./firebase-init.js");
    await mod.signInWithCustomToken(mod.auth, t);
  }, token);
  await page.goto(url);
}

test("a walker with no listing yet sees the create form and can submit it", async ({ page }) => {
  const { uid, token } = await mintWalkerUser();
  await signInThenGoTo(page, token, "/dashboard.html");

  await expect(page.locator("#walkerListingCard h1")).toContainText("Create your walker listing");
  await page.fill("#bio", "I love long walks and good dogs.");
  await page.fill("#hourlyRate", "25");
  await page.fill("#serviceRadius", "10");
  await page.fill("#availability", "Weekends");
  await page.click("#listingSubmitBtn");

  await expect(page.locator("#walkerListingCard .status-badge--pending")).toBeVisible();
  await expect(page.locator("#walkerListingCard h1")).toContainText("Your walker listing");

  // Poll rather than a single read — see the "editing an existing listing"
  // test below for why: a separate client connection (this test's adminDb)
  // can briefly observe a stale value right after the browser's own write,
  // even once the UI has already re-rendered with the new one.
  await expect
    .poll(async () => (await adminDb.collection("walkerProfiles").doc(uid).get()).data()?.bio, { timeout: 10000 })
    .toBe("I love long walks and good dogs.");

  const snap = await adminDb.collection("walkerProfiles").doc(uid).get();
  expect(snap.exists).toBe(true);
  const data = snap.data();
  expect(data.bio).toBe("I love long walks and good dogs.");
  expect(data.hourlyRate).toBe(25);
  expect(data.serviceRadius).toBe(10);
  expect(data.availability).toBe("Weekends");
  expect(data.approved).toBe(false);
  expect(data.townId).toBe("pauls-valley");
});

test("an owner-only user never sees the walker listing section", async ({ page }) => {
  const { token } = await mintWalkerUser({ role: "owner" });
  await signInThenGoTo(page, token, "/dashboard.html");
  await expect(page.locator("h1")).toBeVisible(); // the regular profile card still renders
  await expect(page.locator("#walkerListingSection")).toHaveCount(0);
});

test("editing an existing listing pre-fills the form and saves changes without touching approval", async ({ page }) => {
  const { uid, token } = await mintWalkerUser({
    withListing: { bio: "Original bio", hourlyRate: 15, serviceRadius: 5, availability: "Mornings" },
  });
  await signInThenGoTo(page, token, "/dashboard.html");

  await expect(page.locator("#walkerListingCard h1")).toContainText("Your walker listing");
  await expect(page.locator("#bio")).toHaveValue("Original bio");
  await expect(page.locator("#hourlyRate")).toHaveValue("15");

  await page.fill("#bio", "Updated bio");
  await page.click("#listingSubmitBtn");
  // NOT the pending badge — it was already showing "pending" before this
  // edit even started (the listing was created unapproved), so waiting on
  // it would pass instantly without actually waiting for the async
  // updateDoc()->getDoc()->re-render chain to finish. Waiting for the
  // textarea's value to genuinely change to the new bio (set by that
  // re-render) is the real signal the save actually completed.
  await expect(page.locator("#bio")).toHaveValue("Updated bio");

  // Poll rather than a single read: the browser's own client sees its
  // write immediately (confirmed above), but a genuinely separate client
  // connection (this test's own adminDb, a different gRPC channel) reading
  // right after can observe a still-stale value for a moment — a real
  // cross-client propagation gap in the emulator, not a test-timing
  // mistake (confirmed once: an immediate single read here failed with the
  // OLD bio even after the UI had already re-rendered with the new one).
  await expect
    .poll(async () => (await adminDb.collection("walkerProfiles").doc(uid).get()).data().bio, { timeout: 10000 })
    .toBe("Updated bio");

  const data = (await adminDb.collection("walkerProfiles").doc(uid).get()).data();
  expect(data.approved).toBe(false); // untouched by a self-service edit
  expect(data.everApproved).toBe(false);
});

test("uploading a photo saves a real download URL on the listing", async ({ page }) => {
  const { uid, token } = await mintWalkerUser();
  await signInThenGoTo(page, token, "/dashboard.html");

  // A minimal real PNG — checkImageSafeSearch will try to scan it via the
  // real Vision API in this environment (no DOG_WALKER_VISION_TEST_MODE
  // here) and fail gracefully (no real credentials available), which is
  // fine: this test only asserts the upload + Firestore URL write, both
  // client-side and independent of whether screening itself succeeds.
  const pngPath = path.join(os.tmpdir(), `dw-test-photo-${Date.now()}.png`);
  fs.writeFileSync(
    pngPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  );

  await page.fill("#bio", "Photo test bio");
  await page.fill("#hourlyRate", "20");
  await page.fill("#serviceRadius", "5");
  await page.fill("#availability", "Anytime");
  await page.setInputFiles("#photo", pngPath);
  await page.click("#listingSubmitBtn");

  await expect(page.locator("#walkerListingCard .status-badge--pending")).toBeVisible();

  // Poll rather than a single read — see the "editing an existing listing"
  // test for why (a real cross-client propagation gap, not a mistake).
  await expect
    .poll(async () => (await adminDb.collection("walkerProfiles").doc(uid).get()).data()?.photo, { timeout: 10000 })
    .toMatch(/^https?:\/\//);

  fs.unlinkSync(pngPath);
});
