// Regression coverage for the admin panel embedded in public/index.html —
// see docs/ARCHITECTURE.md "Admin portal & approval flow". There's no
// separate admin page/route: it's a hidden section on the landing page,
// revealed via the #admin URL fragment (as used here) or the footer
// "Admin" link. There's also no way to automate a real Google OAuth popup
// here, so these tests sign in via signInWithCustomToken against the Auth
// emulator instead (tokens minted by testing/emulator-seed.js's
// globalSetup, written to .auth-tokens.json). The wrong-PIN/correct-PIN
// cases exercise the real deployed-shaped verifyAdminPin Cloud Function
// running in the emulator, not a mock.
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

test("a signed-in, non-allowlisted email is told it's not authorized", async ({ page }) => {
  await page.goto("/#admin");
  await expect(page.locator("#adminPanel")).toBeVisible();
  await signInWithToken(page, tokens.nonAdminToken);
  await expect(page.locator("#gateCard")).toContainText("isn't on the admin list");
  // Never gets as far as being offered the PIN form.
  await expect(page.locator("#pinForm")).toHaveCount(0);
});

test("an allowlisted admin entering the wrong PIN is rejected", async ({ page }) => {
  await page.goto("/#admin");
  await signInWithToken(page, tokens.adminToken);

  await expect(page.locator("#pinForm")).toBeVisible();
  await page.fill("#pinInput", "definitely-not-the-pin");
  await page.click("#pinForm button[type=submit]");

  await expect(page.locator("#pinError")).toContainText("Incorrect code");
  // Still gated — the pending list never rendered.
  await expect(page.locator("#mainCard")).toBeHidden();
});

test("the correct PIN unlocks the portal, and approving a pending user removes it from the list", async ({ page }) => {
  await page.goto("/#admin");
  await signInWithToken(page, tokens.adminToken);

  await page.fill("#pinInput", TEST_PIN);
  await page.click("#pinForm button[type=submit]");

  await expect(page.locator("#mainCard")).toBeVisible();
  const row = page.locator(`#row-${tokens.pendingUid}`);
  await expect(row).toContainText("Pending Test User");

  await row.locator("[data-approve]").click();
  await expect(row).toHaveCount(0);
});

test("the footer Admin link reveals the panel without navigating away", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#adminPanel")).toBeHidden();
  await page.click("#adminTrigger");
  await expect(page.locator("#adminPanel")).toBeVisible();
  await expect(page).toHaveURL(/\/#admin$/); // same document, just a fragment — no new page
});

test("dashboard.html links back to the admin panel on the main page for an allowlisted email", async ({ page }) => {
  // Sign in on a neutral page first — dashboard.html itself redirects
  // straight to login.html on its very first (unauthenticated) auth-state
  // firing, which would otherwise navigate away before signInWithToken
  // ever runs.
  await page.goto("/");
  await signInWithToken(page, tokens.adminToken);
  await page.goto("/dashboard.html");
  await expect(page.locator('a[href="index.html#admin"]')).toBeVisible();
});
