#!/usr/bin/env bash
# tools/create-review-dispatch-app.sh — store the ct-review-bot
# App credentials as org secrets for Review Yeti dispatch (REL-519).
#
# Adapted from the proven .context/create-release-automation-app.sh
# (ADR 0484 / REL-504) — same manifest-flow automation, different App +
# secret names + permission plan.
#
# Two modes:
#   A) The ct-review-bot App (app_id 4385771) already exists and is
#      installed broadly, but its private key was never saved. Keys
#      cannot be re-downloaded — instead this flow CREATES A NEW APP with
#      the same slug family (ct-review-dispatch) via the manifest flow,
#      which hands back a fresh PEM in the redirect. Install it on the same
#      repos, then optionally remove the old App.
#   B) If you have an existing .pem for ct-review-bot, skip this script:
#      gh secret set CT_REVIEW_BOT_APP_ID --org exampleorg --body 4385771
#      gh secret set CT_REVIEW_BOT_APP_PRIVATE_KEY --org exampleorg < key.pem
#
# What this does, end to end, on YOUR Mac under YOUR gh login (org owner):
#   1. Starts a tiny localhost listener for the manifest-flow redirect.
#   2. Opens a browser page that auto-submits the App manifest to GitHub
#      (name ct-review-dispatch, App-registration union: actions:read plus
#      checks/contents/issues/pull_requests:write and metadata:read, no webhook,
#      private). Runtime tokens narrow that union by repository and permission.
#   3. You click "Create GitHub App" on GitHub. GitHub redirects to localhost
#      with a one-time code.
#   4. The script exchanges the code (POST /app-manifests/{code}/conversions)
#      for the App ID + private key, and immediately runs
#        gh secret set CT_REVIEW_BOT_APP_ID          --org exampleorg
#        gh secret set CT_REVIEW_BOT_APP_PRIVATE_KEY --org exampleorg
#      The PEM lives only in this process's memory; it is never printed,
#      never written to disk, never pasted anywhere.
#   5. Prints the App's install URL — installing on repos is a UI click
#      (no REST endpoint creates installations for org-owned apps).
#
# Prereqs: gh (logged in as an org owner), python3, curl, jq, macOS `open`.
# Re-running rotates: it creates a new app + overwrites the secrets.
set -euo pipefail

ORG="exampleorg"
APP_NAME="${APP_NAME:-ct-review-dispatch}"
PORT="${PORT:-8788}"
STATE="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
REDIRECT="http://127.0.0.1:${PORT}/callback"

command -v gh >/dev/null || { echo "gh is required"; exit 1; }
command -v jq >/dev/null || { echo "jq is required"; exit 1; }
gh auth status -h github.com >/dev/null 2>&1 || { echo "gh is not logged in"; exit 1; }

# App-registration union (REL-519): same-owner target review/check publication
# needs the write grants below. Runtime workflows request narrower,
# repository-scoped tokens for target validation and central tooling.
MANIFEST="$(jq -cn --arg name "$APP_NAME" --arg redirect "$REDIRECT" '{
  name: $name,
  url: "https://github.com/exampleorg/example-review-actions",
  description: "Review Yeti dispatch identity (REL-519). Own per-installation rate bucket; replaces the shared user PAT that 4033d CI and the operator simultaneously on 2026-09-02.",
  redirect_url: $redirect,
  public: false,
  default_permissions: {
    actions: "read",
    checks: "write",
    contents: "write",
    pull_requests: "write",
    issues: "write",
    metadata: "read"
  },
  default_events: []
}')"

TMPHTML="$(mktemp -t ct-review-dispatch-manifest).html"
trap 'rm -f "$TMPHTML"' EXIT
python3 - "$TMPHTML" "$ORG" "$STATE" "$MANIFEST" <<'PY'
import html, sys
path, org, state, manifest = sys.argv[1:5]
page = f"""<!doctype html><html><body onload="document.forms[0].submit()">
<p>Submitting the <b>{html.escape(org)}</b> GitHub App manifest&hellip; click the button if nothing happens.</p>
<form action="https://github.com/organizations/{html.escape(org)}/settings/apps/new?state={html.escape(state)}" method="post">
<input type="hidden" name="manifest" value="{html.escape(manifest, quote=True)}">
<input type="submit" value="Create GitHub App">
</form></body></html>"""
open(path, "w").write(page)
PY

echo "▸ Listening on ${REDIRECT} for GitHub's redirect (state-checked)…"
echo "▸ Opening the pre-filled 'Create GitHub App' page. Review it, then click Create GitHub App."
open "$TMPHTML"

CODE="$(python3 - "$PORT" "$STATE" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs
port, expected_state = int(sys.argv[1]), sys.argv[2]
result = {}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        code, state = q.get("code", [""])[0], q.get("state", [""])[0]
        ok = bool(code) and state == expected_state
        self.send_response(200 if ok else 400)
        self.send_header("Content-Type", "text/html"); self.end_headers()
        self.wfile.write(b"<h2>Received. You can close this tab; return to the terminal.</h2>" if ok
                         else b"<h2>Bad state or missing code. Re-run the script.</h2>")
        if ok: result["code"] = code
srv = HTTPServer(("127.0.0.1", port), H)
while "code" not in result: srv.handle_request()
print(result["code"])
PY
)"
[ -n "$CODE" ] || { echo "no code received"; exit 1; }

echo "▸ Exchanging the one-time code for App credentials…"
CONV="$(curl -sS -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $(gh auth token)" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/app-manifests/${CODE}/conversions")"
APP_ID="$(jq -r '.id // empty' <<<"$CONV")"
SLUG="$(jq -r '.slug // empty' <<<"$CONV")"
[ -n "$APP_ID" ] || { echo "conversion failed:"; jq -r '.message // .' <<<"$CONV"; exit 1; }

echo "▸ Storing org secrets (names only shown)…"
gh secret set CT_REVIEW_BOT_APP_ID --org "$ORG" --visibility private --body "$APP_ID"
jq -r '.pem' <<<"$CONV" | gh secret set CT_REVIEW_BOT_APP_PRIVATE_KEY --org "$ORG" --visibility private
unset CONV CODE

echo
echo "✓ App '${SLUG:-$APP_NAME}' created (App ID ${APP_ID}); CT_REVIEW_BOT_APP_ID and CT_REVIEW_BOT_APP_PRIVATE_KEY set as private org secrets."
echo
echo "Last click — install it on the repos (org-owned apps have no REST install endpoint):"
echo "  https://github.com/organizations/${ORG}/settings/apps/${SLUG:-$APP_NAME}/installations"
echo "  Select only: example-review-actions + approved consumers carrying ct-review-bot.yml (currently example-meta, example-api, example-release, example-infra)."
echo
echo "Verify: re-run any consumer PR's 'Review Yeti / Review Yeti' check — it now mints"
echo "  CT_REVIEW_BOT_APP tokens (own rate bucket) instead of the shared PAT."
echo
echo "Teardown of the old shared-identity path (after a green run):"
echo "  gh secret delete CROSS_REPO_TOKEN --org $ORG   # after confirming no other workflow needs it"
