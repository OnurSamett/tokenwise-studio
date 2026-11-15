#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
log() { printf '\n[build-dmg] %s\n' "$*"; }
fail() { printf '\n[build-dmg] ERROR: %s\n' "$*" >&2; exit 1; }
SKIP_NOTARIZE=0
DRY_RUN=0
PREPARE_SPARKLE=0
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --prepare-sparkle) PREPARE_SPARKLE=1 ;;
    --help) echo 'Usage: scripts/build-dmg.sh [--skip-notarize] [--dry-run] [--prepare-sparkle]'; echo '--dry-run prepares an unsigned app and stops BEFORE codesign/keychain access.'; exit 0 ;;
    *) fail "Unknown option: $arg" ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || fail 'Build the DMG on macOS with Xcode command line tools.'
for tool in node npm curl shasum tar file lipo xcrun swiftc sips iconutil hdiutil codesign ditto; do
  command -v "$tool" >/dev/null || fail "Missing tool: $tool (install Node and Xcode command line tools)."
done
xcrun --find swiftc >/dev/null
VERSION="$(node -p 'require("./package.json").version')"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail 'Invalid package version'
IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: [redacted] ([redacted])}"
DIST="$ROOT/dist"
CACHE="${TOKENWISE_NODE_CACHE:-$ROOT/.cache/node}"
mkdir -p "$DIST" "$CACHE"
WORK="$(mktemp -d "$DIST/.dmg-build.XXXXXX")"
trap 'build_exit_code=$?; rm -rf "$WORK"; if (( build_exit_code != 0 )); then printf "\n[build-dmg] Failed; no release was published.\n" >&2; fi' EXIT
APP="$WORK/stage/tokenwise studio.app"
DMG="$DIST/tokenwise-studio-$VERSION.dmg"
STABLE="$DIST/tokenwise-studio.dmg"
# Never leave old artifacts available for accidental publication after a failed rebuild.
if (( ! PREPARE_SPARKLE )); then rm -f "$DMG" "$STABLE"; fi
fetch() {
  curl --fail --show-error --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 600 "$1" -o "$2.part"
  mv "$2.part" "$2"
}
# Pin the exact upstream binary distribution; NEVER execute its tools before verification.
SPARKLE_VERSION='2.8.1'
# TODO: fill with the official SHA-256 for Sparkle-2.8.1.tar.xz from this release:
# https://github.com/sparkle-project/Sparkle/releases/tag/2.8.1
SPARKLE_SHA256='5cddb7695674ef7704268f38eccaee80e3accbf19e61c1689efff5b6116d85be'
[[ "$SPARKLE_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'Fill SPARKLE_SHA256 in scripts/build-dmg.sh with the official release checksum first.'
SPARKLE_DIR="$ROOT/.cache/sparkle/sdk"
SPARKLE_ARCHIVE="$ROOT/.cache/sparkle/Sparkle-$SPARKLE_VERSION.tar.xz"
mkdir -p "$(dirname "$SPARKLE_ARCHIVE")"
[[ -f "$SPARKLE_ARCHIVE" ]] || fetch "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz" "$SPARKLE_ARCHIVE"
[[ "$(shasum -a 256 "$SPARKLE_ARCHIVE" | awk '{print $1}')" == "$SPARKLE_SHA256" ]] || fail "Sparkle checksum mismatch: delete $SPARKLE_ARCHIVE and retry."
# Re-extract even cached SDKs so tools/framework always come from the verified archive.
rm -rf "$SPARKLE_DIR"
mkdir -p "$SPARKLE_DIR"
tar -xf "$SPARKLE_ARCHIVE" -C "$SPARKLE_DIR"
[[ -d "$SPARKLE_DIR/Sparkle.framework" && -x "$SPARKLE_DIR/bin/generate_keys" && -x "$SPARKLE_DIR/bin/sign_update" ]] || fail 'Unexpected Sparkle archive layout.'
log "Verified Sparkle $SPARKLE_VERSION at $SPARKLE_DIR"
if (( PREPARE_SPARKLE )); then exit 0; fi
# Validate before downloading Node or compiling; this file contains PUBLIC key material only.
node scripts/update-appcast.mjs --check-key launcher/sparkle-public-key.txt
log '1/8 Resolve official Node LTS (NODE_VERSION=x.y.z optionally pins a release)'
fetch https://nodejs.org/dist/index.json "$WORK/node-index.json"
NODE_RELEASE="$(node scripts/select-node.mjs "$WORK/node-index.json" package.json "${NODE_VERSION:-}")"
printf '%s\n' "$NODE_RELEASE" > "$DIST/node-release.txt"
BASE="https://nodejs.org/dist/$NODE_RELEASE"
mkdir -p "$CACHE/$NODE_RELEASE"
fetch "$BASE/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
log "2/8 Download/cache and verify $NODE_RELEASE arm64 + x64 archives"
for arch in arm64 x64; do
  archive="node-$NODE_RELEASE-darwin-$arch.tar.gz"
  cached="$CACHE/$NODE_RELEASE/$archive"
  [[ -f "$cached" ]] || fetch "$BASE/$archive" "$cached"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$WORK/SHASUMS256.txt")"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "No valid SHASUMS256 entry for $archive"
  actual="$(shasum -a 256 "$cached" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || fail "Checksum mismatch: $cached; delete it and retry."
  tar -xzf "$cached" -C "$WORK"
done
log '3/8 Build the universal Swift app (no signing, registration or launch)'
mkdir -p "$WORK/stage"
node --input-type=module - "$APP" "$SPARKLE_DIR" <<'JS'
import fs from 'node:fs';
import { buildApp } from './src/cli.js';
buildApp(process.argv[2], { selfContained: true, sparkleDir: process.argv[3], sparklePublicKey: fs.readFileSync('launcher/sparkle-public-key.txt', 'utf8').trim() });
JS
FRAMEWORK="$APP/Contents/Frameworks/Sparkle.framework"
mkdir -p "$APP/Contents/Frameworks"
ditto "$SPARKLE_DIR/Sparkle.framework" "$FRAMEWORK"
RES="$APP/Contents/Resources"
mkdir -p "$RES/app" "$RES/node/bin"
lipo -create "$WORK/node-$NODE_RELEASE-darwin-arm64/bin/node" "$WORK/node-$NODE_RELEASE-darwin-x64/bin/node" -output "$RES/node/bin/node"
chmod 755 "$RES/node/bin/node"
# Official runtime redistribution license includes Node's third-party notices.
cp "$WORK/node-$NODE_RELEASE-darwin-arm64/LICENSE" "$RES/node/LICENSE"
log '4/8 Copy the app and install production dependencies from package-lock.json'
for entry in src ui assets launcher package.json package-lock.json LICENSE; do
  ditto "$ROOT/$entry" "$RES/app/$entry"
done
(cd "$RES/app" && npm ci --omit=dev --no-audit --no-fund)
printf '%s\n' "$NODE_RELEASE" > "$RES/app/.bundled"
printf '%s\n' "$NODE_RELEASE" > "$RES/node/version.txt"
# Check relative config resolution and the bundled JS without launching the GUI or a server.
"$RES/node/bin/node" "$RES/app/src/cli.js" --version
for f in "$RES/node/bin/node" "$APP/Contents/MacOS/tokenwise-studio"; do a="$(lipo -archs "$f")"; [[ " $a " == *" arm64 "* && " $a " == *" x86_64 "* ]] || { echo "Not universal: $f ($a)" >&2; exit 1; }; done
if (( DRY_RUN )); then
  log 'DRY RUN: reached the signing/keychain boundary; nothing was signed, notarized or uploaded.'
  rm -rf "$DIST/unsigned"
  ditto "$APP" "$DIST/unsigned/tokenwise studio.app"
  log "Unsigned app available at: $DIST/unsigned/tokenwise studio.app"
  exit 0
fi
log "5/8 Sign every Mach-O, then the app: $IDENTITY"
# Sign nested code first, rather than relying on --deep signing. No library-validation bypass:
# production deps are JS; any bundled native code is signed with our own team identity.
while IFS= read -r -d '' binary; do
  if file -b "$binary" | /usr/bin/grep -q 'Mach-O'; then
    entitlements=""
    if [[ "$binary" == "$RES/node/bin/node" ]]; then
      entitlements="$ROOT/scripts/node-entitlements.plist"
    elif [[ "$binary" == "$APP/Contents/MacOS/tokenwise-studio" ]]; then
      entitlements="$ROOT/scripts/launcher-entitlements.plist"
    fi
    if [[ -n "$entitlements" ]]; then
      codesign --force --options runtime --timestamp --sign "$IDENTITY" --entitlements "$entitlements" "$binary"
    else
      codesign --force --options runtime --timestamp --sign "$IDENTITY" "$binary"
    fi
  fi
done < <(find "$APP/Contents" -path "$APP/Contents/Frameworks" -prune -o -type f -print0)
# Sparkle's documented inside-out signing order. Preserve Downloader's upstream entitlements
# (2.6+); do not propagate Node or launcher entitlements into Sparkle helpers.
SPARKLE_CODE="$FRAMEWORK/Versions/B"
for service in "$SPARKLE_CODE"/XPCServices/*.xpc; do
  [[ -d "$service" ]] || fail 'Expected Sparkle XPC services are missing.'
  if [[ "$(basename "$service")" == Downloader.xpc ]]; then
    codesign --force --options runtime --timestamp --sign "$IDENTITY" --preserve-metadata=entitlements "$service"
  else
    codesign --force --options runtime --timestamp --sign "$IDENTITY" "$service"
  fi
done
for nested in "$SPARKLE_CODE/Autoupdate" "$SPARKLE_CODE/Updater.app" "$FRAMEWORK"; do
  [[ -e "$nested" ]] || fail "Missing Sparkle code: $nested"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$nested"
done
codesign --force --options runtime --timestamp --sign "$IDENTITY" --entitlements "$ROOT/scripts/launcher-entitlements.plist" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
# Exercise V8 after hardened-runtime signing as well (both slices need real-hardware release QA).
"$RES/node/bin/node" -e 'let f = x => x + 1; for (let i = 0; i < 100000; i++) f(i); console.log("Signed Node JIT smoke check passed")'
log '6/8 Create and sign the DMG (plain Finder layout, Applications shortcut)'
ln -s /Applications "$WORK/stage/Applications"
hdiutil create -volname 'tokenwise studio' -srcfolder "$WORK/stage" -ov -format UDZO "$DMG"
codesign --force --options runtime --timestamp --sign "$IDENTITY" "$DMG"
codesign --verify --verbose=2 "$DMG"
if (( SKIP_NOTARIZE )); then
  log '7/8 SKIPPED notarization (--skip-notarize); local test artifact only'
  log '8/8 SKIPPED staple/Gatekeeper assessment (requires notarization)'
else
  log '7/8 Submit to Apple and wait (keychain profile: tokenwise)'
  xcrun notarytool submit "$DMG" --keychain-profile tokenwise --wait
  log '8/8 Staple, validate and assess the notarized DMG'
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl -a -t open --context context:primary-signature -vv "$DMG"
fi
# Copy only after all requested checks pass; both release URLs deliver identical bytes.
cp "$DMG" "$STABLE"
log "Done: $DMG and $STABLE"
