#!/usr/bin/env bash
# restore-r2-cache.sh
# Restores working directory and Zoekt index shards from Cloudflare R2 cache.
set -euo pipefail

# Fail-fast validation of required parameters
MISSING_VARS=()
for var in OWNER REPO PR_NUMBER HEAD_SHA; do
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
HEAD_SHA="${HEAD_SHA}"
WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
R2_ENDPOINT="${R2_ENDPOINT:-}"
R2_CACHE_BUCKET="${R2_CACHE_BUCKET:-review-yeti-workspace-cache}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"

# Map R2 credentials to AWS CLI credentials if provided
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
fi
if [ -n "${R2_SECRET_ACCESS_KEY:-}" ] && [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
fi
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

CACHE_KEY="${OWNER}/${REPO}/pr-${PR_NUMBER}.tar.zst"
TMP_DIR="${TMPDIR:-/tmp}"
TMP_DIR="${TMP_DIR%/}"
SAFE_OWNER="${OWNER//\//_}"
SAFE_REPO="${REPO//\//_}"
LOCAL_ARCHIVE="${LOCAL_ARCHIVE:-${TMP_DIR}/workspace-cache-${SAFE_OWNER}-${SAFE_REPO}-${PR_NUMBER}-$$-${RANDOM}.tar.zst}"
CLONE_ERR=""

# Redact any credentials and secrets from output / error streams
redact_secrets() {
  sed -E \
    -e 's#https://[^@/[:space:]]+:[^@/[:space:]]+@#https://[REDACTED]@#g' \
    -e 's#x-access-token:[^[:space:],;]+#x-access-token:[REDACTED]#g' \
    -e 's#gh[pousr]_[A-Za-z0-9_]{16,}#[REDACTED_GH_TOKEN]#g' \
    -e 's#github_pat_[A-Za-z0-9_]{22,}#[REDACTED_GH_TOKEN]#g'
}

# Ensure cleanup of temporary archive and logs on exit or signal
trap 'rm -f "${LOCAL_ARCHIVE:-}" ${CLONE_ERR:+"$CLONE_ERR"}' EXIT INT TERM HUP

mkdir -p "${WORKSPACE_DIR}"

echo "[r2-cache] Checking for cache at ${CACHE_KEY}..."

# Construct remote clone/fetch URL with credentials if available
if [ -n "${GITHUB_TOKEN}" ]; then
  REMOTE_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${OWNER}/${REPO}.git"
else
  REMOTE_URL="https://github.com/${OWNER}/${REPO}.git"
fi

MAX_CACHE_AGE_SECONDS="${MAX_CACHE_AGE_SECONDS:-3600}"

RESTORED=0
# Attempt cache download if AWS CLI and endpoint are configured
if command -v aws >/dev/null 2>&1 && [ -n "${R2_ENDPOINT}" ]; then
  # 1-Hour Aggressive Expiration Check: Inspect LastModified / created-at metadata
  CACHE_EXPIRED=0
  OBJ_INFO=$(aws s3api head-object --bucket "${R2_CACHE_BUCKET}" --key "${CACHE_KEY}" --endpoint-url "${R2_ENDPOINT}" 2>/dev/null || true)
  if [ -n "${OBJ_INFO}" ]; then
    OBJ_TIMESTAMP=$(printf '%s\n' "${OBJ_INFO}" | python3 -c "
import sys, json, datetime
try:
    d = json.load(sys.stdin)
    meta_created = d.get('Metadata', {}).get('created-at')
    if meta_created and str(meta_created).isdigit():
        print(int(meta_created))
    else:
        lm = d.get('LastModified')
        if lm:
            dt = datetime.datetime.fromisoformat(str(lm).replace('Z', '+00:00'))
            print(int(dt.timestamp()))
        else:
            print(0)
except Exception:
    print(0)
" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    if [ "${OBJ_TIMESTAMP}" -gt 0 ]; then
      AGE=$(( NOW - OBJ_TIMESTAMP ))
      if [ "${AGE}" -gt "${MAX_CACHE_AGE_SECONDS}" ]; then
        echo "[r2-cache] Cache archive is expired (${AGE}s old > ${MAX_CACHE_AGE_SECONDS}s TTL). Purging from R2..."
        CACHE_EXPIRED=1
        aws s3 rm "s3://${R2_CACHE_BUCKET}/${CACHE_KEY}" --endpoint-url "${R2_ENDPOINT}" 2>/dev/null || true
      fi
    fi
  fi

  if [ "${CACHE_EXPIRED}" -eq 1 ]; then
    echo "[r2-cache] Cache expired for PR #${PR_NUMBER}; proceeding with full shallow clone."
  else
    echo "[r2-cache] Attempting download from s3://${R2_CACHE_BUCKET}/${CACHE_KEY}..."
    if aws s3 cp "s3://${R2_CACHE_BUCKET}/${CACHE_KEY}" "${LOCAL_ARCHIVE}" --endpoint-url "${R2_ENDPOINT}" 2>/dev/null; then
      echo "[r2-cache] Cache hit! Unpacking archive with zstd..."
      UNPACK_START=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s)

      UNPACK_OK=0
      if tar --version 2>&1 | grep -qi 'gnu'; then
        if tar -I zstd -xf "${LOCAL_ARCHIVE}" -C "${WORKSPACE_DIR}" 2>/dev/null; then
          UNPACK_OK=1
        fi
      else
        if zstd -dc -T0 "${LOCAL_ARCHIVE}" 2>/dev/null | tar -xf - -C "${WORKSPACE_DIR}" 2>/dev/null; then
          UNPACK_OK=1
        fi
      fi

      if [ "${UNPACK_OK}" -eq 1 ]; then
        UNPACK_END=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s)
        UNPACK_MS=$(( UNPACK_END - UNPACK_START ))
        echo "[r2-cache] Unpack completed in ${UNPACK_MS}ms."
        RESTORED=1
      else
        echo "[r2-cache] WARN: Archive decompression failed (corrupted or truncated archive); falling back to full clone." >&2
        rm -rf "${WORKSPACE_DIR:?}"/* "${WORKSPACE_DIR:?}"/.* 2>/dev/null || true
        RESTORED=0
      fi
      rm -f "${LOCAL_ARCHIVE}"
    else
      echo "[r2-cache] Cache miss for PR #${PR_NUMBER}."
    fi
  fi
else
  echo "[r2-cache] R2 endpoint not configured or aws cli missing; proceeding with full clone."
fi

# Attempt delta fetch on cache hit
FETCH_SUCCESS=0
if [ "${RESTORED}" -eq 1 ] && [ -d "${WORKSPACE_DIR}/.git" ]; then
  echo "[r2-cache] Updating git remote origin..."
  git -C "${WORKSPACE_DIR}" remote set-url origin "${REMOTE_URL}" 2>/dev/null || true

  echo "[r2-cache] Fetching delta for head ${HEAD_SHA}..."
  if git -C "${WORKSPACE_DIR}" fetch --depth=50 origin "${HEAD_SHA}" 2>/dev/null && \
     git -C "${WORKSPACE_DIR}" checkout -q "${HEAD_SHA}" 2>/dev/null; then
    FETCH_SUCCESS=1
  else
    echo "[r2-cache] WARN: Incremental fetch/checkout failed (history diverged or corrupted cache); falling back to full clone."
  fi
fi

# Cache miss or recovery fallback: perform full clone
if [ "${FETCH_SUCCESS}" -eq 0 ]; then
  echo "[r2-cache] Performing full shallow clone at ${HEAD_SHA}..."
  rm -rf "${WORKSPACE_DIR:?}"/* "${WORKSPACE_DIR:?}"/.* 2>/dev/null || true
  CLONE_ERR="${TMP_DIR}/clone-err-$$-${RANDOM}.log"
  if ! git clone --depth=50 --no-single-branch "${REMOTE_URL}" "${WORKSPACE_DIR}" 2>"${CLONE_ERR}"; then
    echo "[r2-cache] ERROR: git clone failed:" >&2
    redact_secrets < "${CLONE_ERR}" >&2
    rm -f "${CLONE_ERR}"
    CLONE_ERR=""
    exit 1
  fi
  rm -f "${CLONE_ERR}"
  CLONE_ERR=""
  git -C "${WORKSPACE_DIR}" checkout -q "${HEAD_SHA}"
fi

# Scrub credentials from git remote URL before caching to prevent token leakage into R2 archives
CLEAN_REMOTE_URL="https://github.com/${OWNER}/${REPO}.git"
if [ -d "${WORKSPACE_DIR}/.git" ]; then
  git -C "${WORKSPACE_DIR}" remote set-url origin "${CLEAN_REMOTE_URL}" 2>/dev/null || true
fi

# Ensure Zoekt index directory exists and update index
mkdir -p "${WORKSPACE_DIR}/.zoekt"
if command -v zoekt-index >/dev/null 2>&1; then
  echo "[r2-cache] Updating Zoekt symbol index..."
  zoekt-index -index_dir "${WORKSPACE_DIR}/.zoekt" "${WORKSPACE_DIR}" || true
fi

echo "[r2-cache] Workspace ready."
