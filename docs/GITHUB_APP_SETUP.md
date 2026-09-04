# 🔐 Setting Up a GitHub App for Review Yeti

This guide walks you through creating and configuring a **GitHub App** for Review Yeti. 

While Review Yeti can run as a basic standalone GitHub Action using the built-in `GITHUB_TOKEN`, configuring a GitHub App unlocks **native GitHub Check Runs**, **independent API rate limits**, **secure merge gate status checks**, and **cross-repository review automation** without requiring personal access tokens (PATs).

---

## 🌟 Why Use a GitHub App?

| Feature | GitHub App 🏆 | Personal Access Token (PAT) ⚠️ | Default `GITHUB_TOKEN` ℹ️ |
| :--- | :--- | :--- | :--- |
| **Checks API (`checks:write`)** | ✅ Full access to create native Check Runs and annotations | ⚠️ Requires broad repo-admin scope | ❌ Often restricted; cannot trigger downstream workflows |
| **API Rate Limits** | 🚀 **5,000 to 15,000 req/hr** per installation (independent) | 🐢 5,000 req/hr shared across all user activities | ⏱️ 1,000 req/hr per repo (shared by all CI jobs) |
| **Token Lifetime** | 🔒 **1 hour** (ephemeral `ghs_` token minted via RS256 JWT) | 🚨 Long-lived (days, months, or infinite) | ⏳ Job execution duration only |
| **Audit & Attribution** | 🤖 Cleanly branded as your bot (e.g., `review-yeti[bot]`) | 👤 Tied to an individual developer's account | ⚙️ Generic `github-actions[bot]` |
| **Cross-Repo Access** | ✅ Single App install covers entire organization or selected repos | ⚠️ Grants access to all repos the user can see | ❌ Strictly isolated to the executing repository |
| **Kubernetes Worker Mode** | ✅ Worker pods mint tokens directly from App private key | ❌ Insecure to mount personal tokens | ❌ Not available outside the runner VM |

---

## 📋 Step-by-Step Setup Guide

### Step 1: Create a New GitHub App

1. Navigate to your GitHub Organization settings (recommended) or Personal account settings:
   - **Organization**: `https://github.com/organizations/<your-org>/settings/apps`
   - **Personal**: `https://github.com/settings/apps`
2. Click **New GitHub App**.
3. Fill in the **Basic Information**:
   - **GitHub App name**: `review-yeti-bot` (or `my-org-review-bot`)
   - **Homepage URL**: `https://github.com/review-yeti-ai/review-yeti-bot` (or your company internal dashboard URL, e.g. `https://review-bot.example.com`)
   - **Description**: `Autonomous AI Code Review Panel for Pull Requests`

---

### Step 2: Configure Webhook (Optional)

- If you run **Standalone GitHub Action** or **Async Dispatch Mode**, you can uncheck **Active** under the Webhook section (no webhook required).
- If you run **Self-Hosted Webhook Ingress Mode** (e.g., Review Yeti Kubernetes Ingress), configure:
  - **Webhook URL**: `https://review-bot.example.com/webhook`
  - **Webhook secret**: Generate a secure random string (e.g. `openssl rand -hex 32`) and save it for your secrets configuration.

---

### Step 3: Configure Repository Permissions

Review Yeti adheres to the principle of **least privilege**. Set the following permissions:

| Permission | Access Level | Why Review Yeti Needs This |
| :--- | :--- | :--- |
| **Checks** | **Read and write** | Create and update GitHub Check Runs (`review-status: DISPATCHED`, `gate-decision: SHIP/BLOCK`), post inline code annotations, and enforce merge gates. |
| **Pull requests** | **Read and write** | Fetch PR diffs, inspect modified files, post the consolidated AI panel review comment, and submit review verdicts (`APPROVE` or `REQUEST_CHANGES`). |
| **Contents** | **Read** | Read repository source code, configuration (`.ct-review.yaml`), and custom persona charters (`.ct-review/personas/*.md`) from the base branch. |
| **Issues** | **Write** | Post comments, label PRs, and update review status threads. |
| **Metadata** | **Read** | Mandatory default permission required by all GitHub Apps to inspect repository metadata. |

> [!TIP]
> Leave all other permissions (such as Administration, Commit statuses, Workflows, etc.) set to **No access**.

---

### Step 4: Subscribe to Events

Under **Subscribe to events**, select the events matching your deployment:

- ☑️ **Pull request** (opened, synchronize, reopened, ready_for_review)
- ☑️ **Pull request review comment** (created, edited)
- ☑️ **Issue comment** (created — enables interactive learning commands like `@review-yeti learn`)
- ☑️ **Check suite** (requested, rerequested)

---

### Step 5: Generate Private Key & Retrieve App ID

1. Click **Create GitHub App**.
2. On the App settings page, record your **App ID** (e.g. `123456`).
3. Scroll down to the **Private keys** section and click **Generate a private key**.
4. A `.pem` file will automatically download (e.g. `review-yeti-bot.2026-09-03.private-key.pem`). Keep this key secure!

