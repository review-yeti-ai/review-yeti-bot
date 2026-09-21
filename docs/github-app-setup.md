# GitHub App Setup & Permissions Guide

This guide walks through configuring a dedicated **GitHub App** for Review Yeti. 

Using a GitHub App provides isolated rate-limiting, least-privilege scoping, short-lived installation tokens, and native access to the **GitHub Checks API** to publish review verdicts directly to pull requests.

---

## Why a GitHub App instead of a Personal Access Token (PAT)?

| Feature | Personal Access Token (PAT) | GitHub App |
| :--- | :--- | :--- |
| **Identity** | Tied to a specific user account | Organization-owned bot identity |
| **Rate Limits** | Shared with user (5,000 req/hr total) | Independent per-installation pool (5,000+ req/hr) |
| **Checks API Access** | ❌ Blocked (`POST /repos/:repo/check-runs` returns 403 for user tokens) | ✅ Native permission (`checks:write`) |
| **Token Lifecycle** | Long-lived, manual rotation | Short-lived installation tokens (1-hour expiration) |
| **Blast Radius** | Broad access across all user-accessible repos | Granularly installed only on selected repositories |

---

## Route-specific permissions

The governed cross-owner route uses separate App identities. Do not create one
catch-all App and reuse its key across the ingress, public target, and central
tooling boundaries. `Metadata: read` is the mandatory default for every App.
The table records each workflow's short-lived token request, not a second App
registration. The internal `CT_REVIEW_BOT_APP_*` App registration grants the
union needed by same-owner targets; every token is then narrowed to one
repository and the listed subset through `actions/create-github-app-token`'s
`permission-*` inputs.

| Identity or token | Repository scope | Token permissions requested |
| :--- | :--- | :--- |
| Internal exampleorg target App (`CT_REVIEW_BOT_APP_*`) | Admitted `exampleorg/*` target repositories | `Actions: write`, `Checks: write`, `Contents: write`, `Issues: write`, `Pull requests: write` for same-owner review/check publication. |
| Central tooling token (`CT_REVIEW_BOT_APP_*`) | `exampleorg/example-review-actions` only for the external route | A narrowed token requesting `Actions: read` and `Contents: read`; central validation and tooling never use the public target token. |
| Review Yeti target App (`REVIEW_YETI_PUBLIC_TARGET_APP_*`) | The App installation may cover the reviewer organization's repositories; this route requests a token narrowed to exactly `review-yeti-ai/review-yeti-bot` | `Actions: write`, `Checks: write`, `Contents: read`, `Issues: write`, `Pull requests: write` for target reads, check publication, and post-SHIP `validate.yml` dispatch. |
| Public ingress App (`REVIEW_YETI_DISPATCH_APP_*`) | Exactly `exampleorg/example-review-actions` | `Contents: write` only (plus mandatory `Metadata: read`); no `Actions`, `Checks`, `Issues`, or `Pull requests` permission. |

For the external route, the public target App is the only boundary that has
`Actions: write`. The ingress App submits one coordinate-only
`repository_dispatch`; it cannot dispatch workflows, read central files, or
publish checks. The internal exampleorg App row applies only to the
same-owner fleet and is never installed on the public target organization.

> [!NOTE]
> No Account, Organization, or User permissions are required. Keep permissions strictly at the repository level.

### Webhook Events
* **Webhook**: Active / Inactive (optional). If using GitHub Actions dispatch triggers (`workflow_dispatch` / `repository_dispatch`), webhooks can be disabled (`Active: false`). If running an event-driven review receiver, subscribe to `Pull request`.

---

## Setup Methods

### Method 1: Automated Manifest Flow (Recommended)

GitHub provides a Manifest conversion flow that pre-fills all app metadata and permissions via an automated browser redirect.

For the public ingress identity, use a minimal manifest like this. This is not
the internal `CT_REVIEW_BOT_APP_*` helper; do not use the internal helper to
provision the public ingress App.

```json
{
  "name": "review-yeti-ingress",
  "url": "https://github.com/exampleorg/example-review-actions",
  "description": "Review Yeti coordinate-only repository dispatch ingress",
  "public": false,
  "default_permissions": {
    "contents": "write",
    "metadata": "read"
  },
  "default_events": []
}
```

1. Submit this manifest through GitHub's App manifest flow and review the
   generated permissions before clicking **Create GitHub App**.
2. Install the App only on `exampleorg/example-review-actions`.
3. Store its App ID and private key as the public caller's
   `REVIEW_YETI_DISPATCH_APP_ID` and
   `REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY` secrets.

The checked-in `tools/create-review-dispatch-app.sh` provisions the internal
`CT_REVIEW_BOT_APP_*` identity, not this ingress identity. Keep its installation
and secrets separate. The public target App must be provisioned independently
with `Actions: write`; no ingress or central-tooling manifest should copy that
permission.

---

### Method 2: Manual UI Setup

If you prefer using the GitHub web interface:

1. **Navigate to App Settings**:
   * For Organizations: `https://github.com/organizations/<your-org>/settings/apps/new`
   * For Personal Accounts: `https://github.com/settings/apps/new`
2. **General Settings**:
   * **GitHub App name**: `my-org-review-bot` (must be globally unique)
   * **Homepage URL**: `https://github.com/<your-org>/<your-review-repo>`
   * **Webhook**: Uncheck **Active** (unless using webhook dispatch).
