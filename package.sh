#!/usr/bin/env bash
# Build a distributable tarball from the committed tree.
set -euo pipefail

cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-$(git describe --tags --always --dirty 2>/dev/null || date +%Y%m%d)}"
NAME="herdr-sessions-$VERSION"
OUT="dist/$NAME.tar.gz"

mkdir -p dist
git archive --format=tar.gz --prefix="$NAME/" HEAD -o "$OUT"
(
  cd dist
  sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256"
)

echo "Built $OUT"
echo "Checksum: dist/$NAME.tar.gz.sha256"
