import { bytesToDataUri, parsePictureThumbnail } from '@/core/photo/image';

const JPEG_HEADER = [0xff, 0xd8, 0xff];

function jpegBytes(bodyLength: number): Uint8Array {
  return new Uint8Array([...JPEG_HEADER, ...Array(bodyLength).fill(0)]);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

test('accepts a small, real JPEG-shaped thumbnail', () => {
  const bytes = jpegBytes(100);

  expect(parsePictureThumbnail(toBase64(bytes))).toEqual(bytes);
});

test('rejects a non-string value outright', () => {
  expect(parsePictureThumbnail(42)).toBeNull();
  expect(parsePictureThumbnail(undefined)).toBeNull();
  expect(parsePictureThumbnail(null)).toBeNull();
  expect(parsePictureThumbnail({})).toBeNull();
});

test('encodes bytes as a data URI', () => {
  expect(bytesToDataUri(new Uint8Array([1, 2, 3]))).toBe('data:image/jpeg;base64,AQID');
});

test('a repeat call with the very same array stays correct once memoized', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  expect(bytesToDataUri(bytes)).toBe(bytesToDataUri(bytes));
});

test('rejects an empty string', () => {
  expect(parsePictureThumbnail('')).toBeNull();
});

test('rejects malformed base64 — invalid characters', () => {
  expect(parsePictureThumbnail('not!valid@base64#chars')).toBeNull();
});

test('rejects malformed base64 — length not a multiple of 4', () => {
  expect(parsePictureThumbnail('abcde')).toBeNull();
});

test('rejects decoded bytes that are not a JPEG', () => {
  const notAJpeg = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic, not JPEG
  expect(parsePictureThumbnail(toBase64(notAJpeg))).toBeNull();
});

test('rejects a decoded payload over the size limit', () => {
  const tooLarge = jpegBytes(33 * 1024); // > 32KB cap

  expect(parsePictureThumbnail(toBase64(tooLarge))).toBeNull();
});

test('accepts a decoded payload right at the size limit', () => {
  const atLimit = jpegBytes(32 * 1024 - JPEG_HEADER.length);

  expect(parsePictureThumbnail(toBase64(atLimit))).toEqual(atLimit);
});
