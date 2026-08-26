# Architecture & data model

Status: **draft v1** — ported/adapted from a sibling Firebase project (patterns only,
no shared secrets/config). Flagged decisions below need your sign-off before we build
on top of them.

## Stack

- **Hosting:** Firebase Hosting, static files served from `/public` — plain HTML/CSS/JS,
  no build step (matches the source project this was adapted from).
- **Backend:** Firebase Auth, Firestore, Storage, Cloud Functions (Node 20), Stripe.
- **Testing:** Playwright (end-to-end, against Firebase emulators) + `@firebase/rules-unit-testing`
  (Firestore rules unit tests). Mirrors the sibling project's `testing/` setup.
- **CI:** GitHub Actions — runs the test suite against emulators on every push/PR to `main`.

## Collections (Firestore)

| Collection | Purpose | Adapted from |
|---|---|---|
| `users/{uid}` | Core identity for everyone — dog owners and walkers both start here. `role: "owner" \| "walker" \| "both"`. Approval workflow (`approved`/`everApproved`/`rejected`), `agreedToTerms`, `notificationsEnabled`, `fcmTokens`, `lastActiveAt`, `lastKnownIp`. | `users/{uid}` |
| `walkerProfiles/{uid}` | Walker-specific paid listing: bio, service area/radius, hourly rate, availability, `listingPaidUntil` (Stripe-gated, same lock pattern as source). Split from `users` so subscription status stays admin/webhook-only. | `businesses/{uid}` |
| `dogs/{dogId}` | Owner's dog profiles: name, breed, notes, photo, `ownerId`. | new |
| `conversations/{ownerUid}_{walkerUid}` | 1:1 DM thread between an owner and a walker, participants array, `lastMessage` preview. | `conversations/{id}` |
| `conversations/{id}/messages/{messageId}` | Message text (capped length/word count), `senderId`, `createdAt`. Blocked pairs can't send. | same |
| `bookings/{bookingId}` | Walk request: `ownerId`, `walkerId`, `dogIds[]`, requested time window, `status` (`requested`→`accepted`/`declined`→`completed`/`cancelled`), rate, notes. | new — modeled after the source's game-invite request/accept pattern |
| `reviews/{reviewId}` | Post-booking rating/review of a walker, tied to a completed `bookingId`. | `businessReviewQueue` pattern |
| `blocks/{pairId}` | Mutual block between two users — checked before message send and booking request. | `blocks/{pairId}` |
| `reports/{reportId}`, `bugReports/{reportId}` | User safety/bug reports for admin review. | same |
| `messageLimits/{uid}`, `bookingLimits/{uid}` | Per-user rate limiting to stop spam/abuse. | `messageLimits`, `gameInviteLimits` |
| `admins/{uid}` | Admin allowlist for moderation tools. | same |

## Open decisions — need your input

1. **Payment model for bookings.** The source project charges a flat listing fee
   (walker "subscribes" to be listed, like a paid business directory). Rover-style
   apps usually take a cut of each individual booking instead (needs Stripe Connect
   for payouts to walkers, more complex). **v1 draft assumes the simpler listing-fee
   model** (`walkerProfiles.listingPaidUntil`, same as the source's `businessPaidUntil`)
   so we have something working end-to-end; per-booking payment/payout is a v2 item.
2. ~~**Firebase project.** Not created yet~~ — **Resolved:** project is `dw-app-2beee`.
   `.firebaserc` points at it; `public/firebase-init.js` has the web app config (a Web
   app was registered via CLI — `apps:create WEB`) and `public/firebase-messaging-sw.js`
   has the matching config + VAPID key for push. Still need: the project upgraded to
   Blaze (confirmed still on the free plan — `functions:list` came back
   `SERVICE_DISABLED` for Cloud Functions API), Email/Password + Google sign-in enabled
   under Authentication, and, for a deploy-on-merge CI step, a service account key
   stored as a GitHub secret.
3. **"Both" role.** Can one account be both an owner and a walker (like Rover allows)?
   Assumed yes for now — `users.role` supports it.

## What was deliberately left out of this port

The source project's game rooms, leaderboards, daily-rewards sponsor system, and
town/edition multi-tenant build script aren't relevant here and weren't carried over.
Its **security rule patterns** (field-scoped `hasOnly()` update branches, approval-gated
reads, image moderation via Cloud Vision SafeSearch, rate-limit collections) were the
actual reuse target and are reflected in `firestore.rules`.
