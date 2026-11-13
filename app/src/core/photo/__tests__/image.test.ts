import { bytesToDataUri, cropRectFor, minZoomFor, parsePictureThumbnail } from '@/core/photo/image';

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

describe('cropRectFor', () => {
  // A 4:3 photo framed in a 350x100 strip: width-bound, so at zoom 1 the
  // strip spans the photo's full width and a 7:2 band of its height.
  const photo = { width: 2000, height: 1500 };
  const strip = { width: 350, height: 100 };

  test('untouched, it takes the middle band at full width', () => {
    expect(cropRectFor(photo, strip, 1, { x: 0, y: 0 })).toEqual({ originX: 0, originY: 465, width: 2000, height: 571 });
  });

  test('dragging the photo down shows more of its top', () => {
    const rect = cropRectFor(photo, strip, 1, { x: 0, y: 50 });
    expect(rect.originY).toBeLessThan(465);
    expect(rect.height).toBe(571);
  });

  test('zooming in takes a proportionally smaller rect around the same centre', () => {
    expect(cropRectFor(photo, strip, 2, { x: 0, y: 0 })).toEqual({ originX: 500, originY: 607, width: 1000, height: 286 });
  });

  test('never reaches outside the photo, whatever offset it is handed', () => {
    const rect = cropRectFor(photo, strip, 2, { x: 10_000, y: -10_000 });
    expect(rect.originX).toBe(0);
    expect(rect.originY).toBe(photo.height - rect.height);
  });

  test('a tall photo is bound by the strip\'s width too, never stretched', () => {
    const rect = cropRectFor({ width: 1000, height: 2000 }, strip, 1, { x: 0, y: 0 });
    expect(rect.width).toBe(1000);
    expect(rect.width / rect.height).toBeCloseTo(3.5, 1);
  });
});

describe('minZoomFor', () => {
  const strip = { width: 350, height: 100 };

  test('lets a landscape photo shrink until its full height fits the strip', () => {
    const zoom = minZoomFor({ width: 2000, height: 1500 }, strip);
    const shown = (strip.width / 2000) * zoom;
    expect(1500 * shown).toBeCloseTo(strip.height);
    expect(2000 * shown).toBeLessThan(strip.width);
  });

  test('lets a portrait photo shrink much further, down to a sliver', () => {
    expect(minZoomFor({ width: 1500, height: 2000 }, strip)).toBeLessThan(minZoomFor({ width: 2000, height: 1500 }, strip));
  });

  test('is 1 for a photo already the strip\'s shape: nothing to fit', () => {
    expect(minZoomFor({ width: 1400, height: 400 }, strip)).toBeCloseTo(1);
  });
});
