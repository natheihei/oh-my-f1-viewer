#!/usr/bin/env bash
# Makes the SSH key the Release app action pushes to the AUR with, once, and gives it to the action as the repo secret
# AUR_SSH_PRIVATE_KEY. Prints the public key, for the AUR account that maintains oh-my-f1-viewer-bin. See docs/RELEASE.md.
#
# Usage: scripts/aur-ssh-key.sh
#
# Nothing is kept: the key is only in the secret. To replace it, run this again and swap the public key on the AUR.
set -euo pipefail

if gh secret list | grep -q '^AUR_SSH_PRIVATE_KEY\b' && [ "${1:-}" != --replace ]; then
  echo "AUR_SSH_PRIVATE_KEY is already set. Pass --replace to make a new key, then swap the public key on the AUR." >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
ssh-keygen -q -t ed25519 -N '' -C 'omfv release action' -f "$work/aur"
gh secret set AUR_SSH_PRIVATE_KEY < "$work/aur"

echo "Set AUR_SSH_PRIVATE_KEY. Add this public key to your AUR account, under My Account → SSH Public Key:"
echo
cat "$work/aur.pub"
