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

## Required Permissions

When creating the GitHub App, configure the following repository-level permissions:

| Permission | Access | Purpose |
| :--- | :--- | :--- |
| **Checks** | **Read & write** | Allows the app to create and update `Review Yeti` Check Runs directly on pull request head commits. |
| **Pull requests** | **Read & write** | Reads PR metadata, diffs, changed files, and posts review comments / inline feedback threads. |
| **Contents** | **Read-only** | Reads repository files and git commit history to validate base and head commit SHAs. |
| **Issues** | **Read & write** | Posts high-level review summaries, notifications, or diagnostic comments on pull request conversations. |
| **Metadata** | **Read-only** | Mandatory default for all GitHub Apps to query repository identifiers. |

> [!NOTE]
> No Account, Organization, or User permissions are required. Keep permissions strictly at the repository level.

### Webhook Events
* **Webhook**: Active / Inactive (optional). If using GitHub Actions dispatch triggers (`workflow_dispatch` / `repository_dispatch`), webhooks can be disabled (`Active: false`). If running an event-driven review receiver, subscribe to `Pull request`.

---

## Setup Methods

### Method 1: Automated Manifest Flow (Recommended)

GitHub provides a Manifest conversion flow that pre-fills all app metadata and permissions via an automated browser redirect.

You can run the provided script in `tools/create-review-dispatch-app.sh` or create an app manifest programmatically:

```json
{
  "name": "review-yeti-dispatch",
  "url": "https://github.com/example-org/review-actions",
  "description": "Review Yeti automated AI code review identity",
  "public": false,
  "default_permissions": {
    "checks": "write",
    "contents": "read",
    "pull_requests": "write",
    "issues": "write",
    "metadata": "read"
  },
  "default_events": []
}
```

1. Run the script:
   ```bash
   APP_NAME="my-review-bot" ./tools/create-review-dispatch-app.sh
   ```
2. The script launches a temporary local listener on `http://127.0.0.1:8788/callback` and opens your browser.
3. Review the permissions on GitHub and click **Create GitHub App**.
4. GitHub exchanges the conversion code; the script retrieves the **App ID** and **Private Key (`.pem`)** and securely saves them directly to your organization secrets.

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
3. **Configure Permissions**:
   * Repository Permissions:
     * `Checks`: **Read and write**
     * `Contents`: **Read-only**
     * `Issues`: **Read and write**
     * `Pull requests`: **Read and write**
     * `Metadata`: **Read-only**
4. **Create & Generate Private Key**:
   * Click **Create GitHub App**.
   * Under **General > Private keys**, click **Generate a private key**.
   * Save the downloaded `.pem` file securely.
   * Note the **App ID** displayed at the top of the General settings page.

---

## Installing the App on Repositories

1. Go to your App's settings page:
   `https://github.com/organizations/<your-org>/settings/apps/<app-slug>/installations`
2. Click **Install App**.
3. Select **Only select repositories**:
   * Add the **Central Review Repository** (e.g., `my-org/review-actions`).
   * Add all **Consumer Repositories** where Review Yeti will review pull requests.
4. Click **Install**.

---

## Configuring Organization Secrets

Store the App credentials as Organization Secrets so workflows across the fleet can mint ephemeral tokens:

```bash
# Set the App ID
gh secret set REVIEW_BOT_APP_ID --org <your-org> --body "<APP_ID>"

# Set the Private Key
gh secret set REVIEW_BOT_APP_PRIVATE_KEY --org <your-org> < /path/to/private-key.pem
```

> [!TIP]
> Use Organization Secret visibility settings (`Selected repositories` or `All repositories`) to restrict which repositories can access the private key.

---

## Minting Tokens in Workflows

In your GitHub Actions workflows, use the official `actions/create-github-app-token` action to generate short-lived tokens on the fly:

```yaml
- name: Mint Review Yeti Token
  id: bot_token
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.REVIEW_BOT_APP_ID }}
    private-key: ${{ secrets.REVIEW_BOT_APP_PRIVATE_KEY }}
    owner: ${{ github.repository_owner }}
    repositories: "review-actions,my-repo"

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
