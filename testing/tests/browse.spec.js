// Regression coverage for browse.html — the walker-discovery page
// (Rover-parity item). Runs against the Auth + Firestore emulators,
// seeded by testing/emulator-seed.js: an approved walker in Pauls Valley
// with a real listing, and another in Wynnewood (for the town-scoping
// test) — both read-only fixtures here, safe to share across tests.
const { test, expect } = require("@playwright/test");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const tokens = require("../.auth-tokens.json");

// Named explicitly, same reason as signup-login.spec.js's own admin app —
// avoids "default app already exists" if Playwright runs spec files in a
// shared process.
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const adminApp = initializeApp({ projectId: "dw-app-2beee" }, "browse-spec");
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

async function signInWithToken(page, token) {
  await page.evaluate(async (t) => {
    const mod = await import("./firebase-init.js");
    await mod.signInWithCustomToken(mod.auth, t);
  }, token);
}

async function signInThenGoTo(page, token, url) {
  await page.goto("/");
  await signInWithToken(page, token);
  await page.goto(url);
}

test("an approved owner sees the approved walker in their own town", async ({ page }) => {
  await signInThenGoTo(page, tokens.nonAdminToken, "/browse.html");
  await expect(page.locator("h1")).toContainText("Walkers near you");
  // Scoped to Wendy Walker's own card — other tests' fresh walker fixtures
  // can also land in Pauls Valley with the same $20/hr rate, making an
  // unscoped page-wide "$20/hr" text search ambiguous.
  const wendyCard = page.locator("[data-walker-card]").filter({ hasText: "Wendy Walker" });
  await expect(wendyCard).toContainText("$20/hr");
});

test("a walker listed in a different town does not show up", async ({ page }) => {
  await signInThenGoTo(page, tokens.nonAdminToken, "/browse.html");
  await expect(page.getByText("Wyatt Wynnewood")).toHaveCount(0);
});

test("an unapproved user cannot browse — sees a clear message instead of the list", async ({ page }) => {
  const uid = `fresh-unapproved-${Date.now()}`;
  await adminAuth.createUser({ uid, email: `${uid}@example.com`, emailVerified: true });
  await adminDb.collection("users").doc(uid).set({
    profile: { name: "Unapproved Owner" },
    role: "owner",
    townId: "pauls-valley",
    approved: false,
    everApproved: false,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  const token = await adminAuth.createCustomToken(uid);

  await signInThenGoTo(page, token, "/browse.html");
  await expect(page.locator("h1")).toContainText("Not yet");
  await expect(page.getByText("Wendy Walker")).toHaveCount(0);
});
