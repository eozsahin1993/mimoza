#!/usr/bin/env bash
# Decides whether this push needs new binaries or just new JavaScript.
#
# The fingerprint hashes everything that affects the native build, so an
# unchanged one means the installed binaries can already run this JS.
# shipped-fingerprints.json records what the last binaries were built from.
#
# Both platforms or neither: one native build and one OTA would leave the
# two carrying different code under the same version.
#
# Overrides exist because "can this ship as JS" and "do we want a build"
# are different questions — a version bump for the stores changes no
# native code at all.
set -euo pipefail

force=${FORCE:-none}
is_release=${IS_RELEASE:-false}
message=$(git log -1 --pretty=%B)
build=false

for platform in ios android; do
  # Accumulated rather than parsed per chunk: a fingerprint is ~65KB of
  # JSON, so stdin arrives in pieces and the first is not valid on its own.
  hash=$(npx expo-updates fingerprint:generate --platform "$platform" |
    node -e 'let out = ""; process.stdin.on("data", d => out += d).on("end", () => process.stdout.write(JSON.parse(out).hash))')
  echo "$platform-fingerprint=$hash" >> "$GITHUB_OUTPUT"

  if [ "$is_release" = true ] || [ "$force" = both ] || [ "$force" = "$platform" ] || [[ "$message" == *"[build]"* ]]; then
    echo "$platform: build requested"
    build=true
    continue
  fi

  shipped=$(node -e 'process.stdout.write(require("../shipped-fingerprints.json")[process.argv[1]] || "")' "$platform")
  if [ "$hash" = "$shipped" ]; then
    echo "$platform: $hash already shipped"
  else
    echo "$platform: $hash is new, native build needed"
    build=true
  fi
done

echo "build-ios=$build" >> "$GITHUB_OUTPUT"
echo "build-android=$build" >> "$GITHUB_OUTPUT"
[ "$build" = true ] && echo "→ building both" || echo "→ JS only"
