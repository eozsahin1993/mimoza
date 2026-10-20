#!/usr/bin/env bash
# Decides whether this push needs new binaries or just new JavaScript.
#
# The fingerprint hashes everything that affects the native build, so an
# unchanged one means the installed binaries can already run this JS.
# shipped-fingerprints.json records, per environment, what the last
# binaries were built from — staging's hashes say nothing about
# production's, since each environment's config hashes differently.
#
# Both platforms or neither: one native build and one OTA would leave the
# two carrying different code under the same version.
#
# The fingerprint deliberately ignores app.json's version, so a bump
# alone would ship as an update to binaries still labelled with the old
# one. A store release needs a binary that carries the new version, so a
# changed version is a native build too.
#
# Overrides exist because "can this ship as JS" and "do we want a build"
# are different questions.
set -euo pipefail

environment=${ENVIRONMENT:?}
force=${FORCE:-none}
message=$(git log -1 --pretty=%B)
native_build=false

shipped() {
  node -e 'process.stdout.write((require("../shipped-fingerprints.json")[process.argv[1]] || {})[process.argv[2]] || "")' "$environment" "$1"
}

version=$(node -p 'require("./app.json").expo.version')
echo "version=$version" >> "$GITHUB_OUTPUT"
if [ "$version" != "$(shipped version)" ]; then
  echo "version $version has not shipped to $environment, native build needed"
  native_build=true
fi

for platform in ios android; do
  # Accumulated rather than parsed per chunk: a fingerprint is ~65KB of
  # JSON, so stdin arrives in pieces and the first is not valid on its own.
  hash=$(npx expo-updates fingerprint:generate --platform "$platform" |
    node -e 'let out = ""; process.stdin.on("data", d => out += d).on("end", () => process.stdout.write(JSON.parse(out).hash))')
  echo "$platform-fingerprint=$hash" >> "$GITHUB_OUTPUT"

  if [ "$force" = both ] || [ "$force" = "$platform" ] || [[ "$message" == *"[build]"* ]]; then
    echo "$platform: build requested"
    native_build=true
    continue
  fi

  if [ "$hash" = "$(shipped "$platform")" ]; then
    echo "$platform: $hash already shipped to $environment"
  else
    echo "$platform: $hash is new to $environment, native build needed"
    native_build=true
  fi
done

echo "native-build=$native_build" >> "$GITHUB_OUTPUT"
[ "$native_build" = true ] && echo "→ building both" || echo "→ JS only"
