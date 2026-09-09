#!/usr/bin/env bash
# scripts/hold-for-review.sh
# Entrypoint forwarding to centralized .github/actions/hold-for-review/hold-for-review.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/../.github/actions/hold-for-review/hold-for-review.sh" "$@"
