#!/usr/bin/env bash
# Decides whether this push needs new binaries or just new JavaScript.
#
# The fingerprint hashes everything that affects the native build, so an
# unchanged one means the installed binaries can already run this JS.
# shipped-fingerprints.json records what the last binaries were built from.
#
# Overrides exist because "can this ship as JS" and "do we want a build"
# are different questions — a version bump for the stores changes no
# native code at all.
set -euo pipefail

force=${FORCE:-none}
is_release=${IS_RELEASE:-false}
message=$(git log -1 --pretty=%B)

for platform in ios android; do
  hash=$(npx expo-updates fingerprint:generate --platform "$platform" |
    node -e 'process.stdin.on("data", d => process.stdout.write(JSON.parse(d).hash))')
  echo "$platform-fingerprint=$hash" >> "$GITHUB_OUTPUT"

  if [ "$is_release" = true ] || [ "$force" = both ] || [ "$force" = "$platform" ] || [[ "$message" == *"[build]"* ]]; then
    echo "$platform: build requested, fingerprint not consulted"
    echo "build-$platform=true" >> "$GITHUB_OUTPUT"
    continue
  fi

  shipped=$(node -e 'process.stdout.write(require("../shipped-fingerprints.json")[process.argv[1]] || "")' "$platform")
  if [ "$hash" = "$shipped" ]; then
    echo "$platform: $hash already shipped, JS only"
    echo "build-$platform=false" >> "$GITHUB_OUTPUT"
  else
    echo "$platform: $hash is new, native build needed"
    echo "build-$platform=true" >> "$GITHUB_OUTPUT"
  fi
done
