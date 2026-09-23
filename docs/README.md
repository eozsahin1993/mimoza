# Design docs

Architecture and design decisions for Mimoza, kept separate from the
`server/` and `app/` code they describe so neither directory's README has
to double as both a map of the code and a design history.

- [RELAY_DESIGN.md](RELAY_DESIGN.md) — what the relay stores and what its
  routes promise: accounts and circles tables, sealed keys, cursors,
  joining, push, new devices, deletion.
- [SYNC_DESIGN.md](SYNC_DESIGN.md) — the other half: how a device keeps
  in step, what it keeps locally, cursors and the outbox.
- [DESIGN.md](DESIGN.md) — the reasoning behind the shape: what is
  encrypted, what the relay is trusted with, and why.
- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) — accounts, environments, the
  CloudFront front door, blob delivery, deploys, cost.
- [STAGING_CHECKLIST.md](STAGING_CHECKLIST.md) — cutting an internal
  build: what to run, and what a wrong-environment build looks like.
- [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) — what stands between here
  and both stores, and which items cost waiting rather than work.
