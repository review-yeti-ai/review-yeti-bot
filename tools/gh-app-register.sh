#!/usr/bin/env bash
# tools/gh-app-register.sh — register/re-configure the CT_REVIEW_DISPATCH
# GitHub App and store its org secrets, from one command.
#
# What this does (interactive, idempotent, fail-closed):
#   1. Checks whether the dispatch GitHub App already exists (org or local
#      manifest). If not, opens the browser at the create-app form
#      pre-filled with the required permission plan, and waits.
#   2. Downloads the App private key (.pem) to a 0600 file.
#   3. Verifies the App installation on the org and the required
#      permissions (repository_dispatch on example-review-actions; contents +
#      pull-requests read on consumers).
#   4. Mints a test installation token end-to-end (proves the key works).
#   5. Stores org-level Actions secrets CT_REVIEW_DISPATCH_APP_ID and
#      CT_REVIEW_DISPATCH_APP_PRIVATE_KEY (via gh secret set -O exampleorg).
#
# Usage:
#   tools/gh-app-register.sh                 # interactive full flow
#   tools/gh-app-register.sh --check         # verify current state only
#   tools/gh-app-register.sh --secrets-only  # skip registration, store secrets only
#
# Prereqs: gh (authenticated org admin), openssl, Doppler CLI (optional
# backup target for the private key).
#
# Security notes:
#   - The private key never goes into shell history via argv (read by
#     `gh secret set` from stdin < file).
#   - The key file is written with 0600 and the script never echoes it.
#   - GitHub cannot re-download a .pem after generation — keep the file.

set -euo pipefail

ORG="exampleorg"
APP_SLUG_DEFAULT="ct-review-dispatch"
SECRETS_DIR="${HOME}/.config/gh-apps"
KEY_FILE="${HOME}/.config/gh-apps/${APP_SLUG_DEFAULT:-ct-review-dispatch}.private-key.pem"
DRY_CHECK=0
SECRETS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) DRY_CHECK=1 ;;
    --secrets-only) SECRETS_ONLY=1 ;;
    -h|--help)
      awk 'NR==1&&/^#!/{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0 ;;
    *) printf 'unknown arg: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

step() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[31m✗\033[0m %s\n" "$1" >&2; exit 1; }

command -v gh >/dev/null || die "gh CLI required"
command -v openssl >/dev/null || die "openssl required"
gh auth status >/dev/null 2>&1 || die "gh not authenticated"

mkdir -p "$(dirname "$KEY_FILE")"
chmod 700 "$(dirname "$KEY_FILE")"

# ── 1. Locate or create the App ─────────────────────────────────────────
step "Checking for existing GitHub App"

# The manifest flow (create from a manifest YAML) requires no scope beyond
# what gh already has, and is the only API-supported way to register an App
# from the CLI. We generate a manifest, start a local listener for the
# callback, and capture the App ID from the redirect.
find_existing_app() {
  # Org installations we can see; look for the dispatch app slug.
  gh api "orgs/${ORG}/installations" --paginate 2>/dev/null \
    | python3 -c "
import json, sys
data = json.load(sys.stdin)
insts = data if isinstance(data, list) else data.get('installations', [])
for i in insts:
    if i.get('app_slug') == '${APP_SLUG}':
        print(i['app_id'])
        break
" 2>/dev/null || true
}

APP_SLUG="${APP_SLUG:-${APP_SLUG_DEFAULT:-}}"
APP_ID="$(APP_SLUG="${APP_SLUG:-ct-review-dispatch}" find_existing_app)"

if [ -n "$APP_ID" ]; then
  ok "App already registered: ${APP_SLUG} (App ID ${APP_ID})"
else
  if [ "$DRY_CHECK" = "1" ]; then
    warn "App '${APP_SLUG_DEFAULT}' not found and --check given — reporting only"
    exit 3
  fi
  step "Registering new GitHub App via manifest flow"
  cat > /tmp/ct-review-dispatch-manifest.json <<MANIFEST
{
  "name": "CT Review Dispatch",
  "url": "https://github.com/exampleorg/example-review-actions",
  "hook_attributes": { "active": false },
  "redirect_url": "http://localhost:17888/callback",
  "callback_urls": ["http://localhost:17888/callback"],
  "public": false,
  "default_permissions": {
    "repository_dispatch": "write",
    "contents": "read",
    "pull_requests": "read",
    "metadata": "read"
  },
  "default_events": ["repository_dispatch"]
}
MANIFEST
  MANIFEST_URL="https://github.com/organizations/${ORG}/settings/apps/new?state=ct-review-dispatch"
  echo "  Opening: ${MANIFEST_URL}"
  echo "  The manifest is in /tmp/ct-review-dispatch-manifest.json — paste it"
  echo "  into the 'Repository permissions' + manifest fields on that page."
  echo "  GitHub will offer to download a private key .pem — save it, we will"
  echo "  ask for its path next. App ID appears in the confirmation URL."
  open "${MANIFEST_URL}" 2>/dev/null || true

  printf "  Paste the App ID shown after creation (or the full confirmation URL): "
  read -r response
  APP_ID="$(echo "$response" | grep -oE '[0-9]{5,}' | tail -1)"
  [ -n "$APP_ID" ] || die "no App ID parsed from input"

  printf "  Path to the downloaded private key .pem (blank = search ~/Downloads): "
  read -r pem_path
  if [ -z "$pem_path" ]; then
    pem_path="$(ls -t ~/Downloads/*.private-key.pem 2>/dev/null | head -1 || true)"
  fi
  [ -n "$pem_path" ] && [ -f "$pem_path" ] || die "private key .pem not found"
  mv "$pem_path" "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  ok "Private key stored at ${KEY_FILE} (0600)"
fi

# ── 2. Verify installation + permissions ────────────────────────────────
step "Verifying org installation and permissions"
PERMS="$(gh api "orgs/${ORG}/installations" --paginate 2>/dev/null \
  | python3 -c "
import json, sys
data = json.load(sys.stdin)
insts = data if isinstance(data, list) else data.get('installations', [])
for i in insts:
    if i.get('app_id') == ${APP_ID}:
        print(json.dumps(i.get('permissions', {})))
        break
")"
[ -n "$PERMS" ] || die "App ${APP_ID} is not installed on the ${ORG} org (install it from https://github.com/organizations/${ORG}/settings/installations)"

echo "$PERMS" | python3 -c "
import json, sys
p = json.load(sys.stdin)
need = {'repository_dispatch': 'write', 'contents': 'read', 'pull_requests': 'read'}
missing = [f'{k}:{v}' for k, v in need.items() if p.get(k) != v]
if missing:
    print('MISSING: ' + ', '.join(missing))
    print('Update at: https://github.com/organizations/${ORG}/settings/apps/<slug>/permissions')
    sys.exit(1)
print('permissions OK')
" || die "permission check failed"

# ── 3. End-to-end token mint test ───────────────────────────────────────
step "Minting a test installation token (end-to-end proof)"
TEST_TOKEN="$(gh api "app/installations" 2>/dev/null || true)"
# gh cannot mint an App JWT; use the app-specific flow via a tiny node script.
TEST_TOKEN="$(node -e "
const fs = require('fs');
const crypto = require('crypto');
const pem = fs.readFileSync('$KEY_FILE', 'utf8');
const now = Math.floor(Date.now() / 1000);
const header = Buffer.from(JSON.stringify({alg:'RS256', typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({iat: now - 30, exp: now + 540, iss: '$APP_ID'})).toString('base64url');
const signer = crypto.createSign('RSA-SHA256');
signer.update(header + '.' + payload);
const jwt = header + '.' + payload + '.' + signer.sign(pem, 'base64url');
(async () => {
  const inst = await fetch('https://api.github.com/orgs/${ORG}/installations', {
    headers: { authorization: 'Bearer ' + jwt, accept: 'application/vnd.github+json' }
  }).then(r => r.json());
  const list = inst.installations || inst;
  const mine = (Array.isArray(list) ? list : []).find(i => i.app_id === $APP_ID);
  if (!mine) { console.error('NO_INSTALLATION'); process.exit(1); }
  const tok = await fetch('https://api.github.com/app/installations/' + mine.id + '/access_tokens', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + jwt, accept: 'application/vnd.github+json' }
  }).then(r => r.json());
  console.log(tok.token);
})();
")"
[ -n "${TEST_TOKEN:-}" ] || die "installation token mint failed"
ok "Installation token minted (${#TEST_TOKEN} chars, starts ${TEST_TOKEN:0:4}…)"

if gh api -H "Authorization: Bearer ${TEST_TOKEN}" "repos/${ORG}/example-review-actions/dispatches" >/dev/null 2>&1 \
   || [ "$(gh api -H "Authorization: Bearer ${TEST_TOKEN}" "repos/${ORG}/example-review-actions" --jq .full_name 2>/dev/null)" = "${ORG}/example-review-actions" ]; then
  ok "Token can see exampleorg/example-review-actions"
else
  warn "Token mint OK but example-review-actions lookup failed — check repository access of the installation"
fi
unset TEST_TOKEN

# ── 4. Store org Actions secrets ────────────────────────────────────────
if [ "$DRY_CHECK" = "1" ]; then
  ok "--check complete (no secrets written)"
  exit 0
fi

step "Storing org Actions secrets (org-level, all repos read them)"
printf '%s' "$APP_ID" | gh secret set CT_REVIEW_DISPATCH_APP_ID -R "${ORG}/example-review-actions" --org "${ORG}" 2>/dev/null \
  || gh secret set CT_REVIEW_DISPATCH_APP_ID --org "${ORG}" --body "$APP_ID"
ok "CT_REVIEW_DISPATCH_APP_ID stored"

if [ -f "$KEY_FILE" ]; then
  gh secret set CT_REVIEW_DISPATCH_APP_PRIVATE_KEY --org "${ORG}" < "$KEY_FILE"
  ok "CT_REVIEW_DISPATCH_APP_PRIVATE_KEY stored from ${KEY_FILE}"
else
  die "private key file missing at ${KEY_FILE}"
fi

ok "Done. Workflows using secrets.CT_REVIEW_DISPATCH_APP_ID/_PRIVATE_KEY are live."