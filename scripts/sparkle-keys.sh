#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[[ $# == 0 ]] || { echo 'Usage: scripts/sparkle-keys.sh' >&2; exit 1; }
# Downloads/verifies the pinned SDK, without signing or accessing the keychain.
bash scripts/build-dmg.sh --prepare-sparkle
TOOLS="$ROOT/.cache/sparkle/sdk/bin"
# Sparkle stores the private key in the login keychain. Never export it into the repo.
"$TOOLS/generate_keys" --account tokenwise-studio
PUBLIC_KEY="$("$TOOLS/generate_keys" --account tokenwise-studio -p)"
[[ "$PUBLIC_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]] || { echo 'Invalid Sparkle public key' >&2; exit 1; }
if [[ -f launcher/sparkle-public-key.txt ]]; then
  EXISTING="$(cat launcher/sparkle-public-key.txt)"
  if [[ "$EXISTING" =~ ^[A-Za-z0-9+/]{43}=$ && "$EXISTING" != "$PUBLIC_KEY" ]]; then
    echo 'Existing public key differs. Refusing an accidental key rotation; see Sparkle key rotation docs.' >&2
    exit 1
  fi
fi
printf '%s\n' "$PUBLIC_KEY" > launcher/sparkle-public-key.txt
printf '[sparkle-keys] Public key: %s\nCommit launcher/sparkle-public-key.txt (public only). Keep the private key in your login keychain.\n' "$PUBLIC_KEY"
