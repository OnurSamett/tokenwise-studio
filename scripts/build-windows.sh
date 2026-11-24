#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail() { printf '[build-windows] ERROR: %s\n' "$*" >&2; exit 1; }
command -v dotnet >/dev/null || fail 'Install the .NET 8 SDK or newer: brew install --cask dotnet-sdk; then rerun scripts/build-windows.sh'
[[ $# == 0 ]] || fail 'Usage: scripts/build-windows.sh (optional NODE_VERSION=x.y.z)'
[[ "$(uname -s)" == Darwin ]] || fail 'Run this cross-build script on macOS.'
for tool in node npm curl shasum unzip zip sips; do command -v "$tool" >/dev/null || fail "Missing tool: $tool"; done
VERSION="$(node -p 'require("./package.json").version')"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]] || fail 'Invalid package version'
DIST="$ROOT/dist"
CACHE="${TOKENWISE_NODE_CACHE:-$ROOT/.cache/node}"
NAME="tokenwise-studio-windows-$VERSION"
mkdir -p "$DIST" "$CACHE"
WORK="$(mktemp -d "$DIST/.windows-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
rm -f "$DIST/$NAME.zip" "$DIST/tokenwise-studio-windows.zip"
fetch() {
  curl --fail --show-error --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 15 --max-time 600 "$1" -o "$2.part"
  mv "$2.part" "$2"
}
# Identical selection algorithm and NODE_VERSION override as build-dmg.sh.
fetch https://nodejs.org/dist/index.json "$WORK/node-index.json"
NODE_RELEASE="$(node scripts/select-node.mjs "$WORK/node-index.json" package.json "${NODE_VERSION:-}")"
BASE="https://nodejs.org/dist/$NODE_RELEASE"
ARCHIVE="node-$NODE_RELEASE-win-x64.zip"
mkdir -p "$CACHE/$NODE_RELEASE"
fetch "$BASE/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
[[ -f "$CACHE/$NODE_RELEASE/$ARCHIVE" ]] || fetch "$BASE/$ARCHIVE" "$CACHE/$NODE_RELEASE/$ARCHIVE"
expected="$(awk -v name="$ARCHIVE" '$2 == name { print $1 }' "$WORK/SHASUMS256.txt")"
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail "Missing SHASUMS256 entry for $ARCHIVE"
[[ "$(shasum -a 256 "$CACHE/$NODE_RELEASE/$ARCHIVE" | awk '{print $1}')" == "$expected" ]] || fail "Node checksum mismatch; delete $CACHE/$NODE_RELEASE/$ARCHIVE and retry."
unzip -q "$CACHE/$NODE_RELEASE/$ARCHIVE" -d "$WORK"
STAGE="$WORK/$NAME"
mkdir -p "$STAGE/app" "$STAGE/node"
sips -z 256 256 assets/logo.png --out "$WORK/logo-256.png" >/dev/null
node scripts/png-to-ico.mjs "$WORK/logo-256.png" "$WORK/app.ico"
# Keep generated icons/build intermediates out of the source tree.
cp -R windows/TokenwiseStudio "$WORK/project"
rm -rf "$WORK/project/bin" "$WORK/project/obj"
cp "$WORK/app.ico" "$WORK/project/app.ico"
# No debug symbols and no local build paths in the shipped binaries (the .pdb and the DLL's debug directory would
# otherwise carry the absolute path of this checkout).
dotnet publish "$WORK/project/TokenwiseStudio.csproj" -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false \
  -p:DebugType=none -p:DebugSymbols=false -p:Deterministic=true -p:ContinuousIntegrationBuild=true \
  "-p:PathMap=$WORK/project=/src" -o "$STAGE"
find "$STAGE" -name '*.pdb' -delete
cp "$WORK/app.ico" "$STAGE/app.ico"
cp "$WORK/node-$NODE_RELEASE-win-x64/node.exe" "$STAGE/node/node.exe"
cp "$WORK/node-$NODE_RELEASE-win-x64/LICENSE" "$STAGE/node/LICENSE"
printf '%s\n' "$NODE_RELEASE" > "$STAGE/node/version.txt"
for entry in src ui assets package.json package-lock.json LICENSE; do cp -R "$ROOT/$entry" "$STAGE/app/$entry"; done
# Current dependencies are pure JS. Select Windows optional dependencies if any are added.
(cd "$STAGE/app" && npm ci --omit=dev --ignore-scripts --os=win32 --cpu=x64 --no-audit --no-fund)
printf 'windows\n' > "$STAGE/app/.bundled"
cp README.md "$STAGE/README.md"
(cd "$WORK" && zip -qr "$NAME.zip" "$NAME")
rm -rf "$DIST/$NAME"
mv "$STAGE" "$DIST/$NAME"
mv "$WORK/$NAME.zip" "$DIST/$NAME.zip"
cp "$DIST/$NAME.zip" "$DIST/tokenwise-studio-windows.zip"
printf '\n[build-windows] Unsigned Windows beta: %s\n' "$DIST/$NAME.zip"
shasum -a 256 "$DIST/$NAME.zip" "$DIST/tokenwise-studio-windows.zip"
