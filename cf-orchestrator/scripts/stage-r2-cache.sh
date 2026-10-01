#!/usr/bin/env bash
# stage-r2-cache.sh
# Compresses working directory git objects and Zoekt index shards and uploads to Cloudflare R2.
set -euo pipefail

# Fail-fast validation of required parameters
MISSING_VARS=()
for var in OWNER REPO PR_NUMBER; do
  if [ -z "${!var:-}" ]; then
    MISSING_VARS+=("$var")
  fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
  echo "[r2-cache] ERROR: Missing required environment variable(s): ${MISSING_VARS[*]}" >&2
  exit 1
fi

OWNER="${OWNER}"
REPO="${REPO}"
PR_NUMBER="${PR_NUMBER}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
R2_ENDPOINT="${R2_ENDPOINT:-}"
R2_CACHE_BUCKET="${R2_CACHE_BUCKET:-review-yeti-workspace-cache}"
DRY_RUN="${DRY_RUN:-0}"

CACHE_KEY="${OWNER}/${REPO}/pr-${PR_NUMBER}.tar.zst"
TMP_DIR="${TMPDIR:-/tmp}"
TMP_DIR="${TMP_DIR%/}"
SAFE_OWNER="${OWNER//\//_}"
SAFE_REPO="${REPO//\//_}"
LOCAL_ARCHIVE="${LOCAL_ARCHIVE:-${TMP_DIR}/workspace-cache-${SAFE_OWNER}-${SAFE_REPO}-${PR_NUMBER}-$$-${RANDOM}.tar.zst}"

# Trap cleanup
trap 'rm -f "${LOCAL_ARCHIVE}"' EXIT INT TERM HUP

if [ -z "${R2_ENDPOINT}" ] && [ "${DRY_RUN}" != "1" ]; then
  echo "[r2-cache] R2 endpoint not configured; skipping cache upload."
  exit 0
fi

if ! command -v aws >/dev/null 2>&1 && [ "${DRY_RUN}" != "1" ]; then
  echo "[r2-cache] aws CLI missing; skipping cache upload."
  exit 0
fi

if [ ! -d "${WORKSPACE_DIR}/.git" ]; then
  echo "[r2-cache] No .git directory found in ${WORKSPACE_DIR}; skipping cache upload."
  exit 0
fi

# Clean up any transient git lock files before archiving
rm -f "${WORKSPACE_DIR}/.git/index.lock" "${WORKSPACE_DIR}/.git/refs/heads"/*.lock 2>/dev/null || true

echo "[r2-cache] Compressing .git and .zoekt into ${LOCAL_ARCHIVE}..."
cd "${WORKSPACE_DIR}"

# Archive strictly .git and .zoekt (exclude node_modules, dist, and workspace source files)
TARGETS=(".git")
if [ -d ".zoekt" ]; then
  TARGETS+=(".zoekt")
fi

# Compress using zstd -3
if tar --version 2>&1 | grep -qi 'gnu'; then
  tar -I 'zstd -3' -cf "${LOCAL_ARCHIVE}" "${TARGETS[@]}"
else
  tar -cf - "${TARGETS[@]}" | zstd -3 > "${LOCAL_ARCHIVE}"
fi

ARCHIVE_SIZE=$(wc -c < "${LOCAL_ARCHIVE}" | tr -d ' ')
echo "[r2-cache] Archive size: ${ARCHIVE_SIZE} bytes."

if [ "${DRY_RUN}" = "1" ]; then
  echo "[r2-cache] Dry run enabled; skipping upload to s3://${R2_CACHE_BUCKET}/${CACHE_KEY}."
  exit 0
fi

# Map R2 credentials to AWS CLI credentials if provided
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
fi
if [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
fi
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

echo "[r2-cache] Uploading archive to s3://${R2_CACHE_BUCKET}/${CACHE_KEY}..."
CREATED_AT=$(date +%s)
aws s3 cp "${LOCAL_ARCHIVE}" "s3://${R2_CACHE_BUCKET}/${CACHE_KEY}" --endpoint-url "${R2_ENDPOINT}" --metadata "created-at=${CREATED_AT}"
rm -f "${LOCAL_ARCHIVE}"

echo "[r2-cache] Cache successfully staged to R2."
