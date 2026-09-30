/**
 * FirebaseCrashlytics and FirebaseSessions pull in GoogleDataTransport and
 * nanopb, neither of which defines a Swift module — pod install refuses to
 * link them as static libraries without this. expo-build-properties' own
 * `extraPods` option writes to Podfile.properties.json, but this SDK's
 * Podfile template has no code that reads that key back out, so it
 * silently does nothing; this edits the Podfile directly instead.
 */
const { withPodfile } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

const TAG = 'with-firebase-modular-headers';
const PODS = [
  "pod 'GoogleDataTransport', :modular_headers => true",
  "pod 'nanopb', :modular_headers => true",
];

module.exports = (config) =>
  withPodfile(config, (config) => {
    const { contents } = mergeContents({
      tag: TAG,
      src: config.modResults.contents,
      newSrc: PODS.join('\n'),
      anchor: /use_expo_modules!/,
      offset: 1,
      comment: '#',
    });
    config.modResults.contents = contents;
    return config;
  });
