// Runs against the site as served by the Firebase Hosting emulator, talking
// to local emulators for everything else — never production.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  globalSetup: require.resolve("./emulator-seed.js"),
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5000",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