3. **Configure the App registration for the selected identity**:
   * Public ingress App registration: `Contents` **Read and write** and
     `Metadata` **Read-only**;
     no `Actions`, `Checks`, `Issues`, or `Pull requests` permission.
   * Public target App registration: `Actions`, `Checks`, `Issues`, and
     `Pull requests` **Read and write**, `Contents` **Read-only**, and
     `Metadata` **Read-only**.
   * Internal exampleorg App registration: `Actions`, `Checks`, `Contents`,
     `Issues`, and `Pull requests` **Read and write**, plus `Metadata`
     **Read-only**. This is the App-level union used by same-owner targets.
   * Central tooling token (not an App registration): the workflow narrows the
     internal App to the exact `example-review-actions` repository and requests only
     `Actions` and `Contents` **Read-only** for that short-lived token.
4. **Create & Generate Private Key**:
   * Click **Create GitHub App**.
   * Under **General > Private keys**, click **Generate a private key**.
   * Save the downloaded `.pem` file securely.
   * Note the **App ID** displayed at the top of the General settings page.

---

## Installing the route-specific Apps

Install each identity separately and always choose **Only select repositories**;
never give any Review Yeti App an all-repositories installation.

1. Install the **Public ingress App** only on
   `exampleorg/example-review-actions`.
2. Install the **Public target App** only on
   `review-yeti-ai/review-yeti-bot`.
3. Install the **Internal exampleorg target App** only on the central
   `exampleorg/example-review-actions` repository and the explicitly approved
   same-owner consumer repositories. Do not install it in the public target
   organization. Each workflow token must still list only its exact target
   repository, or only `example-review-actions` for central validation; installation
   membership is not permission to mint a multi-repository token.
4. Store each App's ID and private key only in the secret boundary named in
   [Configuring App Secrets](#configuring-app-secrets).

### Cross-owner installations

An installation token belongs to one account owner. The `repositories` input
contains repository names under that owner; it does not accept a mixture of
`owner/repository` values from different organizations. Install the same App
separately for each owner and mint a separate token for each installation.

Admission is owner-scoped for the exampleorg fleet, with one explicit
cross-owner exception: `review-yeti-ai/review-yeti-bot` at
`.github/workflows/ct-review-bot.yml`. That exception uses three deliberately
separate boundaries:

* the internal `ct-review-bot` App is never installed in the public target
  organization. For this external route, its central token is scoped only to
  `exampleorg/example-review-actions` and is exposed through
  `CT_REVIEW_BOT_APP_ID` / `CT_REVIEW_BOT_APP_PRIVATE_KEY` only in the central
  workflow;
* `REVIEW_YETI_PUBLIC_TARGET_APP_ID` /
  `REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY` identify the Review Yeti App. Its
  installation may cover the reviewer organization's repositories, but central
  requests a token narrowed to the exact public
  `review-yeti-ai/review-yeti-bot` repository for target PR reads, check
  publication, and the post-SHIP `validate.yml` dispatch (`Actions: write`),
  never for central tooling;
* `REVIEW_YETI_DISPATCH_APP_ID` /
  `REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY` identify an ingress App installed only
  on `exampleorg/example-review-actions`. The public caller can submit the
  coordinate-only `repository_dispatch`, but cannot read the private central
  repository through that token.

The external route is therefore an asynchronous dispatch shim, not a public
reusable-workflow call. GitHub does not expose private reusable workflows to
public callers. Provider credentials remain central, and a missing installation,
unavailable secret, or insufficient App permission fails closed before review
execution. The central validator also requires the public caller to be exactly
the two-step, SHA-pinned dispatch shape: mint the ingress App token, then submit
one coordinate-only POST to the central `repository_dispatch` endpoint. There is
no checkout, extra API write, PAT, or ambient `github.token` fallback.

---

## Configuring App Secrets

Store each identity only where its workflow runs, using the exact names from
the workflow boundary. Never expose `CT_REVIEW_BOT_APP_PRIVATE_KEY` or a public
target key to the public ingress caller.

```bash
# Public ingress caller: Contents: write only.
gh secret set REVIEW_YETI_DISPATCH_APP_ID --repo review-yeti-ai/review-yeti-bot --body "<APP_ID>"
gh secret set REVIEW_YETI_DISPATCH_APP_PRIVATE_KEY --repo review-yeti-ai/review-yeti-bot < /path/to/private-key.pem

# Central workflow: private central tooling App and exact public target App.
gh secret set CT_REVIEW_BOT_APP_ID --org exampleorg --body "<APP_ID>"
gh secret set CT_REVIEW_BOT_APP_PRIVATE_KEY --org exampleorg < /path/to/private-key.pem
gh secret set REVIEW_YETI_PUBLIC_TARGET_APP_ID --org exampleorg --body "<APP_ID>"
gh secret set REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY --org exampleorg < /path/to/private-key.pem
```

> [!TIP]
> Use Organization Secret visibility set to **Selected repositories** to grant
> each private key only to the workflow repository that needs that identity.

---

## Minting Tokens in Workflows

In your GitHub Actions workflows, use the official `actions/create-github-app-token` action to generate short-lived tokens on the fly:

```yaml
- name: Mint Review Yeti public target token
  id: bot_token
  uses: actions/create-github-app-token@<40-character-commit-sha>
  with:
    app-id: ${{ secrets.REVIEW_YETI_PUBLIC_TARGET_APP_ID }}
    private-key: ${{ secrets.REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY }}
    owner: review-yeti-ai
    repositories: review-yeti-bot
    permission-actions: write
    permission-checks: write
    permission-contents: read
    permission-issues: write
    permission-pull-requests: write

- name: Post Check Run
  env:
    GH_TOKEN: ${{ steps.bot_token.outputs.token }}
  run: |
    gh api --method POST "repos/${{ github.repository }}/check-runs" \
      -f name="Review Yeti" \
      -f head_sha="${{ github.event.pull_request.head.sha }}" \
      -f status="completed" \
      -f conclusion="success"
```
