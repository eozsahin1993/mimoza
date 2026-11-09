// Staging's links carry /staging after the host so a phone with both apps
// opens the right one (app.config.ts withInviteLinks). Past that prefix they
// are production's paths, so dropping it routes them to the same screens.
const STAGING_PREFIX = /^((?:https?:\/\/[^/]+)?)\/staging(?=\/)/;

export function withoutStagingPrefix(url: string): string {
  return url.replace(STAGING_PREFIX, '$1');
}
