// Regression coverage for the reviews feature (Rover-parity item, closes
// out the original 5-item list): leaving a review on a completed booking
// from dashboard.html, and seeing it on the walker's public profile page
// (walker.html). Backed by firestore.rules' tightened reviews/{bookingId}
// rule (booking-tied, one review per booking — see that file).
const { test, expect } = require("@playwright/test");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

// Named explicitly, same reason as the other spec files' own admin apps.
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const adminApp = initializeApp({ projectId: "dw-app-2beee" }, "reviews-spec");
const adminAuth = getAuth(adminApp);
const adminDb = getFirestore(adminApp);

// Every test mints its own fresh owner + walker pair, with a fresh
// COMPLETED booking between them — same isolation reasoning as every
// other spec file in this suite (a shared fixture would accumulate
// reviews/bookings across tests).
async function mintCompletedBookingPair() {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerUid = `fresh-owner-${stamp}`;
  const walkerUid = `fresh-walker-${stamp}`;

  await adminAuth.createUser({ uid: ownerUid, email: `${ownerUid}@example.com`, emailVerified: true });
  await adminAuth.createUser({ uid: walkerUid, email: `${walkerUid}@example.com`, emailVerified: true });

  await adminDb.collection("users").doc(ownerUid).set({
    profile: { name: "Review Owner" },
    role: "owner",
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  await adminDb.collection("users").doc(walkerUid).set({
    profile: { name: "Review Walker" },
    role: "walker",
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  await adminDb.collection("walkerProfiles").doc(walkerUid).set({
    approved: true,
    everApproved: true,
    townId: "pauls-valley",
    bio: "Review test walker bio",
    hourlyRate: 22,
    serviceRadius: 6,
    availability: "Anytime",
  });

  const bookingRef = await adminDb.collection("bookings").add({
    ownerId: ownerUid,
    walkerId: walkerUid,
    townId: "pauls-valley",
    status: "completed",
    notes: "Review test booking",
    createdAt: new Date(),
  });

  const ownerToken = await adminAuth.createCustomToken(ownerUid);
  return { ownerUid, walkerUid, bookingId: bookingRef.id, ownerToken };
}

async function signInThenGoTo(page, token, url) {
  await page.goto("/");
  await page.evaluate(async (t) => {
    const mod = await import("./firebase-init.js");
    await mod.signInWithCustomToken(mod.auth, t);
  }, token);
  await page.goto(url);
}

test("an owner leaves a review on a completed booking, and it shows on the walker's profile", async ({ page }) => {
  const { walkerUid, ownerToken } = await mintCompletedBookingPair();

  await signInThenGoTo(page, ownerToken, "/dashboard.html");
  const row = page.locator("[data-booking-row]").filter({ hasText: "Review Walker" });
  await expect(row.locator("[data-review-btn]")).toBeVisible();
  await row.locator("[data-review-btn]").click();

  await row.locator('select[id^="rating-"]').selectOption("4");
  await row.locator('textarea[id^="comment-"]').fill("Great walk, very reliable!");
  await row.locator("[data-send-review]").click();

  await expect(row.getByText("✅ Reviewed")).toBeVisible();
  await expect(row.locator("[data-review-btn]")).toHaveCount(0);

  await page.goto(`/walker.html?uid=${walkerUid}`);
  await expect(page.locator("h1")).toContainText("Review Walker");
  await expect(page.getByText("4.0 (1 review)")).toBeVisible();
  await expect(page.getByText("Great walk, very reliable!")).toBeVisible();
  await expect(page.getByText("Review Owner")).toBeVisible(); // reviewer's own name shown
});

test("a booking that's already been reviewed shows 'Reviewed', not the button", async ({ page }) => {
  const { ownerUid, walkerUid, bookingId, ownerToken } = await mintCompletedBookingPair();
  await adminDb.collection("reviews").doc(bookingId).set({
    reviewerId: ownerUid,
    walkerId: walkerUid,
    rating: 5,
    comment: "Pre-seeded review",
    createdAt: new Date(),
  });

  await signInThenGoTo(page, ownerToken, "/dashboard.html");
  const row = page.locator("[data-booking-row]").filter({ hasText: "Review Walker" });
  await expect(row.getByText("✅ Reviewed")).toBeVisible();
  await expect(row.locator("[data-review-btn]")).toHaveCount(0);
});

test("a walker with no reviews yet shows 'No reviews yet' on their profile", async ({ page }) => {
  const stamp = `${Date.now()}-noreviews`;
  const walkerUid = `fresh-walker-${stamp}`;
  const viewerUid = `fresh-viewer-${stamp}`;

  await adminAuth.createUser({ uid: walkerUid, email: `${walkerUid}@example.com`, emailVerified: true });
  await adminAuth.createUser({ uid: viewerUid, email: `${viewerUid}@example.com`, emailVerified: true });
  await adminDb.collection("users").doc(walkerUid).set({
    profile: { name: "Freshly Listed Walker" },
    role: "walker",
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  await adminDb.collection("walkerProfiles").doc(walkerUid).set({
    approved: true,
    everApproved: true,
    townId: "pauls-valley",
    bio: "A fresh listing with nothing rated yet.",
    hourlyRate: 15,
    serviceRadius: 3,
    availability: "Weekends",
  });
  await adminDb.collection("users").doc(viewerUid).set({
    profile: { name: "Viewer" },
    role: "owner",
    townId: "pauls-valley",
    approved: true,
    everApproved: true,
    agreedToTerms: true,
    confirmedAge18Plus: true,
    createdAt: new Date(),
  });
  const viewerToken = await adminAuth.createCustomToken(viewerUid);

  await signInThenGoTo(page, viewerToken, `/walker.html?uid=${walkerUid}`);
  await expect(page.locator("h1")).toContainText("Freshly Listed Walker");
  // walker.html shows "No reviews yet" in two places when there are none
  // (the rating summary line, and the reviews-list placeholder) — .first()
  // rather than an ambiguous getByText match across both.
  await expect(page.getByText("No reviews yet").first()).toBeVisible();
});
