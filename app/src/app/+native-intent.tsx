import { withoutStagingPrefix } from '@/core/services/deep-links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return typeof path === 'string' ? withoutStagingPrefix(path) : path;
}
