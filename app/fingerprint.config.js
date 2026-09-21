const { SourceSkips } = require('@expo/fingerprint');

/**
 * `extra` carries per-run values — jsBuild is the CI run that exported the
 * bundle — and none of it reaches native code. Left in, every run hashes
 * differently: the build-or-update gate always says "native change", and
 * an update published by one run can never match a binary built by
 * another, because its runtime version embeds the other run's number.
 *
 * @type {import('@expo/fingerprint').Config}
 */
module.exports = {
  sourceSkips: SourceSkips.ExpoConfigExtraSection,
};
