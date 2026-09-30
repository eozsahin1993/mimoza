/**
 * Builds fixture circles full of photos, comments and reactions against a
 * local testrelay, for staging App Store / Play screenshots. Reuses the
 * app's own crypto and *-relay.ts modules verbatim (see shims/relay.ts for
 * why those need a shim rather than the real one) — every post and seal
 * this script makes is the same shape the app itself would send, so the
 * real app can decrypt everything it seeds without any special-casing.
 *
 * Run: npx tsx --tsconfig scripts/seed/tsconfig.json scripts/seed/seed.ts
 * (or `npm run seed:screenshots`), against a testrelay started with
 * TESTRELAY_RESOURCE_PREFIX set — see docs/LAUNCH_CHECKLIST.md.
 *
 * SEED_AUTO_OPEN_SIMULATOR=true opens each join link on the booted iOS
 * simulator itself (`xcrun simctl openurl`) instead of waiting for you to
 * tap it — only worth it with a simulator already booted and signed in.
 * SEED_AUTO_OPEN_ANDROID=true does the same on an Android emulator over
 * adb; SEED_ANDROID_SERIAL picks one when more than one device is attached.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { encrypt, generateEphemeralKeypair, hashBytes, openSealedBox, sealToPublicKey, type Keypair } from '@/core/crypto/primitives';
import { fromWire, openContent, sealContent, toWire } from '@/core/crypto/content';
import { reactionTag, reactionTagKey } from '@/core/crypto/reaction-tags';
import { generateContentKey } from '@/features/circle/crypto';
import { BlobPaths, getUploadTarget } from '@/core/services/blob-relay';
import { asAccount, configureRelay } from '@/core/services/relay';
import * as accountRelay from '@/features/account/services/account-relay';
import * as circleRelay from '@/features/circle/services/circle-relay';
import * as inviteRelay from '@/features/invite/services/invite-relay';
import * as postRelay from '@/features/post/services/post-relay';

import { fetchPhoto, uploadToPresignedTarget } from './lib/upload';
import { resolveAgo } from './lib/relative-time';

const __dirname = dirname(fileURLToPath(import.meta.url));

type Fixture = {
  people: { id: string; name: string; avatar: string }[];
  you: { join: string[]; promoteToAdmin: string[] };
  circles: {
    id: string;
    name: string;
    admin: string;
    members: string[];
    /** When the admin made the circle — defaults to now. Members join then too, unless `joined` says otherwise. */
    founded?: string;
    joined?: Record<string, string>;
    cover: string;
    /** Where every post in this circle lands — defaults to the feed. */
    visibility?: 'feed' | 'album';
    posts: {
      by: string;
      photo: string;
      caption: string;
      ago: string;
      comments: { by: string; body: string; ago: string }[];
      reactions: { by: string; emoji: string }[];
    }[];
  }[];
};

type Seeded = { id: string; name: string; avatar: string; token: string; accountId: string; keypair: Keypair };

const RELAY_URL = process.env.SEED_RELAY_URL ?? 'http://127.0.0.1:8099';
const WAIT_MINUTES = Number(process.env.SEED_WAIT_MINUTES ?? 10);
// Opt-in: only makes sense with a booted, signed-in simulator or emulator,
// not a physical device.
const AUTO_OPEN_SIMULATOR = process.env.SEED_AUTO_OPEN_SIMULATOR === 'true';
const AUTO_OPEN_ANDROID = process.env.SEED_AUTO_OPEN_ANDROID === 'true';
const ANDROID_SERIAL = process.env.SEED_ANDROID_SERIAL;
const execFileAsync = promisify(execFile);
const KEY_VERSION = 1; // Nothing in this script ever leaves or removes a member, so a circle's key never rotates past its founding version.

