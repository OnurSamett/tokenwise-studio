#!/bin/sh
set -eu
step() { printf '\n[tokenwise studio] %s\n' "$*"; }
fail() { printf '\n[tokenwise studio] ERROR: %s\n' "$*" >&2; exit 1; }
main() {
step '1/5 Checking macOS'
[ "$(uname -s)" = Darwin ] || fail 'This installer needs macOS. Windows: irm https://tokenwise.site/install.ps1 | iex'
step '2/5 Checking Node.js 20+ and npm'
command -v node >/dev/null 2>&1 || fail 'Node.js is missing. Install it from https://nodejs.org or run: brew install node. Then retry.'
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || fail 'Node.js 20+ is required. Upgrade from https://nodejs.org or run: brew install node. Then retry.'
command -v npm >/dev/null 2>&1 || fail 'npm is missing. Reinstall Node.js from https://nodejs.org.'
step '3/5 Finding the latest verified release on GitHub and installing tokenwise studio'
# Never the npm registry: the name "tokenwise-studio" there is not published by this project.
command -v git >/dev/null 2>&1 || fail 'The GitHub install requires git. Install Xcode command line tools: xcode-select --install. Then retry.'
command -v curl >/dev/null 2>&1 || fail 'curl is missing.'
cd "$HOME" || fail 'Cannot enter your home folder.'
tag=$(curl -fsSL --max-time 15 -H 'Accept: application/vnd.github+json' https://api.github.com/repos/OnurSamett/tokenwise-studio/releases/latest | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d);const ok=!r.draft&&!r.prerelease&&/^v\d+\.\d+\.\d+$/.test(r.tag_name)&&(r.assets||[]).some(a=>a.name==="SHA256SUMS.txt");if(ok)process.stdout.write(r.tag_name)}catch{}})') || tag=''
case "$tag" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail 'Could not find a valid GitHub release (offline or rate limited?). Retry later, or download the DMG from https://github.com/OnurSamett/tokenwise-studio/releases/latest.' ;; esac
package="github:OnurSamett/tokenwise-studio#$tag"
step "Running: npm install -g $package"
npm install -g --ignore-scripts "$package" || fail 'npm installation failed. Check network access and your npm global prefix permissions; use a user-owned Node installation. No sudo is needed.'
command -v tokenwise-studio >/dev/null 2>&1 || fail 'Installed, but tokenwise-studio is not on PATH. Add the bin directory under npm prefix -g to PATH, then run tokenwise-studio setup.'
step '4/5 Running tokenwise-studio setup'
tokenwise-studio setup || fail 'Setup failed. Read the error above, fix it, then run tokenwise-studio setup again.'
step '5/5 Opening the Mac app'
# setup may keep an existing DMG app; prefer its bundle identifier, then the CLI app path.
open -b com.nolienlabs.tokenwise-studio 2>/dev/null || open "$HOME/Applications/tokenwise studio.app" || fail 'Could not open the app. Install Xcode command line tools and rerun tokenwise-studio setup, or start with tokenwise-studio --browser in a project folder.'
step 'Done. Pick a project in the app. Run tokenwise-studio doctor to check your workers.'
}
main "$@"
