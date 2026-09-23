const mockFile = {
  create: jest.fn(),
  write: jest.fn(),
  delete: jest.fn(),
  upload: jest.fn(),
};

jest.mock('expo-file-system', () => ({
  File: jest.fn(() => mockFile),
  Paths: { cache: 'mock-cache-dir' },
  UploadType: { MULTIPART: 1, BINARY_CONTENT: 0 },
}));

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: {} } }));

const mockGetAuthToken = jest.fn();
const mockDeleteAuthToken = jest.fn();
jest.mock('@/core/services/keystore/auth-token', () => ({
  getAuthToken: () => mockGetAuthToken(),
  deleteAuthToken: () => mockDeleteAuthToken(),
}));

import Constants from 'expo-constants';

import { BlobAlreadyExistsError, RateLimitedError, SessionExpiredError } from '@/core/services/relay-errors';
import { setSessionExpiredListener } from '@/core/services/session';
import { BlobPaths, getBlob, getUploadTarget, uploadBlob } from '@/core/services/blob-relay';
import { listCircles } from '@/features/circle/services/circle-relay';
import { walkEntries } from '@/features/post/services/post-relay';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

const RELAY_URL = 'http://localhost:8080';
const AUTH_TOKEN = 'test-session-token';

beforeAll(() => {
  process.env.EXPO_PUBLIC_RELAY_URL = RELAY_URL;
});

beforeEach(() => {
  global.fetch = jest.fn();
  jest.clearAllMocks();
  mockGetAuthToken.mockResolvedValue(AUTH_TOKEN);
});

/**
 * The address is inferred, not configured: a dev machine's LAN IP changes
 * with its DHCP lease, and every request would otherwise go to whatever
 * address was last written into .env.
 */
describe('the relay address in development', () => {
  afterEach(() => {
    delete (Constants.expoConfig as { hostUri?: string }).hostUri;
    delete process.env.EXPO_PUBLIC_RELAY_PORT;
    process.env.EXPO_PUBLIC_RELAY_URL = RELAY_URL;
  });

  test('follows the dev server, keeping the configured relay port', async () => {
    (Constants.expoConfig as { hostUri?: string }).hostUri = '192.168.0.126:8081';
    process.env.EXPO_PUBLIC_RELAY_PORT = '8090';
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ circles: [] }));

    await listCircles();

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('http://192.168.0.126:8090/v1/circles');
  });

  // A staging build is a dev build with a packager attached.
  test('keeps a non-loopback URL even with a dev server running', async () => {
    (Constants.expoConfig as { hostUri?: string }).hostUri = '192.168.0.126:8081';
    process.env.EXPO_PUBLIC_RELAY_URL = 'https://staging-api.joinmimoza.com';
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ circles: [] }));

    await listCircles();

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe('https://staging-api.joinmimoza.com/v1/circles');
  });

  test('falls back to the configured URL when there is no dev server to ask', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ circles: [] }));

    await listCircles();

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`${RELAY_URL}/v1/circles`);
  });
});

/**
 * Sessions last 90 days and nothing renews them, so every device still
 * installed by then gets a 401 on its next sync — the token has to go,
 * and someone has to be told, or the app just stops working quietly.
 */
describe('a 401 from the relay', () => {
  afterEach(() => setSessionExpiredListener(null));

  test('drops the dead token and reports the session gone', async () => {
    const expired = jest.fn();
    setSessionExpiredListener(expired);
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 401));

    await expect(listCircles()).rejects.toBeInstanceOf(SessionExpiredError);

    expect(mockDeleteAuthToken).toHaveBeenCalled();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  // A sync pass fans out across circles, so the 401s land together.
  test('reports once however many requests fail at the same time', async () => {
    const expired = jest.fn();
    setSessionExpiredListener(expired);
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 401));

    await Promise.allSettled([
      walkEntries('c1', 'post'),
      walkEntries('c2', 'post'),
      walkEntries('c3', 'post'),
    ]);

    expect(expired).toHaveBeenCalledTimes(1);
  });

  // Anything else keeps its own meaning — 429 is the relay throttling a
  // live session, not disowning it.
  test('leaves other failures alone', async () => {
    const expired = jest.fn();
    setSessionExpiredListener(expired);
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 429));

    await expect(getBlob('c1', 'post-1')).rejects.toBeInstanceOf(RateLimitedError);

    expect(mockDeleteAuthToken).not.toHaveBeenCalled();
    expect(expired).not.toHaveBeenCalled();
  });
});

