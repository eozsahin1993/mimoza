import { Buffer } from 'buffer';

import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'react-native';

import { generateUUID } from '@/core/crypto/primitives';

/**
 * Long-edge cap and JPEG quality for anything we store or send. The relay
 * never sees plaintext, so this is the only place compression can ever
 * happen — there's no server-side resize step to fall back on. Resolution
 * matters far more than quality percentage for file size, since nobody
 * views a photo at full camera resolution on a phone screen anyway.
 */
const MAX_DIMENSION = 1080;
const JPEG_QUALITY = 0.85;

/**
 * A small avatar-sized thumbnail — for embedding directly inside an
 * encrypted payload that needs to stay small (e.g. a join request's
 * self-reported picture, see domain/usecases/circle/invite-payloads.ts),
 * not for anything ever displayed at more than avatar size.
 */
const THUMBNAIL_MAX_DIMENSION = 96;
const THUMBNAIL_JPEG_QUALITY = 0.5;

/**
 * Generous headroom over what `compressToThumbnail` actually produces
 * (typically a few KB) — high enough that a real 96px thumbnail never
 * gets rejected, low enough to reject anything that isn't one. Bounds
 * what an untrusted peer's `pictureThumbnail`/`picture` field can cost:
 * without this, whoever sends it — a join requester, an existing member
 * broadcasting a profile_update — could hand-craft an oversized value
 * that never actually went through this module's own compression at
 * all, defeating the entire point of using a small thumbnail in the
 * first place (see member-added.ts's doc comment on the DynamoDB
 * per-item limit this exists to stay well under).
 */
const MAX_THUMBNAIL_BYTES = 32 * 1024;

const BASE64_SYNTAX = /^[A-Za-z0-9+/]*={0,2}$/;

/** First three bytes of every JPEG file — the SOI marker plus the start of the mandatory APP0/EXIF segment. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

/**
 * Validates and decodes a base64-encoded picture thumbnail from an
 * untrusted peer — never assume whoever sent it actually ran it through
 * `compressToThumbnail` themselves. Returns null for anything that fails
 * any check (wrong type, malformed base64, oversized once decoded, not
 * actually a JPEG) — every caller treats null the same as "no picture
 * sent," not as an error, so a bad value degrades gracefully instead of
 * discarding whatever else the entry carries.
 */
export function parsePictureThumbnail(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length % 4 !== 0 || !BASE64_SYNTAX.test(value)) return null;

  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  if (bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES) return null;
  if (!JPEG_MAGIC.every((magicByte, i) => bytes[i] === magicByte)) return null;

  return bytes;
}

/** Opens the system image picker. Returns the picked file's local URI, or null if cancelled. */
export async function pickImage(): Promise<string | null> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return null;
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    // Automatic (the default) sometimes asks NSItemProvider for a
    // representation the asset doesn't actually have — e.g. HEIC photos,
    // Live Photos, and the iOS Simulator's seeded library — which throws
    // FailedToReadImageException ("Cannot load representation of type
    // public.png/jpeg"). Compatible always renders through UIImage instead.
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });

  return result.canceled ? null : result.assets[0].uri;
}

function getImageSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
  });
}

export type CompressedImage = {
  /** Local file URI of the compressed copy — cheap to hand straight to <Image>, already resized. */
  uri: string;
  /** Same file's bytes — what actually gets stored/encrypted. */
  bytes: Uint8Array;
};

/**
 * Resizes `uri` so its longer edge is at most `MAX_DIMENSION`, re-encodes it
 * as JPEG at `JPEG_QUALITY`, and returns both the resulting file's URI and
 * its bytes. Caps whichever dimension is larger so a portrait photo doesn't
 * get capped on the wrong axis. Returning the URI too avoids callers that
 * just want to *display* the picture having to round-trip the bytes back
 * through a base64 data-URI when the resized file is already sitting on disk.
 */
export async function compressImage(uri: string): Promise<CompressedImage> {
  const { width, height } = await getImageSize(uri);
  const resize = width >= height ? { width: Math.min(width, MAX_DIMENSION) } : { height: Math.min(height, MAX_DIMENSION) };

  const rendered = await ImageManipulator.manipulate(uri).resize(resize).renderAsync();
  const saved = await rendered.saveAsync({ compress: JPEG_QUALITY, format: SaveFormat.JPEG });

  const bytes = await new File(saved.uri).arrayBuffer();
  return { uri: saved.uri, bytes: new Uint8Array(bytes) };
}

/** Picks an image and returns it already resized/compressed, or null if cancelled. */
export async function pickAndCompressImage(): Promise<CompressedImage | null> {
  const uri = await pickImage();
  return uri ? compressImage(uri) : null;
}

/**
 * Shrinks already-in-memory picture bytes (e.g. a stored profile picture)
 * down to avatar size — for embedding directly inside an encrypted
 * payload that needs to stay small, not for anything ever displayed at
 * more than avatar size. Writes to a temp file and back since
 * `ImageManipulator` operates on a URI, not raw bytes; both temp files are
 * cleaned up before returning.
 */
export async function compressToThumbnail(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new File(Paths.cache, `thumbnail-source-${generateUUID()}`);
  source.create({ overwrite: true });
  source.write(bytes);
  try {
    const { width, height } = await getImageSize(source.uri);
    const resize =
      width >= height ? { width: Math.min(width, THUMBNAIL_MAX_DIMENSION) } : { height: Math.min(height, THUMBNAIL_MAX_DIMENSION) };

    const rendered = await ImageManipulator.manipulate(source.uri).resize(resize).renderAsync();
    const saved = await rendered.saveAsync({ compress: THUMBNAIL_JPEG_QUALITY, format: SaveFormat.JPEG });
    const savedFile = new File(saved.uri);
    try {
      return new Uint8Array(await savedFile.arrayBuffer());
    } finally {
      savedFile.delete();
    }
  } finally {
    source.delete();
  }
}

/**
 * Downloads a remote image (e.g. a sign-in provider's profile photo URL)
 * and runs it through the exact same resize/compress pipeline as a picked
 * one — same output shape, same on-device storage story, nothing about
 * this photo's origin persists past this one fetch.
 */
export async function downloadAndCompressImage(url: string): Promise<CompressedImage> {
  const destination = new Directory(Paths.cache, 'downloaded-profile-photos');
  destination.create({ intermediates: true, idempotent: true });
  const downloaded = await File.downloadFileAsync(url, destination);
  try {
    return await compressImage(downloaded.uri);
  } finally {
    downloaded.delete();
  }
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1];
    const b3 = bytes[i + 2];
    result += BASE64_CHARS[b1 >> 2];
    result += BASE64_CHARS[((b1 & 0x03) << 4) | (b2 === undefined ? 0 : b2 >> 4)];
    result += b2 === undefined ? '=' : BASE64_CHARS[((b2 & 0x0f) << 2) | (b3 === undefined ? 0 : b3 >> 6)];
    result += b3 === undefined ? '=' : BASE64_CHARS[b3 & 0x3f];
  }
  return result;
}

/**
 * Turns stored picture bytes (e.g. `device_profile.picture`) into a URI
 * `<Image>` can render directly. Only worth it for one-off renders like a
 * single avatar — for a scrolling list of many photos, decode-per-render
 * is real overhead a stored file URI avoids (see `CompressedImage.uri`).
 */
export function bytesToDataUri(bytes: Uint8Array, mimeType = 'image/jpeg'): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}