async function mintSession(subject: string): Promise<{ token: string; accountId: string }> {
  const token = randomUUID();
  const response = await fetch(`${RELAY_URL}/testonly/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject, token }),
  });
  if (!response.ok) throw new Error(`Failed to mint a session for "${subject}": ${response.status} ${await response.text()}`);
  const { accountId } = (await response.json()) as { accountId: string };
  return { token, accountId };
}

/**
 * Moves the testrelay's store clock so the next writes are stamped at
 * `atMs` — the relay's own receivedAt is what orders a feed and dates a
 * roster, and the `createdAt` inside a sealed post is invisible to it.
 */
async function setRelayClock(atMs: number | null): Promise<void> {
  const offsetMs = atMs === null ? 0 : atMs - Date.now();
  const response = await fetch(`${RELAY_URL}/testonly/clock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offsetMs }),
  });
  if (!response.ok) throw new Error(`Failed to set the relay clock: ${response.status} ${await response.text()}`);
}

async function at<T>(atMs: number, run: () => Promise<T>): Promise<T> {
  await setRelayClock(atMs);
  return run();
}

async function bootstrapPerson(id: string, name: string, avatar: string): Promise<Seeded> {
  const { token, accountId } = await mintSession(id);
  const keypair = generateEphemeralKeypair();
  await asAccount(token, async () => {
    await accountRelay.setName(name);
    await accountRelay.publishPublicKey(toWire(keypair.publicKey));
  });
  return { id, name, avatar, token, accountId, keypair };
}

async function setAvatar(circleId: string, person: Seeded, contentKey: Uint8Array): Promise<void> {
  const photo = await fetchPhoto(person.avatar);
  const avatarId = randomUUID();
  await asAccount(person.token, async () => {
    const target = await getUploadTarget(circleId, BlobPaths.uploadAvatar(avatarId));
    await uploadToPresignedTarget(target, encrypt(photo, contentKey));
    await circleRelay.patchMembership(circleId, person.accountId, { avatarId, keyVersion: KEY_VERSION });
  });
}

/**
 * Every circle any fixture person currently admins, gone — by account,
 * not by name, so a circle renamed or removed from the fixture since the
 * last run doesn't get left behind. Run unconditionally before seeding:
 * the fixture is the source of truth for what should exist, not a diff
 * against whatever the last run happened to create. `--wipe` alone (no
 * reseed after) uses this same pass.
 */
async function wipeEverything(people: Map<string, Seeded>): Promise<void> {
  for (const person of people.values()) {
    await asAccount(person.token, async () => {
      const { circles } = await circleRelay.listCircles();
      for (const existing of circles.filter((c) => c.role === 'admin')) {
        await circleRelay.deleteCircle(existing.circleId);
        console.log(`  deleted "${existing.name}" (${existing.circleId})`);
      }
    });
  }
}

/** `lastWriteAt` is the circle's newest post, comment or reaction — the stamp the list shows and the one your join must not move. */
type SeededCircle = { circleId: string; inviteCode: string; contentKey: Uint8Array; lastWriteAt: number };

