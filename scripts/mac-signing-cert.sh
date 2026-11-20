#!/usr/bin/env bash
# Makes OMFV's own code-signing certificate for macOS, once, and gives it to the Release app action as two repo
# secrets: MAC_CERT_P12 and MAC_CERT_PASSWORD. Every release signed with it has the same identity, so an installed Mac
# app can update itself, and the keychain keeps trusting it across updates. See docs/RELEASE.md.
#
# Usage: scripts/mac-signing-cert.sh <where to keep a copy, such as ~/omfv-signing.p12>
#
# Keep that copy, and its password, somewhere safe, like a password manager. A new certificate is a new identity:
# Macs that have OMFV then need the next release installed by hand, once.
set -euo pipefail

keep=${1:?Usage: scripts/mac-signing-cert.sh <where to keep a copy of the certificate>}
[ -e "$keep" ] && { echo "$keep is already there: move it first, or pick another path." >&2; exit 1; }
gh secret list | grep -q '^MAC_CERT_P12\b' && { echo "MAC_CERT_P12 is already set: replacing it changes OMFV's identity on macOS." >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
password=$(openssl rand -base64 24)

# A self-signed certificate for code signing, good for 20 years. CN=OMFV is the identity the action signs with.
openssl req -x509 -newkey rsa:3072 -sha256 -days 7300 -nodes \
  -keyout "$work/key.pem" -out "$work/cert.pem" -subj '/CN=OMFV' \
  -addext 'basicConstraints=critical,CA:false' \
  -addext 'keyUsage=critical,digitalSignature' \
  -addext 'extendedKeyUsage=critical,codeSigning' 2>/dev/null
# 3DES and SHA-1 inside the .p12, which macOS's keychain imports everywhere.
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name OMFV -out "$keep" \
  -passout "pass:$password" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
chmod 600 "$keep"

base64 -w0 "$keep" | gh secret set MAC_CERT_P12
printf '%s' "$password" | gh secret set MAC_CERT_PASSWORD

echo "Made OMFV's signing certificate and set MAC_CERT_P12 and MAC_CERT_PASSWORD."
echo "A copy is in $keep. Its password, which you'll also want to keep:"
echo "  $password"
