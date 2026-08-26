// Regression coverage for the sign-up/login feature (see docs/ARCHITECTURE.md
// for the users/towns schema this exercises). Runs against the Auth +
// Firestore emulators, seeded with one town by testing/emulator-seed.js.
const { test, expect } = require("@playwright/test");

const uniqueEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

// One test, one shared `page` — Playwright gives every test() a fresh,
// isolated browser context by default, so Firebase Auth's session
// (IndexedDB-backed) would NOT carry over between separate test() blocks.
test("sign up, land on the pending dashboard, log out, then log back in", async ({ page }) => {
  const email = uniqueEmail();
  const password = "test-password-123";

  await page.goto("/signup.html");
  await page.fill("#displayName", "Test Owner");
  await page.selectOption("#townId", { label: "Pauls Valley" });
  // role defaults to "owner" — leave as-is
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.check("#agreeTerms");
  await page.click("#submitBtn");

  await page.waitForURL("**/dashboard.html");
  await expect(page.locator(".status-badge--pending")).toBeVisible();
  await expect(page.locator("h1")).toContainText("Test Owner");

  await page.click("#logoutBtn");
  await page.waitForURL("**/index.html");

  await page.goto("/login.html");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("#submitBtn");

  await page.waitForURL("**/dashboard.html");
  await expect(page.locator(".status-badge--pending")).toBeVisible();
});

test("signup with a role query param preselects that role", async ({ page }) => {
  await page.goto("/signup.html?role=walker");
  await expect(page.locator('input[name="role"][value="walker"]')).toBeChecked();
});