/**
 * Every blob is addressed as the circle plus the rest of the key, and
 * every key is written once — so a changed cover or picture is a new
 * path rather than a replacement, and the edge can cache them forever.
 */
describe('blob addressing', () => {
  test.each([
    [BlobPaths.photo('post-1'), 'post-1'],
    [BlobPaths.cover('cover-9'), 'cover/cover-9'],
    [BlobPaths.uploadAvatar('avatar-3'), 'avatar/avatar-3'],
    [BlobPaths.avatar('acct-2', 'avatar-3'), 'avatar/acct-2/avatar-3'],
  ])('%s', (path, expected) => {
    expect(path).toBe(expected);
  });
});

describe('getUploadTarget', () => {
  test('asks the relay for a presigned target, authorized by the session alone', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ url: 'https://s3/bucket', fields: { key: 'c1/post-1' } }));

    const result = await getUploadTarget('c1', BlobPaths.photo('post-1'));

    expect(result).toEqual({ url: 'https://s3/bucket', fields: { key: 'c1/post-1' } });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe(`${RELAY_URL}/v1/circles/c1/blobs/post-1/upload-target`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  test('a cover and a picture go to their own paths', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ url: 'https://s3', fields: {} }));

    await getUploadTarget('c1', BlobPaths.cover('cover-9'));
    await getUploadTarget('c1', BlobPaths.uploadAvatar('avatar-3'));

    expect((global.fetch as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
      `${RELAY_URL}/v1/circles/c1/blobs/cover/cover-9/upload-target`,
      `${RELAY_URL}/v1/circles/c1/blobs/avatar/avatar-3/upload-target`,
    ]);
  });

  // The first upload wins, so a 409 on a retry means the earlier attempt
  // actually landed — not a failure.
  test('throws BlobAlreadyExistsError specifically on a 409', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 409));

    await expect(getUploadTarget('c1', 'post-1')).rejects.toBeInstanceOf(BlobAlreadyExistsError);
  });

  test('throws a plain error on a non-409 error status', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 403));

    const err = await getUploadTarget('c1', 'post-1').catch((e) => e);
    expect(err).not.toBeInstanceOf(BlobAlreadyExistsError);
  });

  test('throws RateLimitedError specifically on a 429', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 429));

    await expect(getUploadTarget('c1', 'post-1')).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('getBlob', () => {
  test('follows the signed URL the relay hands back', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse({ url: 'https://cdn/signed' }))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });

    const bytes = await getBlob('c1', BlobPaths.photo('post-1'));

    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`${RELAY_URL}/v1/circles/c1/blobs/post-1`);
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe('https://cdn/signed');
  });

  // Ordinary, not an error: a circle with no cover, a member with no picture.
  test('nothing uploaded there yet is null', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 404));

    expect(await getBlob('c1', BlobPaths.cover('cover-9'))).toBeNull();
  });

  test('throws RateLimitedError specifically on a 429', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 429));

    await expect(getBlob('c1', 'post-1')).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('uploadBlob', () => {
  test('writes the bytes to a temp file, then uploads it with the target\u2019s fields as multipart parameters', async () => {
    mockFile.upload.mockResolvedValue({ status: 200, body: '', headers: {} });
    const fields = { key: 'c1/post-1', 'Content-Type': 'application/octet-stream' };
    const bytes = new Uint8Array([1, 2, 3]);

    await uploadBlob({ url: 'https://s3/bucket', fields }, bytes);

    expect(mockFile.create).toHaveBeenCalledWith({ overwrite: true });
    expect(mockFile.write).toHaveBeenCalledWith(bytes);
    const [url, options] = mockFile.upload.mock.calls[0];
    expect(url).toBe('https://s3/bucket');
    expect(options).toMatchObject({ fieldName: 'file', parameters: fields });
    expect(mockFile.delete).toHaveBeenCalled();
  });

  test('throws when the upload is rejected, and still cleans up the temp file', async () => {
    mockFile.upload.mockResolvedValue({ status: 403, body: '', headers: {} });

    await expect(uploadBlob({ url: 'https://s3/bucket', fields: {} }, new Uint8Array([1]))).rejects.toThrow();

    expect(mockFile.delete).toHaveBeenCalled();
  });
});
