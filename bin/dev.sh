#!/usr/bin/env bash
# Dev loop: rebuild then start (same as build + start).
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$PROJ/bin/build.sh"
exec bash "$PROJ/bin/run.sh" "$@"
