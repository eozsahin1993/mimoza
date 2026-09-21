#!/usr/bin/env bash
# Records what the binaries just built from, so the next push can tell
# whether its JavaScript fits them.
#
# Takes the two fingerprints as arguments; an empty one leaves that
# platform's record alone, which is what happens when only one platform
# needed a build.
set -euo pipefail

ios=${1:-}
android=${2:-}

node -e '
  const fs = require("fs");
  const file = "shipped-fingerprints.json";
  const [ios, android] = process.argv.slice(1);
  const shipped = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({
    ...shipped,
    ...(ios ? { ios } : {}),
    ...(android ? { android } : {}),
  }, null, 2) + "\n");
' "$ios" "$android"

git diff --quiet && { echo "unchanged"; exit 0; }

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"
# [skip ci] belt and braces: this file sits outside the paths the deploy
# workflow watches, so it would not re-trigger anyway.
git commit -qam "chore: record the fingerprints these builds shipped from [skip ci]"
# Another merge may have landed during the twenty minutes this took.
git pull --rebase --quiet origin "$(git rev-parse --abbrev-ref HEAD)"
git push --quiet
