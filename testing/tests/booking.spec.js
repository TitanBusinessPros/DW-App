// Regression coverage for the booking flow (Rover-parity item): requesting
// a walk from browse.html, then accepting/declining/cancelling/completing
// it from dashboard.html's bookings section. Runs against the full Auth +
// Firestore + Functions emulator stack.
const { test, expect } = require("@playwright/test");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

// Named explicitly, same reason as the other spec files' own admin apps.
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const adminApp = initializeApp({ projectId: "dw-app-2beee" }, "booking-spec");
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

// Every test mints its own fresh owner + walker pair, both approved, both
// in Pauls Valley, with the walker having a real approved listing — same
// reason every other spec file in this suite does this: a shared fixture
// would accumulate bookings across tests, making "the one row in the
// list" an unsafe assumption to assert against.
async function mintOwnerAndWalkerPair() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerUid = `fresh-owner-${stamp}`;
  const walkerUid = `fresh-walker-${stamp}`;

  await adminAuth.createUser({ uid: ownerUid, email: `${ownerUid}@example.com`, emailVerified: true });
  await adminAuth.createUser({ uid: walkerUid, email: `${walkerUid}@example.com`, emailVerified: true });

  await adminDb.collection("users").doc(ownerUid).set({
    profile: { name: "Test Owner" },
    role: "owner",
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  await adminDb.collection("users").doc(walkerUid).set({
    profile: { name: "Test Walker" },
    role: "walker",
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  await adminDb.collection("walkerProfiles").doc(walkerUid).set({
    approved: true,
    everApproved: true,
    townId: "pauls-valley",
    bio: "Test walker bio",
    hourlyRate: 20,
    serviceRadius: 5,
    availability: "Anytime",
  });

  const [ownerToken, walkerToken] = await Promise.all([
    adminAuth.createCustomToken(ownerUid),
    adminAuth.createCustomToken(walkerUid),
  ]);
  return { ownerUid, walkerUid, ownerToken, walkerToken };
}

async function signInThenGoTo(page, token, url) {
  await page.goto("/");
  await page.evaluate(async (t) => {
    const mod = await import("./firebase-init.js");
    await mod.signInWithCustomToken(mod.auth, t);
  }, token);
  await page.goto(url);
}

test("an owner requests a walk, and the walker sees it as pending", async ({ page, browser }) => {
  const { walkerUid, ownerToken, walkerToken } = await mintOwnerAndWalkerPair();

  // Scoped to THIS test's own walker card — Pauls Valley also has the
  // static "Wendy Walker" fixture from emulator-seed.js (used by
  // browse.spec.js), so an unscoped selector could hit either card.
  await signInThenGoTo(page, ownerToken, "/browse.html");
  const walkerCard = page.locator(`[data-walker-card="${walkerUid}"]`);
  await expect(walkerCard).toContainText("Test Walker");
  await walkerCard.locator("[data-request-btn]").click();
  await walkerCard.locator('[id^="notes-"]').fill("Tuesday afternoon please");
  await walkerCard.locator("[data-send-request]").click();
  await expect(walkerCard.getByText("Request sent!")).toBeVisible();

  // A separate browser context for the walker — a genuinely different
  // signed-in session from the owner's, not just a different page.
  const walkerCtx = await browser.newContext();
  const walkerPage = await walkerCtx.newPage();
  await signInThenGoTo(walkerPage, walkerToken, "/dashboard.html");
  await expect(walkerPage.getByText("Test Owner")).toBeVisible();
  await expect(walkerPage.locator('[data-booking-row] .status-badge')).toContainText("Pending");
  await expect(walkerPage.getByText("Tuesday afternoon please")).toBeVisible();
  await walkerCtx.close();
});

test("a walker accepting a request updates the status for both sides", async ({ browser }) => {
  const { ownerUid, walkerUid, ownerToken, walkerToken } = await mintOwnerAndWalkerPair();
  await adminDb.collection("bookings").add({
    ownerId: ownerUid,
    walkerId: walkerUid,
    townId: "pauls-valley",
    status: "requested",
    notes: "Accept-test booking",
    createdAt: new Date(),
  });

  const walkerCtx = await browser.newContext();
  const walkerPage = await walkerCtx.newPage();
  await signInThenGoTo(walkerPage, walkerToken, "/dashboard.html");
  await expect(walkerPage.locator('[data-accept]')).toBeVisible();
  await walkerPage.click('[data-accept]');
  await expect(walkerPage.locator('[data-booking-row] .status-badge')).toContainText("Accepted");

  const ownerCtx = await browser.newContext();
  const ownerPage = await ownerCtx.newPage();
  await signInThenGoTo(ownerPage, ownerToken, "/dashboard.html");
  await expect(ownerPage.locator('[data-booking-row] .status-badge')).toContainText("Accepted");
  // Owner can no longer accept/decline (that's the walker's call) — only cancel.
  await expect(ownerPage.locator('[data-accept]')).toHaveCount(0);

  await walkerCtx.close();
  await ownerCtx.close();
});

test("a walker declining a request shows as declined, with no further actions", async ({ browser }) => {
  const { ownerUid, walkerUid, walkerToken } = await mintOwnerAndWalkerPair();
  await adminDb.collection("bookings").add({
    ownerId: ownerUid,
    walkerId: walkerUid,
    townId: "pauls-valley",
    status: "requested",
    notes: "Decline-test booking",
    createdAt: new Date(),
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInThenGoTo(page, walkerToken, "/dashboard.html");
  await page.click('[data-decline]');
  await expect(page.locator('[data-booking-row] .status-badge')).toContainText("Declined");
  await expect(page.locator('[data-booking-row] button')).toHaveCount(0);
  await ctx.close();
});

test("either party can mark an accepted booking complete", async ({ browser }) => {
  const { ownerUid, walkerUid, ownerToken } = await mintOwnerAndWalkerPair();
  await adminDb.collection("bookings").add({
    ownerId: ownerUid,
    walkerId: walkerUid,
    townId: "pauls-valley",
    status: "accepted",
    notes: "Complete-test booking",
    createdAt: new Date(),
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInThenGoTo(page, ownerToken, "/dashboard.html");
  await page.click('[data-complete]');
  await expect(page.locator('[data-booking-row] .status-badge')).toContainText("Completed");
  await expect(page.locator('[data-booking-row] button')).toHaveCount(0);
  await ctx.close();
});
