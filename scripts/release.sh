#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ $# == 0 ]] || { echo 'Usage: scripts/release.sh (always signs and notarizes)' >&2; exit 1; }
command -v gh >/dev/null || { echo 'Install GitHub CLI and run gh auth login first.' >&2; exit 1; }
node scripts/update-appcast.mjs --check-key launcher/sparkle-public-key.txt
VERSION="$(node -p 'require("./package.json").version')"
NOTES="$(mktemp "${TMPDIR:-/tmp}/tokenwise-notes.XXXXXX")"
trap 'rm -f "$NOTES"' EXIT
node --input-type=module - "$VERSION" "$NOTES" <<'JS'
import fs from 'node:fs';
const [version, out] = process.argv.slice(2);
const sections = fs.readFileSync('CHANGELOG.md', 'utf8').split(/^## /m).slice(1);
const section = sections.find(s => s.split('\n')[0].trim() === version || s.startsWith(`${version} (`));
if (!section || /unreleased/i.test(section.split('\n')[0])) throw new Error(`Add a released CHANGELOG section for ${version} first`);
fs.writeFileSync(out, `## ${section.trim()}\n`);
JS
echo "[release] Building, signing and notarizing v$VERSION"
bash scripts/build-dmg.sh
RELEASE_ASSETS=("dist/tokenwise-studio-$VERSION.dmg" "dist/tokenwise-studio.dmg")
if command -v dotnet >/dev/null; then
  NODE_VERSION="$(cat dist/node-release.txt)" bash scripts/build-windows.sh
  RELEASE_ASSETS+=("dist/tokenwise-studio-windows-$VERSION.zip" "dist/tokenwise-studio-windows.zip")
else
  echo '[release] Skipping Windows beta: install SDK with brew install --cask dotnet-sdk'
fi
# Checksums for every asset; the CLI updater requires SHA256SUMS.txt on the release.
( cd dist && shasum -a 256 "${RELEASE_ASSETS[@]#dist/}" > SHA256SUMS.txt )
RELEASE_ASSETS+=("dist/SHA256SUMS.txt")
# Sign only the final, stapled bytes. Use the same account as sparkle-keys.sh.
SIGNATURE="$("$ROOT/.cache/sparkle/sdk/bin/sign_update" --account tokenwise-studio -p "dist/tokenwise-studio-$VERSION.dmg")"
node scripts/update-appcast.mjs "$VERSION" "dist/tokenwise-studio-$VERSION.dmg" "$SIGNATURE" \
  launcher/sparkle-public-key.txt docs/appcast.xml "$NOTES" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo '[release] Appcast updated locally. Publish it only after the GitHub release succeeds.'
echo "[release] Publishing v$VERSION with versioned and stable DMG assets plus Windows zips when built"
gh release create "v$VERSION" "${RELEASE_ASSETS[@]}" \
  --repo OnurSamett/tokenwise-studio --title "tokenwise studio $VERSION" --notes-file "$NOTES"
echo '[release] Release published. Review, commit and push docs/appcast.xml to serve https://tokenwise.site/appcast.xml.'
