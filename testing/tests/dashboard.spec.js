// Regression coverage for dashboard.html's profile-loading robustness —
// see docs/ARCHITECTURE.md. Ensures a stalled/failed Firestore read never
// leaves the UI stuck on "Loading your profile…" forever: it must always
// resolve to either real data or a visible error within a bounded time.
const { test, expect } = require("@playwright/test");
const tokens = require("../.auth-tokens.json");

test("a stalled Firestore read resolves to a visible error, not an infinite loading state", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async (t) => {
    const mod = await import("./firebase-init.js");
    await mod.signInWithCustomToken(mod.auth, t);
  }, tokens.nonAdminToken);

  // Simulate a Firestore outage for this one test only, by blocking all
  // traffic to the Firestore emulator right before loading dashboard.html
  // — proves the client-side timeout fallback fires instead of hanging.
  await page.route("http://127.0.0.1:8080/**", (route) => route.abort());

  await page.goto("/dashboard.html");

  // Must resolve to a visible error — never stay stuck on the loading
  // placeholder forever. (In practice this resolves fast: the Firestore
  // SDK's own offline detection fires before the 10s client-side timeout
  // even matters — which is fine, that timeout is the backstop for cases
  // offline detection doesn't catch, e.g. a slow-but-technically-online
  // network or a hung security-rules evaluation.)
  await expect(page.locator("#dashboardCard")).toContainText(/something went wrong/i, { timeout: 15000 });
  await expect(page.locator("#dashboardCard")).not.toContainText("Loading your profile");
});
