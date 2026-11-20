#!/usr/bin/env bash
# Makes the AUR package's files for a release, and builds the package from them to check it. See docs/RELEASE.md.
#
#   packaging/aur/build.sh <release> <out> [tarball]
#
# <release> is a release's name, like 20261120.2. Writes PKGBUILD, .SRCINFO and the launcher entry to <out>, which is
# what goes to the AUR, with pkgver and the checksums filled in. The tar.gz is the release's, downloaded from GitHub,
# unless [tarball] gives a copy of it: a build that isn't released yet, or one already downloaded. Then runs makepkg
# on it, and namcap if it's installed. Run it on Arch, as a user who isn't root: makepkg won't run as root.
set -euo pipefail

release=${1:?release name, like 20261120.2}
out=${2:?folder to write to}
tarball=${3:+$(realpath "$3")}
[[ $release =~ ^[0-9]{8}\.[0-9]+$ ]] || { echo "Not a release name: $release" >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
file="omfv-$release.0-linux-x64.tar.gz"
mkdir -p "$out"
out=$(cd "$out" && pwd)
cp "$here/PKGBUILD" "$here/oh-my-f1-viewer.desktop" "$out/"
cd "$out"

if [ -n "$tarball" ]; then
  # makepkg uses a source that's already there rather than downloading it.
  cp "$tarball" "$file"
elif [ ! -f "$file" ]; then
  curl -fL --retry 3 -o "$file" "https://github.com/natheihei/oh-my-f1-viewer/releases/download/app-$release/$file"
fi

sum() { sha256sum "$1" | cut -d' ' -f1; }
sed -i \
  -e "s/^pkgver=.*/pkgver=$release/" \
  -e "s/^pkgrel=.*/pkgrel=1/" \
  -e "s/^sha256sums=.*/sha256sums=('$(sum "$file")' '$(sum oh-my-f1-viewer.desktop)')/" \
  PKGBUILD

makepkg --printsrcinfo > .SRCINFO
makepkg -f --noconfirm
if command -v namcap > /dev/null; then
  namcap PKGBUILD
  namcap oh-my-f1-viewer-bin-*.pkg.tar.*
fi
echo "Wrote $out: PKGBUILD, .SRCINFO and oh-my-f1-viewer.desktop go to the AUR."
