// Regression coverage for the admin panel — see docs/ARCHITECTURE.md
// "Admin portal & approval flow". There is no public admin link/button
// anywhere and no separate route: the whole section is created via
// document.createElement inside public/dashboard.html's module script,
// and ONLY once onAuthStateChanged reports a real signed-in user whose
// email is on the admins/{email} allowlist — never present in the DOM
// otherwise. These tests assert both halves of that: the section is
// genuinely absent for everyone else, and it works end to end for a real
// admin. There's no way to automate a real Google OAuth popup here, so
// sign-in happens via signInWithCustomToken against the Auth emulator
// instead (tokens minted by testing/emulator-seed.js's globalSetup,
// written to .auth-tokens.json). The wrong-PIN/correct-PIN cases exercise
// the real deployed-shaped verifyAdminPin Cloud Function running in the
// emulator, not a mock.
const { test, expect } = require("@playwright/test");
const tokens = require("../.auth-tokens.json");

// Must match functions/.secret.local (also gitignored) — never the real
// production ADMIN_PIN.
const TEST_PIN = "00000000-local-test-only";

async function signInWithToken(page, token) {
  await page.evaluate(async (t) => {
    const mod = await import("./firebase-init.js");
    await mod.signInWithCustomToken(mod.auth, t);
  }, token);
}

// Sign in on a neutral page first — dashboard.html redirects straight to
// login.html on its very first (unauthenticated) auth-state firing, which
// would otherwise navigate away before signInWithToken ever runs.
async function signInThenGoToDashboard(page, token) {
  await page.goto("/");
  await signInWithToken(page, token);
  await page.goto("/dashboard.html");
}

test("the landing page has no admin link, button, or hidden element anywhere", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#adminSection")).toHaveCount(0);
  await expect(page.locator("text=Admin")).toHaveCount(0);
});

test("a logged-out visitor to dashboard.html gets no admin markup — it redirects before anything renders", async ({ page }) => {
  await page.goto("/dashboard.html");
  await page.waitForURL("**/login.html");
  await expect(page.locator("#adminSection")).toHaveCount(0);
});

test("a signed-in, non-allowlisted user never gets the admin section created", async ({ page }) => {
  await signInThenGoToDashboard(page, tokens.nonAdminToken);
  await expect(page.locator(".status-badge, h1")).toBeVisible();
  await expect(page.locator("#adminSection")).toHaveCount(0);
});

test("a signed-in, allowlisted admin gets the PIN gate automatically, no click required", async ({ page }) => {
  await signInThenGoToDashboard(page, tokens.adminToken);
  await expect(page.locator("#adminSection #pinForm")).toBeVisible();
});

test("an allowlisted admin entering the wrong PIN is rejected", async ({ page }) => {
  await signInThenGoToDashboard(page, tokens.adminToken);
  await expect(page.locator("#pinForm")).toBeVisible();
  await page.fill("#pinInput", "definitely-not-the-pin");
  await page.click("#pinForm button[type=submit]");

  // Generous timeout here specifically: this round-trips through the real
  // verifyAdminPin Cloud Function in the emulator, which can be slow to
  // respond when the whole emulator stack + browser are all competing for
  // resources during a full test run.
  await expect(page.locator("#pinError")).toContainText("Incorrect code", { timeout: 15000 });
  await expect(page.locator("#mainCard")).toBeHidden();
});

test("the correct PIN unlocks the panel, and approving a pending user removes it from the list", async ({ page }) => {
  await signInThenGoToDashboard(page, tokens.adminToken);
  await page.fill("#pinInput", TEST_PIN);
  await page.click("#pinForm button[type=submit]");

  await expect(page.locator("#mainCard")).toBeVisible({ timeout: 15000 });
  const row = page.locator(`#row-${tokens.pendingUid}`);
  await expect(row).toContainText("Pending Test User");

  await row.locator("[data-approve]").click();
  await expect(row).toHaveCount(0);
});
