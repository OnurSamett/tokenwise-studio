# macOS releases and Windows beta

Run these commands yourself on a Mac. The build scripts do not commit or change your git index.

## Prerequisites

- Node.js 20+, npm, and Xcode command line tools (`xcode-select --install`).
- Network access to GitHub (Sparkle and release uploads), nodejs.org and the npm registry; Apple notarization access for release builds.
- The **Developer ID Application: [redacted] ([redacted])** certificate **and private key** in your unlocked keychain.
- A `notarytool` keychain profile named `tokenwise`. Create it interactively with `xcrun notarytool store-credentials tokenwise` (Apple ID, team ID `[redacted]`, and an app-specific password, or use Apple's supported API-key credential flags). Never put credentials in this repo.
- GitHub CLI signed in (`gh auth login`) for publication only.

## Sparkle setup (once, before the first build)

1. Fill `SPARKLE_SHA256` in `scripts/build-dmg.sh` with the official SHA-256 for **Sparkle-2.8.1.tar.xz**, from the [pinned upstream release](https://github.com/sparkle-project/Sparkle/releases/tag/2.8.1). The placeholder deliberately fails; there is no environment override or unverified bootstrap. Check the checksum against the official release, rather than trusting a locally downloaded file alone.
2. Run `bash scripts/sparkle-keys.sh`. It downloads and verifies that pinned SDK, then runs `generate_keys --account tokenwise-studio`. Sparkle creates/reuses a private EdDSA key in the **login keychain**, and the script writes only the public key to `launcher/sparkle-public-key.txt`. The checksum must be filled **before** this command, since it executes a downloaded tool. No private-key export is performed. Re-running the command preserves an existing key; a different already-saved public key is rejected to prevent accidental rotation.
3. Review and commit the checksum pin and public-key file with the implementation changes. Never commit a private key. Both build and release reject the public-key placeholder. Keep a secure backup of your signing keychain outside this repo; see [Sparkle's key guidance](https://sparkle-project.org/documentation/#eddsa-ed25519-signatures).

The verified archive is cached in `.cache/sparkle/`; tools and framework are re-extracted from the checksum-verified archive on each build. `bash scripts/build-dmg.sh --prepare-sparkle` prepares only this SDK, without changing DMGs or touching the keychain.

## Build and inspect

1. Set `package.json` and `package-lock.json` to the release version and add its released section to `CHANGELOG.md`. Currently the package is **0.9.0**; the **0.10.0 (unreleased)** section is not released by these scripts.
2. Run `npm ci`, then `npm test`.
3. Run `bash scripts/build-dmg.sh --skip-notarize --dry-run`. This downloads/verifies Sparkle and Node, embeds Sparkle.framework, compiles both Swift slices against it, installs production dependencies into the staged app, checks the bundled CLI, and stops **before codesign/keychain access**. Its output app is `dist/unsigned/tokenwise studio.app`.
4. Optional signed local test: `bash scripts/build-dmg.sh --skip-notarize`. This **does access the signing keychain**, creates both DMG filenames, and skips Apple submission/stapling/Gatekeeper assessment. Do not publish this artifact.
5. To create the final release locally: `bash scripts/build-dmg.sh`. This signs every Mach-O and the outer bundle, creates a plain, background-free DMG with an Applications shortcut, signs it, submits with `xcrun notarytool submit ... --keychain-profile tokenwise --wait`, staples/validates it, then runs `spctl -a -t open --context context:primary-signature -vv ...`.
6. Test the notarized DMG on Apple Silicon and Intel Macs, ideally with a clean account and no external Node. Drag the app into Applications; test launching after moving it, worker discovery, a project window, notifications, and dictation. A successful local JIT smoke check covers only the host architecture.
7. To build **and publish** in one command, run `bash scripts/release.sh`. It rebuilds/notarizes/staples, extracts only the current version's released CHANGELOG section, signs the final DMG bytes with Sparkle's `sign_update --account tokenwise-studio` using the keychain, verifies that signature against `launcher/sparkle-public-key.txt`, prepends an item to `docs/appcast.xml`, and calls `gh release create v<version>` with both assets. After GitHub publication succeeds, review, commit and push `docs/appcast.xml` through the existing static-site deployment so `https://tokenwise.site/appcast.xml` is updated. Do not publish the feed before its DMG is available. Duplicate appcast versions are rejected; if publication failed after the feed was written, inspect GitHub and remove only that unpublished local item before retrying. An existing tag/release fails clearly; the script does not overwrite an existing release.

Artifacts are `dist/tokenwise-studio-<version>.dmg` and an identical `dist/tokenwise-studio.dmg`. The latter is required by the website's `/releases/latest/download/tokenwise-studio.dmg` link. `release.sh` uploads only those two artifacts, avoiding older versions or unsigned test output in `dist`.

The build resolves the newest official **LTS** that satisfies `engines.node` (currently `>=20`) and has both macOS archives. For repeatable builds, set an exact version: `NODE_VERSION=24.21.0 bash scripts/build-dmg.sh` (choose a current supported release). The selector fails explicitly if the engine syntax changes beyond a simple `>=x.y.z`. Official archives are cached in `.cache/node/<version>`; `TOKENWISE_NODE_CACHE` overrides that directory. Every cached archive is checked again against the release's freshly fetched `SHASUMS256.txt` over HTTPS. Delete a corrupt cache file and retry; no cached checksum is silently trusted. Record the selected version from the build log; it is also included under `Contents/Resources/node/version.txt`.

The launcher and Node executable are universal (`arm64` + `x86_64`). Runtime and app licenses are included. Application state stays in `~/.tokenwise-studio` and each project's `.tokenwise-studio`; config paths inside the DMG resolve relative to Resources, so the app does not refer to the build machine's checkout. The npm/CLI setup still supports absolute paths. Setup keeps an installed self-contained app, and embedded app updates use Sparkle to replace the signed app. The app menu's **Check for Updates…** checks manually; automatic checks default to once every 86400 seconds. CLI/npm launchers keep the npm updater and have no Sparkle dependency. `Resources/app/` gates Sparkle at runtime, and the bundled marker already blocks the npm updater.

Sparkle's [non-sandboxed integration](https://sparkle-project.org/documentation/sandboxing/) leaves `SUEnableInstallerLauncherService`, `SUEnableDownloaderService` and other sandbox-only flags unset. The framework's XPC services are retained and signed, with Downloader's upstream entitlements preserved, followed by Autoupdate, Updater.app, the framework and the outer app. Every signature uses Developer ID, hardened runtime and a timestamp; signing never uses `--deep`. The appcast and CLI/DMG app minimum is macOS 13.3; the Swift launcher targets macOS 13.3.

Before public release, exercise an actual older-to-newer Sparkle upgrade with signed/notarized builds on Apple Silicon and Intel. Confirm the daily check/manual menu, application replacement, relaunch, and preservation of project/state files. Offline type-checking without the framework checks only the `#if canImport(Sparkle)` fallback; it cannot validate Sparkle linking, keychain access, notarization or installation.

## Hardened runtime entitlements

`scripts/node-entitlements.plist` applies **only to Node**:

- `com.apple.security.cs.allow-jit`: permits V8's JIT executable-memory regions under the hardened runtime (including Apple's `MAP_JIT` path).
- `com.apple.security.cs.allow-unsigned-executable-memory`: permits V8-generated executable code paths that use executable mappings outside `MAP_JIT`, for compatibility across the official Intel/ARM Node builds.
- **No `disable-library-validation`**: the production dependencies are JavaScript and bundled native code is signed with the same team. There is no need to allow arbitrary unsigned or other-team native addons. If dependencies change, validate that assumption and both architectures before release.

The Swift launcher gets `com.apple.security.device.audio-input` for microphone dictation, plus the existing microphone/speech usage descriptions in Info.plist. It gets no Node JIT exceptions. The two V8 keys match [Node’s own entitlements](https://github.com/nodejs/node/blob/main/tools/osx-entitlements.plist); broader Node development/debugging exceptions are intentionally omitted. See [Apple hardened runtime documentation](https://developer.apple.com/documentation/security/hardened-runtime) and [Node official distributions](https://nodejs.org/dist/).

## Install scripts and website

Publish the contents of `docs/` through the existing static site workflow so `/install.sh`, `/install.ps1` and `/appcast.xml` are served at `https://tokenwise.site`. No site deployment is performed by these build scripts. Publish the signed/notarized GitHub release before advertising the Download for Mac link.

The Mac shell installer checks macOS, Node 20+ and npm, probes `npm view tokenwise-studio version`, and installs from npm if published, otherwise GitHub (which requires git). It runs setup and opens the app. Node installation and sudo are never automatic. The Windows installer checks Windows, Node 20+, npm and git, installs from GitHub, and prints the browser command without attempting Mac setup.

## Windows desktop beta

On macOS, install the .NET SDK (`brew install --cask dotnet-sdk`) and run:

```sh
npm test
bash scripts/build-windows.sh
# Optional exact Node version: NODE_VERSION=x.y.z bash scripts/build-windows.sh
```

The build uses the same official Node LTS selection as the DMG, verifies the Windows x64 zip against SHASUMS256, generates an ICO from assets/logo.png, and cross-publishes the .NET 8 WinForms/WebView2 host self-contained for win-x64. It stages production JS dependencies with lifecycle scripts disabled (current dependencies are pure JS). If native dependencies are added, provide a Windows build step before shipping. Outputs are `dist/tokenwise-studio-windows-<version>/`, its versioned zip, and `dist/tokenwise-studio-windows.zip`; SHA-256 hashes are printed.

`release.sh` builds Windows when dotnet is available, pins it to the exact Node version resolved by the Mac build, and attaches both zip names to the GitHub release. A Windows build failure stops publication; missing dotnet explicitly skips Windows. No Windows signing is performed. Publish a beta only with the SmartScreen and untested-hardware notes visible on the site.

For a compile-only check: `dotnet build windows/TokenwiseStudio/TokenwiseStudio.csproj -c Release -r win-x64 --self-contained true`. NuGet access is required on first build. The `.ico` is generated only by the packaging script; direct builds use the default executable icon.

The launcher uses `%USERPROFILE%\.tokenwise-studio`: shared `recents.json` and `servers.json`, separate `windows-state.json`, and `webview2/` for its writable browser profile. Launch errors are recorded in `windows-launcher.log`. Same-version servers are reused only after a loopback `/api/state` check confirms the project and version. Older servers are asked to quit with the CSRF header; busy servers are left alone with an error. Each project has its own window; a second app invocation forwards folders to the running instance. Closing windows leaves servers available for reuse.

Native dictation, Roblox playtest and Sparkle are guarded for macOS. Windows and Linux use browser notifications with permission and an open UI. CLI checks, worker commands and project test commands use cross-spawn for PATH/PATHEXT and .cmd handling. Windows has not been exercised on real hardware. Validate worker authentication, process-tree cancellation (currently POSIX group/single-PID fallback), project tests, missing-runtime installation, restore/reuse, external links and Windows junction confinement before promoting it beyond beta.
