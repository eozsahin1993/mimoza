# Design

Why Mimoza is shaped the way it is. `RELAY_DESIGN.md` and
`SYNC_DESIGN.md` say how the two halves work; this is the reasoning
behind them, and what was turned down.

## The claim is content privacy, not metadata privacy

The relay knows who you are, which circles you are in, who else is in
them, and when anything happened. It cannot read a caption, a comment, a
photo, a cover or a reaction's emoji — those are sealed under a
per-circle key it never holds.

An earlier design tried to hide membership too, and paid for it: roughly
nine thousand lines existed to keep the relay from learning who was in
which circle. It only ever held at rest — account id and circle id were
on every request in flight — and it made every failure hard to diagnose,
because the server could not say what had gone wrong with something it
was forbidden to understand.

So the claim is the narrower one, stated plainly rather than implied:
**content is end-to-end encrypted; membership is not.** This is the same
trade WhatsApp asks for, and it is worth naming rather than letting a
marketing page imply otherwise.

## What that buys

The relay can count, order, route and explain. Reaction counts are
server-side, so a card renders from one row. Notification text is
composed centrally, so no notification extension ships and nothing
decrypts on a lock screen. A failed sync says what failed.

## What it costs, named honestly

Two places where the relay holds real authority, both accepted:

- **It could substitute a public key.** An approving member seals content
  keys to whatever key the relay says the joiner published. A compromised
  relay could publish its own and be handed the circle's keys. There is
  no key-transparency log and no safety-number check.
- **It holds an Apple refresh token.** App Store Review Guideline
  5.1.1(v) requires deleting an account to revoke the Sign in with Apple
  grant. Apple only revokes a refresh token and only issues one in
  exchange for an authorization code that dies within minutes — so
  `/v1/auth/apple` banks it at sign-in and `DELETE /v1/account` spends
  it. The relay can therefore act against the Apple account, not just
  the Mimoza one.

Neither is hidden behind a claim the product does not make. A relay that
can delete everything is already trusted with a great deal.

## No escrow, no phrase

There is no recovery phrase and no server-held copy of any key. A new
phone either carries the account keypair across (iCloud Keychain, or
Android's Block Store) or publishes a fresh one and waits: the relay
flags the membership, and the next member of that circle to open the app
reseals every content key version to the new key.

The cost is that recovery needs another member to come online. The
alternative — escrowing key material — would make the content claim
false, which is the one thing the design will not trade.

## Explicitly rejected

- **Contact discovery.** Matching uploaded contact lists against
  registered users means uploading *other people's* numbers, who
  consented to nothing. Doing it privately needs Signal's enclave-based
  service, not a bolt-on. Picking someone from local contacts to send
  them an invite link needs no server at all and is not part of this.
- **Hiding membership from the relay.** See above — the cost was most of
  the codebase and the property did not hold in flight anyway.
- **A recovery phrase or escrowed keys.** Either makes recovery
  self-service at the price of the only claim that matters.
- **Comment text on the lock screen.** Would need an extension that
  decrypts on receipt, which is the thing relay-composed push exists to
  avoid. Possible later as a slim body-only extension.
- **Email/OTP sign-in.** An email-only account has no platform account
  to hang keypair sync on, so it permanently weakens recovery for the
  sake of one fewer tap.
