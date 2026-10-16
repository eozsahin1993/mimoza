import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  clearCirclePhotos,
  clearProfilePictureUri,
  getPhotoStoreState,
  resetPhotoStore,
  setCoverUri,
  setPostPhotoUri,
  setProfilePictureUri,
} from '@/core/photo/photo-store';
import { useProfilePictureUri } from '@/core/photo/use-photo-uri';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  resetPhotoStore();
});

describe('the store', () => {
  test('starts empty, and a reset puts it back that way', () => {
    setProfilePictureUri('a', 'file://a');
    setCoverUri('c1', 'file://c1');
    setPostPhotoUri('c1', 'p1', 'file://p1');

    resetPhotoStore();

    expect(getPhotoStoreState()).toEqual({ profilePictures: {}, postPhotos: {}, covers: {} });
  });

  test('a clear is recorded as null, not forgotten — it has to beat a stale fallback', () => {
    setProfilePictureUri('a', 'file://a');
    clearProfilePictureUri('a');

    expect(getPhotoStoreState().profilePictures).toEqual({ a: null });
  });

  test('forgetting a circle takes its cover and its posts, and nothing of another circle', () => {
    setCoverUri('c1', 'file://c1');
    setCoverUri('c2', 'file://c2');
    setPostPhotoUri('c1', 'p1', 'file://c1-p1');
    setPostPhotoUri('c2', 'p1', 'file://c2-p1');
    setProfilePictureUri('a', 'file://a');

    clearCirclePhotos('c1');

    expect(getPhotoStoreState().covers).toEqual({ c2: 'file://c2' });
    expect(getPhotoStoreState().postPhotos).toEqual({ 'c2/p1': 'file://c2-p1' });
    expect(getPhotoStoreState().profilePictures).toEqual({ a: 'file://a' });
  });
});

describe('the hooks', () => {
  let renderer: ReactTestRenderer;
  const renders: Record<string, number> = {};
  const seen: Record<string, string | undefined> = {};

  /** One avatar: follows `accountId`, renders `initial` until something lands. */
  function Host({ accountId, initial }: { accountId: string; initial?: string }) {
    const uri = useProfilePictureUri(accountId, initial);
    renders[accountId] = (renders[accountId] ?? 0) + 1;
    useEffect(() => {
      seen[accountId] = uri;
    });
    return null;
  }

  function hosts(initialA: string | undefined) {
    return createElement('div', null, createElement(Host, { accountId: 'a', initial: initialA }), createElement(Host, { accountId: 'b' }));
  }

  beforeEach(() => {
    for (const key of Object.keys(renders)) delete renders[key];
    for (const key of Object.keys(seen)) delete seen[key];
    act(() => {
      renderer = create(hosts('file://a-cold'));
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
  });

  test('shows the cold read until a picture lands, then the landed one', () => {
    expect(seen.a).toBe('file://a-cold');
    expect(seen.b).toBeUndefined();

    act(() => setProfilePictureUri('a', 'file://a-live'));

    expect(seen.a).toBe('file://a-live');
  });

  // The changed row may render more than once (useLatest notes which side
  // moved during render); what matters is that the other row renders not at all.
  test('only the avatar whose picture landed re-renders', () => {
    const before = { a: renders.a, b: renders.b };

    act(() => setProfilePictureUri('b', 'file://b'));

    expect(renders.b).toBeGreaterThan(before.b);
    expect(renders.a).toBe(before.a);
    expect(seen.b).toBe('file://b');
  });

  test('a removal wins over the cold read, rather than falling back to it', () => {
    act(() => clearProfilePictureUri('a'));

    expect(seen.a).toBeUndefined();
  });

  // Every writer lands in SQLite before the store, so a later cold read is
  // never behind it — and a path that writes bytes without touching the
  // store must still be seen, rather than shadowed for the whole session.
  test('a fresh cold read after a landing wins, and a later landing wins again', () => {
    act(() => setProfilePictureUri('a', 'file://a-live'));
    expect(seen.a).toBe('file://a-live');

    act(() => renderer.update(hosts('file://a-reread')));
    expect(seen.a).toBe('file://a-reread');

    act(() => setProfilePictureUri('a', 'file://a-newer'));
    expect(seen.a).toBe('file://a-newer');
  });

  test('a cold read that comes back empty after a removal stays empty', () => {
    act(() => clearProfilePictureUri('a'));
    act(() => renderer.update(hosts(undefined)));

    expect(seen.a).toBeUndefined();
  });
});
