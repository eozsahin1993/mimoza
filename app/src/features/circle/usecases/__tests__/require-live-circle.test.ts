jest.mock('@/core/sync/drain-outbox', () => ({ drainOutbox: jest.fn() }));
jest.mock('@/core/services/analytics', () => ({ logEvent: jest.fn() }));
// The use cases under test reach the device keychain and account keypair,
// which are native modules; none of them is exercised, since each use case
// refuses before it gets that far.
jest.mock('@/core/services/keystore/circle-keys', () => ({
  getCircleKeyMap: jest.fn(),
  getCurrentContentKey: jest.fn(),
  addCircleKeyVersion: jest.fn(),
}));
jest.mock('@/features/circle/usecases/key-exchange', () => ({ sealForEach: jest.fn(() => ({})) }));
jest.mock('@/features/circle/services/circle-relay', () => ({}));
jest.mock('@/core/photo/photo-cache', () => ({ writePhotoFile: jest.fn(), writeCoverFile: jest.fn() }));
jest.mock('@/features/invite/services/invite-relay', () => ({}));

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { applyCircle, initDatabase, markCircleLeft } from '@/data/db';
import { generateUUID } from '@/core/crypto/primitives';
import { requireLiveCircle } from '@/features/circle/usecases/require-live-circle';
import { commentOnPost, deleteComment } from '@/features/post/usecases/comment-on-post';
import { deletePost } from '@/features/post/usecases/delete-post';
import { toggleReaction } from '@/features/post/usecases/react-to-post';
import { setAlbumVisibility } from '@/features/post/usecases/set-album-visibility';
import { renameCircle } from '@/features/circle/usecases/rename-circle';
import { setMemberRole } from '@/features/circle/usecases/change-member-role';
import { removeMember } from '@/features/circle/usecases/remove-member';
import { createPost } from '@/features/post/usecases/create-post';
import { setCoverPhoto } from '@/features/circle/usecases/set-cover-photo';
import {
  approveJoinRequest,
  denyJoinRequest,
  getOrCreateInvite,
  replaceInvite,
} from '@/features/invite/usecases/invite-to-circle';

describe('a circle this account is no longer in', () => {
  let circleId: string;

  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    circleId = generateUUID();
    await applyCircle(
      {
        circleId,
        name: 'Archive',
        createdAt: 1,
        lastEntryAt: 1,
        rosterVersion: 1,
        keyVersion: 1,
        coverId: null,
        coverKeyVersion: null,
        needsRewrap: false,
      } as never,
      1,
    );
    await markCircleLeft(circleId, 2);
  });

  test('refuses to hand the circle out', async () => {
    await expect(requireLiveCircle(circleId)).rejects.toThrow('No longer a member');
    await expect(requireLiveCircle('missing')).rejects.toThrow('No circle');
  });

  // One entry per call of the guard, checked against the source below, so
  // a use case that gains the guard without a line here fails that test.
  const writes: [string, (id: string) => Promise<unknown>][] = [
    ['create post', (id) => createPost({ circleId: id, caption: 'hi', photo: new Uint8Array(1), inAlbum: false })],
    ['comment', (id) => commentOnPost(id, 'p', 'hi')],
    ['delete comment', (id) => deleteComment(id, 'p', 'c')],
    ['react', (id) => toggleReaction(id, 'p', '👍')],
    ['album', (id) => setAlbumVisibility(id, 'p', true)],
    ['delete post', (id) => deletePost(id, 'p')],
    ['rename', (id) => renameCircle(id, 'x')],
    ['cover', (id) => setCoverPhoto(id, new Uint8Array(1))],
    ['role', (id) => setMemberRole(id, 'a', 'admin')],
    ['remove member', (id) => removeMember(id, 'a')],
    ['invite', (id) => getOrCreateInvite(id)],
    ['replace invite', (id) => replaceInvite(id)],
    ['approve request', (id) => approveJoinRequest(id, 'r')],
    ['deny request', (id) => denyJoinRequest(id, 'r')],
  ];

  test.each(writes)('%s is refused locally', async (_name, write) => {
    await expect(write(circleId)).rejects.toThrow('No longer a member');
  });

  test('the list has an entry for every use case that calls the guard', () => {
    const features = join(__dirname, '../../..');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(path);
        } else if (path.includes('/usecases/') && path.endsWith('.ts') && entry.name !== 'require-live-circle.ts') {
          sources.push(readFileSync(path, 'utf8'));
        }
      }
    };
    walk(features);

    const calls = sources.reduce((count, source) => count + (source.match(/await requireLiveCircle\(/g) ?? []).length, 0);
    expect(writes).toHaveLength(calls);
  });
});
