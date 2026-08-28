// Guards against a new Firestore collection (or subcollection) shipping
// with no matching test — the same idea as
// testing/functions/check-function-coverage.js, applied to firestore.rules.
//
// Scans firestore.rules for every `match /{collection}/{...}` block and
// fails if <collection> isn't referenced anywhere under testing/rules/
// (as a literal name — e.g. inside a .collection("name") call). This is a
// cheap name-presence check, not proof the test is thorough or that every
// allow/deny branch is covered — it just makes "I forgot to test this
// collection at all" impossible to merge silently. The top-level
// `match /{document=**}` deny-all catch-all is intentionally not required
// to have its own test.
const fs = require("node:fs");
const path = require("node:path");

const RULES_FILE = path.resolve(__dirname, "../../firestore.rules");
const RULES_TESTS_DIR = __dirname;

const rulesSrc = fs.readFileSync(RULES_FILE, "utf8");

// Matches lines like `match /users/{uid} {` or `match /messages/{messageId} {`
// (nested matches too) — but not the bare `match /{document=**}` catch-all
// (nothing between `/` and `{`), and not the outer service wrapper
// `match /databases/{database}/documents {`, which isn't a real collection.
const collections = [
  ...new Set(
    [...rulesSrc.matchAll(/^\s*match \/([A-Za-z0-9_]+)\/\{[^}]*\}([^{]*)\{/gm)]
      .filter((m) => !m[2].includes("/documents"))
      .map((m) => m[1])
  ),
];

if (collections.length === 0) {
  console.log("No collection match blocks found — nothing to check.");
  process.exit(0);
}

const testFiles = fs
  .readdirSync(RULES_TESTS_DIR)
  .filter((f) => f.endsWith(".js") && f !== path.basename(__filename));

const testsSrc = testFiles
  .map((f) => fs.readFileSync(path.join(RULES_TESTS_DIR, f), "utf8"))
  .join("\n");

const untested = collections.filter((name) => !testsSrc.includes(name));

if (untested.length > 0) {
  console.error(
    `✗ Firestore collection(s) in firestore.rules with no matching test under testing/rules/: ${untested.join(
      ", "
    )}\n` +
      `  Add at least one assertSucceeds/assertFails case referencing .collection("${untested[0]}") in testing/rules/run-rules-tests.js.`
  );
  process.exit(1);
}

console.log(`✓ All Firestore collections have a matching test: ${collections.join(", ")}`);
