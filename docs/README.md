# Design docs

Architecture and design decisions for Mimoza, kept separate from the
`app/`, `server/` and `landing/` code they describe so no directory's
README has to double as both a map of the code and a design history.

Two documents describe the system, one per half:

- [RELAY_DESIGN.md](RELAY_DESIGN.md) — **the server.** The trust model
  (content is encrypted, membership is not, and what that costs), what
  the relay stores row by row, what each route promises: keys and
  sealing, cursors, joining, push, device hand-off, deletion, telemetry,
  and what was rejected.
- [SYNC_DESIGN.md](SYNC_DESIGN.md) — **the client.** How a device keeps
  in step with the relay: what it keeps locally, the sync pass, cursors,
  the outbox, and the ordering that must hold.

The other two are operational:

- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) — AWS accounts and
  environments, the CloudFront front door, blob delivery, backups, the
  deploy pipelines for the relay, the app and the website
  (`joinmimoza.com`, Cloudflare Pages), cost.
- [LAUNCH_CHECKLIST.md](LAUNCH_CHECKLIST.md) — what stands between here
  and both stores, and which items cost waiting rather than work.