---

### Step 6: Install the App on Repositories

1. On the left sidebar of your App's settings, click **Install App**.
2. Click **Install** next to your organization or user account.
3. Choose either:
   - **All repositories** (recommended for org-wide review automation)
   - **Only select repositories** (select the repos you want Review Yeti to review)
4. After installing, examine the URL in your browser:
   ```text
   https://github.com/organizations/my-org/settings/installations/98765432
   ```
   The number at the end (`98765432`) is your **Installation ID**.

---

## 🔒 Storing App Secrets

### Option A: In GitHub Actions Secrets (Centralized or Consumer Repos)

Add the following repository or organization secrets (under **Settings** > **Secrets and variables** > **Actions**):

| Secret Name | Description | Example / Format |
| :--- | :--- | :--- |
| `REVIEW_BOT_APP_ID` | Numeric App ID | `123456` |
| `REVIEW_BOT_APP_PRIVATE_KEY` | Entire PEM file contents | `-----BEGIN RSA PRIVATE KEY----- ... -----END RSA PRIVATE KEY-----` |
| `REVIEW_BOT_INSTALLATION_ID` | Numeric Installation ID | `98765432` |
| `REVIEW_BOT_WEBHOOK_SECRET` | *(Optional)* Webhook secret string | `a1b2c3d4e5...` |

#### Using the App in GitHub Actions Workflows

Use the official `tibdex/github-app-token` action or Review Yeti's built-in token resolver to mint a short-lived token:

```yaml
- name: Generate Review Yeti App Token
  id: app-token
  uses: actions/create-github-app-token@v1
  with:
    app-id: ${{ secrets.REVIEW_BOT_APP_ID }}
    private-key: ${{ secrets.REVIEW_BOT_APP_PRIVATE_KEY }}

- name: Run Review Yeti
  uses: review-yeti-ai/review-yeti-bot@v1
  with:
    github-token: ${{ steps.app-token.outputs.token }}
    llm-api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

---

### Option B: In Kubernetes Secrets (Kubernetes / DOKS Worker Mode)

When running Review Yeti in Kubernetes mode, store the credentials in a Kubernetes Secret inside your review namespace (e.g. `review-yeti-system`):

```bash
kubectl create namespace review-yeti-system --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic review-yeti-app-secrets \
  --namespace review-yeti-system \
  --from-literal=APP_ID="123456" \
  --from-literal=INSTALLATION_ID="98765432" \
  --from-file=PRIVATE_KEY="/path/to/review-yeti-bot.private-key.pem" \
  --from-literal=WEBHOOK_SECRET="your-secure-webhook-secret" \
  --dry-run=client -o yaml | kubectl apply -f -
```

---

## ⚙️ How Review Yeti Authenticates (Under the Hood)

Review Yeti uses GitHub's standard JSON Web Token (JWT) handshake:

```mermaid
sequenceDiagram
    autonumber
    participant Worker as Review Yeti Worker
    participant GH as GitHub API (/app)
    participant Repo as Target PR / Check Run

    Note over Worker: Read App ID & RS256 Private Key
    Worker->>Worker: Sign JWT (RS256, exp: 10 min, iss: APP_ID)
    Worker->>GH: POST /app/installations/{INSTALLATION_ID}/access_tokens<br/>Authorization: Bearer <JWT>
    GH-->>Worker: Return Installation Token (ghs_***, expires in 60 min)
    Worker->>Repo: Fetch base charters & PR diff using ghs_ token
    Worker->>Worker: Run AI Persona Panel & Synthesize Verdict
    Worker->>Repo: POST Check Run (Status: completed, conclusion: success/failure)
    Worker->>Repo: POST PR Review Comment
```

1. **JWT Minting**: Review Yeti crafts a signed RS256 JWT using `APP_ID` as issuer (`iss`) and signs it with the private key.
2. **Exchange**: Review Yeti posts the JWT to GitHub's `/app/installations/{installation_id}/access_tokens` endpoint.
3. **Installation Token (`ghs_`)**: GitHub validates the signature and returns an ephemeral installation access token prefixed with `ghs_`.
4. **Execution**: All diff fetching, comment posting, and check run updates use this token. The token expires automatically after 60 minutes.

---

## 🔍 Troubleshooting & Verification

### Common Errors

> [!WARNING]
> **Error: "Resource not accessible by integration" (HTTP 403)**
> - Verify that the GitHub App has been granted **Checks: Read and write** and **Pull requests: Read and write**.
> - Check that the App is installed on the specific target repository (or organization).

> [!TIP]
> **Error: "Invalid private key format"**
> - Ensure the entire PEM block is included, including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`.
> - Check that newlines were preserved when pasting into GitHub Actions secrets or Kubernetes secrets.

> [!NOTE]
> **Rate Limits Check**
> You can verify the GitHub App's current rate limits at any time using GitHub CLI:
> ```bash
> gh api rate_limit
> ```
