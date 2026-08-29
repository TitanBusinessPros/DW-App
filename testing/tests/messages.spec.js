// Regression coverage for the messaging UI (Rover-parity item):
// messages.html's conversation list + thread view, backed by
// firestore.rules' conversations/messages rules and the
// onFirstMessageNotify Cloud Function (already covered by its own
// function-level test — this file is about the UI actually using them).
const { test, expect } = require("@playwright/test");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

// Named explicitly, same reason as the other spec files' own admin apps.
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const adminApp = initializeApp({ projectId: "dw-app-2beee" }, "messages-spec");
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

// Every test mints its own fresh pair — same reason every other spec file
// in this suite does: a shared fixture would accumulate conversations/
// messages across tests, making "the one thread in the list" unsafe to
// assert against.
async function mintPair() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const aUid = `fresh-a-${stamp}`;
  const bUid = `fresh-b-${stamp}`;
  await adminAuth.createUser({ uid: aUid, email: `${aUid}@example.com`, emailVerified: true });
  await adminAuth.createUser({ uid: bUid, email: `${bUid}@example.com`, emailVerified: true });
  for (const [uid, name] of [[aUid, "Alice Test"], [bUid, "Bob Test"]]) {
    await adminDb.collection("users").doc(uid).set({
      profile: { name },
      role: "owner",
      townId: "pauls-valley",
      approved: true,
      everApproved: true,
      agreedToTerms: true,
      confirmedAge18Plus: true,
      createdAt: new Date(),
    });
  }
  const [aToken, bToken] = await Promise.all([adminAuth.createCustomToken(aUid), adminAuth.createCustomToken(bUid)]);
  return { aUid, bUid, aToken, bToken };
}

async function signInThenGoTo(page, token, url) {
  await page.goto("/");
  await page.evaluate(async (t) => {
    const mod = await import("./firebase-init.js");
    await mod.signInWithCustomToken(mod.auth, t);
  }, token);
  await page.goto(url);
}

test("sending the first message creates the conversation and both sides see it", async ({ page, browser }) => {
  const { aUid, bUid, aToken, bToken } = await mintPair();

  await signInThenGoTo(page, aToken, `/messages.html?with=${bUid}`);
  await expect(page.locator("h1")).toContainText("Bob Test");
  await page.fill("#messageText", "Hi Bob, first message!");
  await page.click('#threadForm button[type=submit]');
  await expect(page.locator("#threadMessages")).toContainText("Hi Bob, first message!");

  // Bob opens the same thread in a separate session — a genuinely
  // different signed-in browser context, not just a second page.
  const bobCtx = await browser.newContext();
  const bobPage = await bobCtx.newPage();
  await signInThenGoTo(bobPage, bToken, `/messages.html?with=${aUid}`);
  await expect(bobPage.locator("h1")).toContainText("Alice Test");
  await expect(bobPage.locator("#threadMessages")).toContainText("Hi Bob, first message!");

  // Bob replies — Alice's ALREADY-OPEN page should pick it up live via
  // onSnapshot, with no reload. This is the real point of this test: it
  // proves the live update actually works, not just that a fresh load
  // shows the data.
  await bobPage.fill("#messageText", "Hey Alice, replying!");
  await bobPage.click('#threadForm button[type=submit]');
  await expect(page.locator("#threadMessages")).toContainText("Hey Alice, replying!", { timeout: 10000 });

  await bobCtx.close();
});

test("a conversation shows up in both participants' conversation lists", async ({ page, browser }) => {
  const { aUid, bUid, aToken, bToken } = await mintPair();

  await signInThenGoTo(page, aToken, `/messages.html?with=${bUid}`);
  await page.fill("#messageText", "Starting a conversation");
  await page.click('#threadForm button[type=submit]');
  await expect(page.locator("#threadMessages")).toContainText("Starting a conversation");

  await signInThenGoTo(page, aToken, "/messages.html");
  await expect(page.locator("h1")).toContainText("Messages");
  await expect(page.getByText("Bob Test")).toBeVisible();

  const bobCtx = await browser.newContext();
  const bobPage = await bobCtx.newPage();
  await signInThenGoTo(bobPage, bToken, "/messages.html");
  await expect(bobPage.getByText("Alice Test")).toBeVisible();
  await bobCtx.close();
});

test("an unapproved user cannot message — sees a clear message instead", async ({ page }) => {
  const stamp = `${Date.now()}-unapproved`;
  const uid = `fresh-unapproved-${stamp}`;
  await adminAuth.createUser({ uid, email: `${uid}@example.com`, emailVerified: true });
  await adminDb.collection("users").doc(uid).set({
    profile: { name: "Unapproved Test" },
    role: "owner",
    townId: "pauls-valley",
    approved: false,
    everApproved: false,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  const token = await adminAuth.createCustomToken(uid);

  await signInThenGoTo(page, token, "/messages.html");
  await expect(page.locator("h1")).toContainText("Not yet");
});
