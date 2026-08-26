# Dog Walker

A dog walking / pet-care booking app (Rover-style) — profiles, messaging, and bookings, built on Firebase.

## Status

🚧 Early scaffolding. Reusing components/patterns from an existing social media platform codebase (auth, messaging, profiles) where it fits.

## Planned architecture

- **Backend:** Firebase (Auth, Firestore, Storage, Cloud Functions, Cloud Messaging for push)
- **Frontend:** TBD — depends on the stack of the social platform code we're porting from
- **CI/CD:** GitHub Actions — lint, test, build on every PR; branch protection on `main`

## Core features (v1)

- [ ] User profiles (owners + walkers)
- [ ] Search/browse walkers
- [ ] Booking flow (request, accept/decline, schedule)
- [ ] In-app messaging
- [ ] Reviews/ratings
- [ ] Push notifications

## Repo layout (proposed)

```
/docs         — planning notes, architecture decisions
/src          — application source
/public       — static assets
/functions    — Firebase Cloud Functions
/.github/workflows — CI pipelines
```

## Local dev

_Setup instructions go here once the stack is finalized._
