// Guards against a new Cloud Function shipping with no matching test.
//
// Scans functions/index.js for every `exports.<name> = ...` and fails if
// <name> isn't referenced anywhere under testing/functions/ (other than
// this file itself). This is a cheap name-presence check, not proof the
// test is thorough — it just makes "I forgot to add a test" impossible to
// merge silently. Runs before the emulator-based test steps in CI so it
// fails fast.
const fs = require("node:fs");
const path = require("node:path");

const FUNCTIONS_INDEX = path.resolve(__dirname, "../../functions/index.js");
const TESTS_DIR = __dirname;

const indexSrc = fs.readFileSync(FUNCTIONS_INDEX, "utf8");
const exported = [...indexSrc.matchAll(/^exports\.(\w+)\s*=/gm)].map((m) => m[1]);

if (exported.length === 0) {
  console.log("No exported Cloud Functions found — nothing to check.");
  process.exit(0);
}

const testFiles = fs
  .readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".js") && f !== path.basename(__filename));

const testsSrc = testFiles
  .map((f) => fs.readFileSync(path.join(TESTS_DIR, f), "utf8"))
  .join("\n");

const untested = exported.filter((name) => !testsSrc.includes(name));

if (untested.length > 0) {
  console.error(
    `✗ Cloud Function(s) with no matching test under testing/functions/: ${untested.join(", ")}\n` +
      `  Add a test that references the function by name (e.g. testing/functions/run-${untested[0]
        .replace(/([A-Z])/g, "-$1")
        .toLowerCase()}-tests.js), and add it as a CI step in .github/workflows/ci.yml.`
  );
  process.exit(1);
}

console.log(`✓ All exported Cloud Functions have a matching test: ${exported.join(", ")}`);
