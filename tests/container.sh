#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Run the smoke test (tests/smoke.sh) inside a container of another
# distribution, on a clean copy of the committed code plus any uncommitted
# changes to tracked files. Needs podman.
#
# Usage: tests/container.sh fedora-44      (or: make test-container DISTRO=fedora-44)
# The available distributions are the folders in tests/containers/.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DISTRO=${1:-}
if [ -z "$DISTRO" ] || [ ! -f "$ROOT/tests/containers/$DISTRO/Containerfile" ]; then
    echo "usage: $0 DISTRO, one of: $(ls "$ROOT/tests/containers" | tr '\n' ' ')" >&2
    exit 2
fi
command -v podman >/dev/null || { echo "podman is needed (e.g. sudo apt install podman)" >&2; exit 2; }

IMAGE="pier-test:$DISTRO"
podman image exists "$IMAGE" ||
    echo "Building the $DISTRO test image; the first time downloads its GNOME packages (1-2 GB) and can take a while..."
podman build -q -t "$IMAGE" "$ROOT/tests/containers/$DISTRO" >/dev/null

# Test a copy, so the container never writes into the working tree.
COPY=$(mktemp -d)
trap 'rm -rf "$COPY"' EXIT
git -C "$ROOT" ls-files -z | (cd "$ROOT" && xargs -0 cp --parents -t "$COPY")

podman run --rm --userns=keep-id --user "$(id -u):$(id -g)" \
    -v "$COPY:/pier" -w /pier -e HOME=/tmp \
    "$IMAGE" make -s test
