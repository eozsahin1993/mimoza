import { initDatabase } from '@/data/db';
import { applyCircle } from '@/data/db/circles';
import { applyChildren, applyComment, dropPendingComment, getComments, insertPendingComment, listComments, markCommentDeleted } from '@/data/db/comments';
import { applyRoster } from '@/data/db/members';
import { applyPost } from '@/data/db/posts';

const NOW = 1_700_000_000_000;

// The database is shared across cases in a file, so every id carries the
// case number rather than each one cleaning up after itself.
let next = 0;
function ids() {
  next += 1;
  return { circle: `circle-${next}`, post: `post-${next}`, n: next };
}

async function seed(circle: string, post: string) {
  await applyCircle(
    { circleId: circle, name: 'Family', role: 'admin', notifyLevel: 'all', keyVersion: 1, rosterVersion: 1 },
    NOW
  );
  await applyRoster(
    circle,
    [{ circleId: circle, accountId: 'acc-ali', name: 'Ali', publicKey: 'pk', role: 'member', joinedAt: NOW }],
    NOW
  );
  await applyPost({
    id: post,
    circleId: circle,
    authorId: 'acc-ali',
    caption: 'x',
    createdAt: NOW,
    receivedAt: NOW,
    updatedAt: NOW,
  });
}

function comment(circle: string, post: string, id: string, overrides = {}) {
  return {
    id,
    postId: post,
    circleId: circle,
    authorId: 'acc-ali',
    body: 'nice',
    createdAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await initDatabase();
});

// Names come from the roster rather than being copied onto the comment,
// so renaming yourself updates everything you ever said.
test('a comment resolves its author from the roster', async () => {
  const { circle, post, n } = ids();
  await seed(circle, post);
  await applyComment(comment(circle, post, `comment-1-${n}`));

  const [row] = await listComments(post);
  expect(row.authorName).toBe('Ali');
  expect(row.body).toBe('nice');
});

// The preview the relay carries on a post row is made of real comments.
test('the preview reads back by id', async () => {
  const { circle, post, n } = ids();
  await seed(circle, post);
  await applyComment(comment(circle, post, `preview-1-${n}`));
  await applyComment(comment(circle, post, `other-1-${n}`));

  expect((await getComments([`preview-1-${n}`])).map((row) => row.id)).toEqual([`preview-1-${n}`]);
});

// This device's own comment shows before the relay has confirmed it,
// and stops being pending when it does.
test('a pending comment is confirmed rather than duplicated', async () => {
  const { circle, post, n } = ids();
  await seed(circle, post);
  await insertPendingComment(comment(circle, post, `mine-1-${n}`));

  expect((await listComments(post))[0].pending).toBe(true);

  await applyComment(comment(circle, post, `mine-1-${n}`));
  const rows = await listComments(post);
  expect(rows).toHaveLength(1);
  expect(rows[0].pending).toBe(false);
});

// A children fetch is the whole truth for confirmed comments, but must
// not take a pending one with it.
test('a children fetch replaces confirmed comments and keeps pending ones', async () => {
  const { circle, post, n } = ids();
  await seed(circle, post);
  await applyComment(comment(circle, post, `gone-1-${n}`));
  await insertPendingComment(comment(circle, post, `mine-1-${n}`));

  await applyChildren(post, [comment(circle, post, `fresh-1-${n}`)]);

  expect((await listComments(post)).map((row) => row.id).sort()).toEqual([`fresh-1-${n}`, `mine-1-${n}`]);
});

test('a deleted comment leaves the list and loses its text', async () => {
  const { circle, post, n } = ids();
  await seed(circle, post);
  await applyComment(comment(circle, post, `comment-1-${n}`));
  await markCommentDeleted(`comment-1-${n}`, NOW + 10);

  expect(await listComments(post)).toHaveLength(0);
});

// A write that fails for good drops its optimistic row rather than
// leaving something nobody else can see.
test('a pending comment can be dropped', async () => {
  const { circle, post, n } = ids();
  await seed(circle, post);
  await insertPendingComment(comment(circle, post, `mine-1-${n}`));
  await dropPendingComment(`mine-1-${n}`);

  expect(await listComments(post)).toHaveLength(0);
});
