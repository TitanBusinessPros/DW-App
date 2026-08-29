// Regression coverage for the sign-up/login feature (see docs/ARCHITECTURE.md
// for the users/towns schema this exercises, and the "signup flow" decision
// log entry for why it's Google-only, three steps). Runs against the Auth +
// Firestore emulators, seeded by testing/emulator-seed.js.
//
// There's no way to automate a real Google OAuth popup in CI (same
// limitation admin.spec.js already documents), so every test here starts
// from having ALREADY completed that step, via signInWithCustomToken
// against the Auth emulator — from the app's perspective, a custom-token
// sign-in and a real Google popup sign-in look identical (both just
// populate auth.currentUser), so this still exercises everything AFTER
// that point for real: the terms/18+ step, the profile-creation step, the
// actual Firestore write, and the dashboard/login routing.
const { test, expect } = require("@playwright/test");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const tokens = require("../.auth-tokens.json");

// Every test that needs a "brand-new, no-profile-yet" signed-in user mints
// its OWN fresh uid here, rather than sharing one static fixture — the
// emulator persists real writes across tests within a run (workers: 1,
// same long-lived emulator), so a shared "fresh" fixture would stop being
// fresh after the first test that actually completes its profile. Runs in
// this file's own Node-side test process (not page.evaluate/in-browser),
// same emulator connection pattern as testing/emulator-seed.js.
// Named explicitly ("signup-login-spec") rather than left as the default
// app — Playwright may run this file's top-level code in a process that
// already has its own default app registered (e.g. alongside
// emulator-seed.js's globalSetup), and initializeApp() throws if called
// twice with no name in the same process.
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const adminAuth = getAuth(initializeApp({ projectId: "dw-app-2beee" }, "signup-login-spec"));
async function mintFreshSignupToken() {
  const uid = `fresh-signup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return adminAuth.createCustomToken(uid);
}

async function signInWithToken(page, token) {
  await page.evaluate(async (t) => {
    const mod = await import("./firebase-init.js");
    await mod.signInWithCustomToken(mod.auth, t);
  }, token);
}

// Sign in on a neutral page first — login.html/dashboard.html redirect away
// as soon as onAuthStateChanged reports a signed-in user, which would
// otherwise race ahead of signInWithToken ever finishing if called after
// navigating there directly.
async function signInThenGoTo(page, token, url) {
  await page.goto("/");
  await signInWithToken(page, token);
  await page.goto(url);
}

test("a brand-new signup completes terms + profile and lands on the pending dashboard", async ({ page }) => {
  // signup.html itself never redirects a signed-out visitor away, so it's
  // safe to load it first and sign in afterward (no race to guard against
  // here, unlike login.html/dashboard.html).
  await page.goto("/signup.html");
  await signInWithToken(page, await mintFreshSignupToken());

  await expect(page.locator("#stepTerms")).toBeVisible();
  await page.check("#confirmAge");
  await page.check("#agreeTerms");
  await page.click("#continueFromTermsBtn");

  await expect(page.locator("#stepProfile")).toBeVisible();
  await page.fill("#displayName", "New Signup Test");
  await page.selectOption("#townId", { label: "Pauls Valley" });
  // role defaults to "owner" — leave as-is
  await page.click("#submitBtn");

  await page.waitForURL("**/dashboard.html");
  await expect(page.locator(".status-badge--pending")).toBeVisible();
  await expect(page.locator("h1")).toContainText("New Signup Test");
});

test("the terms step blocks continuing until both checkboxes are checked", async ({ page }) => {
  await page.goto("/signup.html");
  await signInWithToken(page, await mintFreshSignupToken());
  await expect(page.locator("#stepTerms")).toBeVisible();

  await page.click("#continueFromTermsBtn");
  await expect(page.locator("#termsError")).toContainText("18 or older");
  await expect(page.locator("#stepProfile")).toBeHidden();

  await page.check("#confirmAge");
  await page.click("#continueFromTermsBtn");
  await expect(page.locator("#termsError")).toContainText("Terms of Service");
  await expect(page.locator("#stepProfile")).toBeHidden();

  await page.check("#agreeTerms");
  await page.click("#continueFromTermsBtn");
  await expect(page.locator("#stepProfile")).toBeVisible();
});

test("a role query param preselects that role once the profile step is reached", async ({ page }) => {
  await page.goto("/signup.html?role=walker");
  await signInWithToken(page, await mintFreshSignupToken());
  await page.check("#confirmAge");
  await page.check("#agreeTerms");
  await page.click("#continueFromTermsBtn");
  await expect(page.locator('input[name="role"][value="walker"]')).toBeChecked();
});

test("an already-onboarded user visiting login.html goes straight to the dashboard", async ({ page }) => {
  // nonAdminToken's user has a complete profile (see emulator-seed.js) —
  // this fixture is only ever READ by tests, never mutated, so it's safe
  // to share across tests unlike the "fresh signup" ones above.
  await signInThenGoTo(page, tokens.nonAdminToken, "/login.html");
  await page.waitForURL("**/dashboard.html");
  // Scoped to #dashboardCard — nonAdminToken's user is approved, so the
  // bookings section also mounts its own separate "Your bookings" h1.
  await expect(page.locator("#dashboardCard h1")).toContainText("Nonadmin Test User");
});

test("a signed-in user who never finished onboarding is routed from login.html to resume signup", async ({ page }) => {
  await signInThenGoTo(page, await mintFreshSignupToken(), "/login.html");
  await page.waitForURL("**/signup.html");
  await expect(page.locator("#stepTerms")).toBeVisible();
});

test("visiting dashboard.html directly with no profile yet redirects to signup.html to resume", async ({ page }) => {
  await signInThenGoTo(page, await mintFreshSignupToken(), "/dashboard.html");
  await page.waitForURL("**/signup.html");
  await expect(page.locator("#stepTerms")).toBeVisible();
});
