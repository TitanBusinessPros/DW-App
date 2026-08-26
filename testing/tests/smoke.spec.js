// Placeholder smoke test so CI has something real to run from day one.
// Expand this as features land — one spec file per feature, per the
// "every new feature gets its own regression check" rule.
const { test, expect } = require("@playwright/test");

test("home page loads and shows the hero", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Trusted dog walkers");
  await expect(page.locator(".search-bar input")).toBeVisible();
});
