import { Directory, File, Paths } from 'expo-file-system';

/**
 * Decrypted photos, written once to disk so screens can hand `<Image>` a
 * `file://` path instead of a base64 data URI.
 *
 * A data URI costs on both sides of the bridge every single render: the
 * JS thread base64-encodes the bytes (~85ms for three photos on a Galaxy
 * S10e), then a string of roughly four-thirds the file size is serialized
 * into the native tree and decoded again. Navigating in and out of a
 * feed repeats all of it. A file path costs one write, ever — after that
 * every render passes a short string and the platform decodes off the JS
 * thread, with its own image cache underneath.
 *
 * SQLite stays the source of truth; this is a derived cache, so a cleared
 * cache directory is not a loss — `ensurePhotoUri` simply writes the file
 * again from the bytes it already has.
 */
const PHOTO_DIRECTORY = 'photos';

/** Filename segment for a cover, so one can't collide with a post's id. */
const COVER = 'cover';

function photoFile(circleId: string, entryId: string): File {
  // The relay addresses a blob as (syncId, entryId); locally the same
  // pair is (circleId, entryId), so the name can't collide across circles.
  return new File(new Directory(Paths.cache, PHOTO_DIRECTORY), `${circleId}-${entryId}.jpg`);
}

/** Writes bytes to the cache, replacing whatever was there. Returns the `file://` URI. */
export function writePhotoFile(circleId: string, entryId: string, bytes: Uint8Array): string {
  const directory = new Directory(Paths.cache, PHOTO_DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });

  const file = photoFile(circleId, entryId);
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

/** Drops a cached photo. Safe to call for one that was never written — the cache is derived, so a miss is not an error. */
export function deletePhotoFile(circleId: string, entryId: string): void {
  const file = photoFile(circleId, entryId);
  if (file.exists) file.delete();
}

/**
 * Drops every cached photo belonging to a circle, cover included. Unlike
 * the rest of this module, this one isn't housekeeping a derived cache —
 * it runs when a circle is deleted, and these files are the last decrypted
 * copies of its photos on the device once the rows behind them are gone.
 *
 * Matched by the `circleId-` filename prefix rather than tracked
 * separately, so it can't drift from what `photoFile` actually writes.
 */
export function deleteCirclePhotoFiles(circleId: string): void {
  const directory = new Directory(Paths.cache, PHOTO_DIRECTORY);
  if (!directory.exists) return;
  for (const entry of directory.list()) {
    if (entry instanceof File && entry.name.startsWith(`${circleId}-`)) entry.delete();
  }
}

/**
 * Suffixed with the cover's own id, so a changed cover gets a genuinely
 * different path. Reusing one path for new bytes is invisible to both
 * this cache's "does it exist" check and expo-image's native cache,
 * which key on the string rather than on what is in the file.
 */
function coverFile(circleId: string, hash: string): File {
  const directory = new Directory(Paths.cache, PHOTO_DIRECTORY);
  return new File(directory, `${circleId}-${COVER}-${hash}.jpg`);
}

/**
 * Writes a circle's cover under a hash-versioned path and drops whatever
 * was cached under a different hash — otherwise every cover change this
 * device ever makes or downloads leaves its predecessor behind forever.
 */
export function writeCoverFile(circleId: string, bytes: Uint8Array, hash: string): string {
  const directory = new Directory(Paths.cache, PHOTO_DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });

  const prefix = `${circleId}-${COVER}-`;
  for (const entry of directory.list()) {
    if (entry instanceof File && entry.name.startsWith(prefix) && entry.name !== `${prefix}${hash}.jpg`) {
      entry.delete();
    }
  }

  const file = coverFile(circleId, hash);
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

/** The cover's cached path for this exact hash, or null if it isn't cached under it yet. */
export function cachedCoverUri(circleId: string, hash: string): string | null {
  const file = coverFile(circleId, hash);
  return file.exists ? file.uri : null;
}

/**
 * The cached file's URI, writing it from `readBytes()` only if it isn't
 * already there. `readBytes` is a callback rather than a value so a hit —
 * the overwhelmingly common case — never pulls the bytes out of SQLite
 * and across the bridge at all.
 */
export function ensurePhotoUri(
  circleId: string,
  entryId: string,
  readBytes: () => Uint8Array | null
): string | null {
  const file = photoFile(circleId, entryId);
  if (file.exists) return file.uri;

  const bytes = readBytes();
  if (!bytes) return null;

  return writePhotoFile(circleId, entryId, bytes);
}