async function seedCircle(fixture: Fixture['circles'][number], people: Map<string, Seeded>, now: number): Promise<SeededCircle> {
  const founder = people.get(fixture.admin);
  if (!founder) throw new Error(`Unknown admin "${fixture.admin}" for circle "${fixture.id}"`);
  console.log(`\n${fixture.name}`);

  const founded = fixture.founded ? resolveAgo(fixture.founded, now) : now;
  const contentKey = generateContentKey();
  const circleId = await at(founded, () =>
    asAccount(founder.token, async () => {
      const sealed = sealToPublicKey(contentKey, founder.keypair.publicKey);
      const created = await circleRelay.createCircle(fixture.name, toWire(sealed));
      return created.circleId;
    })
  );
  console.log(`  created ${circleId}`);

  await asAccount(founder.token, async () => {
    const cover = await fetchPhoto(fixture.cover);
    const coverId = randomUUID();
    const target = await getUploadTarget(circleId, BlobPaths.cover(coverId));
    await uploadToPresignedTarget(target, encrypt(cover, contentKey));
    await circleRelay.setCover(circleId, coverId, KEY_VERSION);
  });
  await setAvatar(circleId, founder, contentKey);

  // Minted on real time, not the shifted clock: the invite's expiry is
  // read against the real clock, and this same code is what you join by.
  await setRelayClock(null);
  const inviteCode = await asAccount(founder.token, async () => (await inviteRelay.createInvite(circleId)).code);

  for (const memberId of fixture.members) {
    const member = people.get(memberId);
    if (!member) throw new Error(`Unknown member "${memberId}" in circle "${fixture.id}"`);
    const joinedAgo = fixture.joined?.[memberId];
    const joinedAt = joinedAgo ? resolveAgo(joinedAgo, now) : founded;
    if (joinedAt < founded) throw new Error(`"${memberId}" joins "${fixture.id}" before it was founded`);
    await at(joinedAt, async () => {
      await asAccount(member.token, () => inviteRelay.requestToJoin(inviteCode));
      await asAccount(founder.token, async () => {
        const request = (await inviteRelay.listRequests(circleId)).find((r) => r.status === 'pending' && r.accountId === member.accountId);
        if (!request?.publicKey) throw new Error(`No pending request from "${memberId}" on "${fixture.id}"`);
        const sealed = { [String(KEY_VERSION)]: toWire(sealToPublicKey(contentKey, fromWire(request.publicKey))) };
        await inviteRelay.approveRequest(circleId, request.requestId, sealed);
      });
      await setAvatar(circleId, member, contentKey);
    });
  }

  const tagKey = reactionTagKey(circleId, { [KEY_VERSION]: contentKey })!;

  // Every write bumps the circle's lastEntryAt to its own stamp, so the
  // writes go in time order and the newest one is what the list shows.
  type Write = { at: number; run: () => Promise<void> };
  const writes: Write[] = [];
  for (const post of fixture.posts) {
    const author = people.get(post.by);
    if (!author) throw new Error(`Unknown author "${post.by}" in circle "${fixture.id}"`);
    const createdAt = resolveAgo(post.ago, now);
    if (createdAt < founded) throw new Error(`A post in "${fixture.id}" ("${post.caption.slice(0, 30)}…") predates the circle`);
    const postId = randomUUID();

    writes.push({
      at: createdAt,
      run: async () => {
        const photo = await fetchPhoto(post.photo);
        const photoHash = hashBytes(photo);
        await asAccount(author.token, async () => {
          const target = await getUploadTarget(circleId, BlobPaths.photo(postId));
          await uploadToPresignedTarget(target, encrypt(photo, contentKey));
          const ciphertext = sealContent({ caption: post.caption, createdAt, photoHash }, contentKey);
          await postRelay.putPost(circleId, { entryId: postId, keyVersion: KEY_VERSION, ciphertext, hasBlob: true, visibility: fixture.visibility ?? 'feed' });
        });
        console.log(`  posted "${post.caption.slice(0, 40)}${post.caption.length > 40 ? '…' : ''}"`);
      },
    });

    for (const comment of post.comments) {
      const commenter = people.get(comment.by);
      if (!commenter) throw new Error(`Unknown commenter "${comment.by}" in circle "${fixture.id}"`);
      const commentedAt = resolveAgo(comment.ago, now);
      if (commentedAt < createdAt) throw new Error(`A comment by "${comment.by}" in "${fixture.id}" is older than its post`);
      writes.push({
        at: commentedAt,
        run: () =>
          asAccount(commenter.token, async () => {
            const ciphertext = sealContent({ body: comment.body, createdAt: commentedAt }, contentKey);
            await postRelay.addComment(circleId, postId, { commentId: randomUUID(), keyVersion: KEY_VERSION, ciphertext });
          }),
      });
    }

    post.reactions.forEach((reaction, i) => {
      const reactor = people.get(reaction.by);
      if (!reactor) throw new Error(`Unknown reactor "${reaction.by}" in circle "${fixture.id}"`);
      writes.push({
        // Reactions carry no time of their own; a few minutes after the post keeps them off the list's timestamp.
        at: createdAt + (i + 1) * 60_000,
        run: () =>
          asAccount(reactor.token, async () => {
            const ciphertext = sealContent({ emoji: reaction.emoji }, contentKey);
            await postRelay.react(circleId, postId, { tag: reactionTag(reaction.emoji, tagKey), keyVersion: KEY_VERSION, ciphertext });
          }),
      });
    });
  }

  writes.sort((a, b) => a.at - b.at);
  for (const write of writes) {
    await at(write.at, write.run);
  }
  await setRelayClock(null);
  const lastWriteAt = writes.length > 0 ? writes[writes.length - 1].at : founded;

  await verifyCircle(fixture, people, circleId, contentKey);

  return { circleId, inviteCode, contentKey, lastWriteAt };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Round-trips the actual crypto through a member who only has what the
 * relay handed them — not the founder's own state — so a passing check
 * means the app itself could decrypt this circle, not just that the HTTP
 * calls returned 200.
 */
async function verifyCircle(fixture: Fixture['circles'][number], people: Map<string, Seeded>, circleId: string, contentKey: Uint8Array): Promise<void> {
  const member = people.get(fixture.members[0] ?? fixture.admin)!;
  await asAccount(member.token, async () => {
    const roster = await circleRelay.getRoster(circleId);
    const sealed = roster.keys[String(KEY_VERSION)];
    if (!sealed) throw new Error(`Verification failed: ${member.name} has no sealed key for v${KEY_VERSION} on ${circleId}`);
    const openedKey = openSealedBox(fromWire(sealed), member.keypair);
    if (!bytesEqual(openedKey, contentKey)) throw new Error(`Verification failed: ${member.name}'s opened key does not match the content key on ${circleId}`);

    const page = await postRelay.walkEntries(circleId, 'post', undefined, 1);
    const entry = page.entries[0];
    if (!entry?.ciphertext) throw new Error(`Verification failed: no post to decrypt on ${circleId}`);
    const openedPost = openContent<{ caption: string }>(entry.ciphertext, contentKey);
    if (!openedPost) throw new Error(`Verification failed: ${member.name} could not decrypt a post on ${circleId}`);
    console.log(`  verified: ${member.name} opened the roster key and decrypted "${openedPost.caption.slice(0, 30)}…"`);
  });
}

/** Waits for a join request that isn't one of the fixture's own accounts — the only one left is yours. */
async function waitForYourRequest(founder: Seeded, circleId: string): Promise<{ requestId: string; accountId: string; publicKey: string }> {
  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  while (Date.now() < deadline) {
    const found = await asAccount(founder.token, async () => {
      const pending = await inviteRelay.listRequests(circleId);
      return pending.find((r) => r.status === 'pending' && r.publicKey);
    });
    if (found) return { requestId: found.requestId, accountId: found.accountId, publicKey: found.publicKey! };
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error(`Timed out after ${WAIT_MINUTES}m waiting for your join request on ${circleId}`);
}

/** The photos you pick by hand during the shoot, beside the fixture: fixtures/device-photos.json. */
type DevicePhotos = Record<string, { use: string; url: string }>;

/**
 * Downloads the photos you pick by hand during the shoot and drops them into
 * the booted simulator's or emulator's photo library, so device-photos.json
 * is the one place those URLs live. Without an auto-open flag it only
 * downloads them, and prints where.
 */
async function stageDevicePhotos(fixturePath: string): Promise<void> {
  const path = join(dirname(fixturePath), 'device-photos.json');
  if (!existsSync(path)) return;
  const photos = Object.entries(JSON.parse(readFileSync(path, 'utf-8')) as DevicePhotos);
  if (photos.length === 0) return;

  const dir = join(tmpdir(), 'mimoza-seed-media');
  mkdirSync(dir, { recursive: true });
  console.log('\nPhotos to pick on the device:');
  for (const [name, { url }] of photos) {
    const file = join(dir, `${name}.jpg`);
    writeFileSync(file, await fetchPhoto(url));
    console.log(`  ${name}: ${file}`);

    if (AUTO_OPEN_SIMULATOR) {
      await execFileAsync('xcrun', ['simctl', 'addmedia', 'booted', file]).catch((err) =>
        console.error(`  could not add ${name} to the simulator — drag it in yourself:`, err.message)
      );
    }
    if (AUTO_OPEN_ANDROID) {
      const serial = ANDROID_SERIAL ? ['-s', ANDROID_SERIAL] : [];
      const remote = `/sdcard/Pictures/${name}.jpg`;
      await execFileAsync('adb', [...serial, 'push', file, remote])
        .then(() =>
          execFileAsync('adb', [...serial, 'shell', 'am', 'broadcast', '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE', '-d', `file://${remote}`])
        )
        .catch((err) => console.error(`  could not push ${name} to the emulator — drag it in yourself:`, err.message));
    }
  }
}

async function bringYouIn(fixture: Fixture, seededCircles: Map<string, SeededCircle>, people: Map<string, Seeded>): Promise<void> {
  if (fixture.you.join.length === 0) return;

  console.log(
    AUTO_OPEN_SIMULATOR || AUTO_OPEN_ANDROID
      ? '\nOpening these on the booted simulator or emulator, one at a time:'
      : '\nOpen these on your signed-in device or simulator, one at a time:'
  );
  for (const circleFixtureId of fixture.you.join) {
    const seeded = seededCircles.get(circleFixtureId);
    if (!seeded) throw new Error(`"you.join" names an unknown circle "${circleFixtureId}"`);
    console.log(`  mimoza://join/${seeded.inviteCode}   (${fixture.circles.find((c) => c.id === circleFixtureId)!.name})`);
  }

  for (const circleFixtureId of fixture.you.join) {
    const circleFixture = fixture.circles.find((c) => c.id === circleFixtureId)!;
    const seeded = seededCircles.get(circleFixtureId)!;
    const founder = people.get(circleFixture.admin)!;
    const link = `mimoza://join/${seeded.inviteCode}`;

    if (AUTO_OPEN_SIMULATOR) {
      await execFileAsync('xcrun', ['simctl', 'openurl', 'booted', link]).catch((err) =>
        console.error(`  could not open ${link} on the simulator — open it yourself:`, err.message)
      );
    }
    if (AUTO_OPEN_ANDROID) {
      const serial = ANDROID_SERIAL ? ['-s', ANDROID_SERIAL] : [];
      await execFileAsync('adb', [...serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', link]).catch((err) =>
        console.error(`  could not open ${link} on the emulator — open it yourself:`, err.message)
      );
    }

    console.log(`\nWaiting for your join request on "${circleFixture.name}"...`);
    const request = await waitForYourRequest(founder, seeded.circleId);
    // Approval and promotion both bump the circle's lastEntryAt, so they
    // land on the newest write's stamp rather than pushing it to "now".
    await at(seeded.lastWriteAt, async () => {
      await asAccount(founder.token, async () => {
        const sealed = { [String(KEY_VERSION)]: toWire(sealToPublicKey(seeded.contentKey, fromWire(request.publicKey))) };
        await inviteRelay.approveRequest(seeded.circleId, request.requestId, sealed);
      });
      console.log(`  approved`);

      if (fixture.you.promoteToAdmin.includes(circleFixtureId)) {
        await asAccount(founder.token, () => circleRelay.patchMembership(seeded.circleId, request.accountId, { role: 'admin' }));
        console.log(`  promoted to admin`);
      }
    });
    await setRelayClock(null);
  }
}

async function main(): Promise<void> {
  configureRelay(RELAY_URL);
  const args = process.argv.slice(2);
  const wipeOnly = args.includes('--wipe');
  const fixturePath = args.find((arg) => !arg.startsWith('--')) ?? join(__dirname, 'fixtures', 'screenshots.json');
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;
  const now = Date.now();

  console.log(`${wipeOnly ? 'Wiping' : 'Seeding'} against ${RELAY_URL} from ${fixturePath}`);

  const people = new Map<string, Seeded>();
  for (const person of fixture.people) {
    people.set(person.id, await bootstrapPerson(person.id, person.name, person.avatar));
  }
  console.log(`\n${people.size} accounts ready`);

  console.log('\nClearing whatever these accounts already admin...');
  await wipeEverything(people);

  if (wipeOnly) {
    console.log('\nDone.');
    return;
  }

  const seededCircles = new Map<string, SeededCircle>();
  for (const circleFixture of fixture.circles) {
    seededCircles.set(circleFixture.id, await seedCircle(circleFixture, people, now));
  }

  await stageDevicePhotos(fixturePath);
  await bringYouIn(fixture, seededCircles, people);

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error('\nSeeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => setRelayClock(null).catch(() => undefined));
