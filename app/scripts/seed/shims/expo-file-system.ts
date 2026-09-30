/**
 * Stands in for expo-file-system: core/services/blob-relay.ts imports
 * File/Paths/UploadType at module scope for its own uploadBlob, which the
 * seed script never calls (lib/upload.ts posts straight to the presigned
 * target with Node's fetch instead). Typed to match uploadBlob's calls so
 * the real file still type-checks; never actually invoked.
 */
export class File {
  constructor(..._args: unknown[]) {}
  create(..._args: unknown[]): void {
    throw new Error('expo-file-system.File is a seed-script stub — see lib/upload.ts instead.');
  }
  write(..._args: unknown[]): void {
    throw new Error('expo-file-system.File is a seed-script stub — see lib/upload.ts instead.');
  }
  async upload(..._args: unknown[]): Promise<{ status: number; body: string }> {
    throw new Error('expo-file-system.File is a seed-script stub — see lib/upload.ts instead.');
  }
  delete(..._args: unknown[]): void {
    throw new Error('expo-file-system.File is a seed-script stub — see lib/upload.ts instead.');
  }
}
export const Paths = { cache: '' };
export const UploadType = { MULTIPART: 'multipart' };
