#!/usr/bin/env bash
# Records what the binaries just built from, so the next push to the same
# environment can tell whether its JavaScript fits them.
#
# Takes the environment, the two fingerprints and the version; an empty
# fingerprint leaves that platform's record alone, which is what happens
# when only one platform needed a build.
set -euo pipefail

environment=${1:?}
ios=${2:-}
android=${3:-}
version=${4:-}

node -e '
  const fs = require("fs");
  const file = "shipped-fingerprints.json";
  const [environment, ios, android, version] = process.argv.slice(1);
  const shipped = JSON.parse(fs.readFileSync(file, "utf8"));
  shipped[environment] = {
    ...shipped[environment],
    ...(version ? { version } : {}),
    ...(ios ? { ios } : {}),
    ...(android ? { android } : {}),
  };
  fs.writeFileSync(file, JSON.stringify(shipped, null, 2) + "\n");
' "$environment" "$ios" "$android" "$version"

git diff --quiet && { echo "unchanged"; exit 0; }

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
# [skip ci] belt and braces: this file sits outside the paths the deploy
# workflow watches, so it would not re-trigger anyway.
git commit -qam "chore: record the fingerprints these builds shipped from [skip ci]"
# Another merge may have landed during the twenty minutes this took.
git pull --rebase --quiet origin "$(git rev-parse --abbrev-ref HEAD)"
git push --quiet
