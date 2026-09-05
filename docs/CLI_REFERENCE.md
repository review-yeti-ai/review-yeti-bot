# 💻 Review Yeti — CLI Reference & Git Hook Guide

The `review-yeti` CLI (also available as `git-yeti` and `git yeti`) brings Review Yeti's multi-persona AI evaluation and security analysis directly into the local developer workflow. Run lightning-fast pre-commit evaluations in under 5 seconds, install automated git hooks, and execute the 30-second automated GitHub App Setup Wizard without manually copying tokens.

---

## 📋 Table of Contents

1. [Installation & Command Invocation](#installation--command-invocation)
2. [Commands Overview](#commands-overview)
3. [`review-yeti pre-commit`](#review-yeti-pre-commit)
   - [Staged Diff Evaluation (`git diff --cached`)](#staged-diff-evaluation-git-diff---cached)
   - [Sub-10ms Static Secret Scanner](#sub-10ms-static-secret-scanner)
   - [Fast Flash Model Evaluation (< 5s)](#fast-flash-model-evaluation--5s)
   - [ANSI Color Formatting & NO_COLOR](#ansi-color-formatting--no_color)
   - [Exit Codes & Blocking P0 Commits](#exit-codes--blocking-p0-commits)
   - [CLI Flags](#cli-flags-pre-commit)
4. [`review-yeti init` (30-Second Setup Wizard)](#review-yeti-init-30-second-setup-wizard)
   - [GitHub App Manifest Flow](#github-app-manifest-flow)
   - [Least-Privilege Permissions Matrix](#least-privilege-permissions-matrix)
   - [Restricted `.env` Generation (`0o600`)](#restricted-env-generation-0o600)
   - [Automatic `.gitignore` Hardening](#automatic-gitignore-hardening)
   - [GitHub CLI Secret Sync (`gh secret set`)](#github-cli-secret-sync-gh-secret-set)
   - [CLI Flags](#cli-flags-init)
5. [`review-yeti install-hook` & Git Hooks](#review-yeti-install-hook--git-hooks)
   - [Native Git Hook (`.git/hooks/pre-commit`)](#native-git-hook-githookspre-commit)
   - [Husky Integration (`.husky/pre-commit`)](#husky-integration-huskypre-commit)
6. [Examples & Recipes](#examples--recipes)
7. [Troubleshooting](#troubleshooting)

---

## 🚀 Installation & Command Invocation

You can invoke Review Yeti locally via several entry points:

### 1. Zero-Install with `npx` (Recommended)
```bash
npx review-yeti pre-commit
npx review-yeti init
```

### 2. Git Subcommand (`git yeti`)
Because git looks for executables matching `git-<subcommand>` in your `$PATH`, installing Review Yeti provides native `git yeti` syntax:
```bash
npm install -g review-yeti-bot
git yeti pre-commit
```

### 3. Local Project Dependency
```bash
npm install --save-dev review-yeti-bot
./node_modules/.bin/review-yeti pre-commit
```

---

## 📋 Commands Overview

| Command | Description |
|---|---|
| `review-yeti init` | Launches the 30-second GitHub App Manifest onboarding wizard. |
| `review-yeti pre-commit` | Evaluates staged changes (`git diff --cached`) for P0/P1 issues before committing. |
| `review-yeti install-hook` | Installs Review Yeti into `.git/hooks/pre-commit` or `.husky/pre-commit`. |
| `review-yeti --version` (`-v`) | Displays the installed CLI version. |
| `review-yeti --help` (`-h`) | Displays CLI command usage and available flags. |

---

## 🔍 `review-yeti pre-commit`

The `pre-commit` command evaluates your staged git changes locally before `git commit` finalizes the commit object.

```bash
review-yeti pre-commit [options]
# or
git yeti pre-commit [options]
```

### Staged Diff Evaluation (`git diff --cached`)

When executed, Review Yeti:
1. Runs `git diff --cached` to capture the exact staging area changes.
2. If no files are staged, it exits immediately with code `0`:
   ```
   ✅ No staged git changes detected. Commit proceeding.
   ```
3. Filters out noise, lockfiles, and minified artifacts using `filterDiffHunks`:
   - Excluded: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `cargo.lock`, `composer.lock`, `Gemfile.lock`.
   - Excluded: Minified bundles (`*.min.js`, `*.min.css`, `dist/**`, `build/**`).
   - Excluded: Pure binary diffs and asset images.

### Sub-10ms Static Secret Scanner

Before making any external model calls, Review Yeti runs a pre-flight regex scanner across the staged diff that completes in under 10 milliseconds:

| Pattern Name | Regular Expression Pattern | Severity | Suggestion |
|---|---|---|---|
| **AWS Access Key** | `AKIA(?!0{16})[0-9A-Z]{16}` | **P0** | Use `AWS_ACCESS_KEY_ID` or IAM roles. |
| **GitHub Token** | `(?:ghp_[a-zA-Z0-9]{36}\|github_pat_[a-zA-Z0-9_]{82})` | **P0** | Use `GITHUB_TOKEN` environment variable. |
| **RSA Private Key** | `-----BEGIN (?:RSA )?PRIVATE KEY-----` | **P0** | Never commit private keys; store in vault. |
| **Generic Key** | `-----BEGIN (?:OPENSSH\|EC\|DSA) PRIVATE KEY-----` | **P0** | Remove private keys from git history. |
| **Slack Token** | `xox[baprs]-[0-9]{10,13}-[0-9]{10,13}[a-zA-Z0-9-]*` | **P0** | Store Slack credentials in environment variables. |
| **OpenAI Key** | `sk-[a-zA-Z0-9]{32,48}` | **P0** | Store OpenAI keys in `.env` or secret manager. |

> [!NOTE]
> The scanner includes false-positive protection: test mocks composed of all zeros (e.g., `AKIA0000000000000000`) or regex template strings in markdown documentation are safely ignored.

### Fast Flash Model Evaluation (< 5s)

If credentials pass static pre-flight, Review Yeti evaluates remaining logic changes using high-speed flash models:
- **Default model**: `openrouter/deepseek/deepseek-v4-flash-0731:low` or `google/gemini-2.5-flash`
- **Latency target**: Under 5.0 seconds for typical pull request commits (< 500 LOC).
- **Offline / Local Fallback**: Supports local [Ollama](https://ollama.com) models (e.g. `ollama/qwen2.5-coder:7b`) for completely air-gapped development.

### ANSI Color Formatting & NO_COLOR

Diagnostics output to terminal with high-visibility ANSI styling:
- **`[P0]`**: Bold Red (`\x1b[1;31m`) — Critical blockers, exposed credentials, data loss hazards.
- **`[P1]`**: Bold Yellow (`\x1b[1;33m`) — Significant architectural, SQL injection, or performance flaws.
- **`[P2]`**: Cyan (`\x1b[36m`) — Style, documentation, and cosmetic improvement recommendations.

Review Yeti adheres strictly to the [NO_COLOR specification](https://no-color.org):
- Pass the `--no-color` flag, or
- Set the `NO_COLOR=1` environment variable.

### Exit Codes & Blocking P0 Commits

| Exit Code | Condition | Behavior |
|---|---|---|
| **`0`** | Clean commit or only non-blocking P2 nits detected. | Commit succeeds. |
| **`1`** | One or more **P0** findings detected. | **Commit is aborted.** |
| **`1`** | One or more **P1** findings detected **and `--strict` flag is enabled**. | **Commit is aborted.** |

```
🔍 Review Yeti Pre-Commit Evaluation (2 files scanned in 12.4ms):
--------------------------------------------------------------------------------

[P0] AWS Access Key at src/api/awsClient.ts:8
  AWS Access Key ID detected in staged changes
  💡 Suggestion: Use environment variables (AWS_ACCESS_KEY_ID) or AWS IAM roles instead of hardcoding credentials.

--------------------------------------------------------------------------------
[P0] Commit blocked: 1 blocking P0 issue(s) detected. Fix before committing.
```

### CLI Flags (`pre-commit`)

```
OPTIONS:
  --strict             Block commit on P1 issues in addition to P0 blocking issues
  --no-color           Disable ANSI color codes (also honors NO_COLOR env var)
  --json               Output machine-readable JSON evaluation report
  --diff <file>        Evaluate diff from a specific patch file instead of git diff --cached
  --model <model>      Use specific flash model (e.g. deepseek/deepseek-chat, gemini-2.5-flash)
  --quiet, -q          Suppress non-essential console logs
```

---

## ⚡ `review-yeti init` (30-Second Setup Wizard)

The `init` wizard automates GitHub App registration and local credential setup using the **GitHub App Manifest Flow**. You don't need to manually create an app, toggle 20 checkboxes in GitHub settings, copy-paste private keys, or manually configure webhooks.

```bash
npx review-yeti init [options]
```

### GitHub App Manifest Flow

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant CLI as review-yeti init
    participant Browser as Default Browser
    participant GH as GitHub Manifest Service

    CLI->>CLI: Start local HTTP callback listener (port 3333)
    CLI->>CLI: Generate least-privilege manifest JSON
    CLI->>Browser: Open https://github.com/settings/apps/new?manifest={...}
    Browser->>GH: Displays pre-configured GitHub App creation form
    Dev->>GH: Clicks "Create GitHub App"
    GH->>Browser: Redirects to http://localhost:3333/callback?code=TEMP_CODE
    Browser->>CLI: Sends GET /callback?code=TEMP_CODE
    CLI->>GH: POST /app-manifests/{TEMP_CODE}/conversions
    GH-->>CLI: Returns App ID, Private Key PEM, Webhook Secret
    CLI->>CLI: Writes .env file (mode 0o600)
    CLI->>CLI: Hardens .gitignore
    opt --gh-secrets specified
        CLI->>GH: Runs `gh secret set` for repo
    end
    CLI->>Dev: Setup complete! (Under 30 seconds)
```

### Least-Privilege Permissions Matrix

The wizard enforces strict least-privilege security. It requests **only** the permissions Review Yeti needs to perform reviews and update check runs:

| Scope | Permission | Justification |
|---|---|---|
| **`checks`** | `write` | Create and update pull request Check Runs (`SHIP`, `FIX_FIRST`, `BLOCK`). |
| **`pull_requests`** | `write` | Read PR diffs, post inline review comments, and emit ````suggestion ` blocks. |
| **`contents`** | `read` | Read `.ct-review.yaml` configuration and persona charters from the base branch. |
| **`issues`** | `write` | Post PR summary comments and reply to `@review-yeti` timeline chat commands. |
| **`metadata`** | `read` | Read basic repository information and installation routing. |

#### Strictly Forbidden Permissions
Review Yeti **never** requests elevated administrative or high-risk permissions:
- ❌ `administration` (forbidden)
- ❌ `secrets` (forbidden)
- ❌ `workflows` (forbidden)
- ❌ `members` (forbidden)
- ❌ `organization_administration` (forbidden)

### Restricted `.env` Generation (`0o600`)

Once credentials are exchanged, Review Yeti writes a secure local `.env` configuration:
```env
GITHUB_APP_ID=1092842
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgk..."
GITHUB_WEBHOOK_SECRET=whsec_8f9c1e7a...
```

The file is written with strict filesystem permissions (`0o600`), readable and writable only by the current user account.

### Automatic `.gitignore` Hardening

To prevent accidental credential leaks, the wizard automatically verifies and updates your root `.gitignore`:
```gitignore
# Review Yeti secrets
*.pem
.env
.review-yeti/
```

### GitHub CLI Secret Sync (`gh secret set`)

If you pass `--gh-secrets` (or specify `--repo owner/repo`), Review Yeti automatically synchronizes your newly minted App ID, Private Key, and Webhook Secret directly into your GitHub repository secrets using the official GitHub CLI:

```bash
npx review-yeti init --gh-secrets --repo my-org/my-repo
```

This sets:
- `GH_APP_ID`
- `GH_APP_PRIVATE_KEY`
- `GH_WEBHOOK_SECRET`

### CLI Flags (`init`)

```
OPTIONS:
  --port <number>      Port for local callback listener (default: 3333, auto-fallback)
  --org <name>         Create app under a GitHub organization (e.g. --org my-org)
  --name <name>        Custom name for the GitHub App (default: review-yeti)
  --no-browser         Print creation URL to terminal instead of auto-opening browser
  --env-file <path>    Custom path for .env file (default: .env)
  --pem <path>         Write private key to a separate .pem file
  --write-pem          Enable writing standalone PEM key file
  --gh-secrets         Automatically set repository secrets using GitHub CLI (gh)
  --repo <owner/repo>  Target repository for gh secret set
  --dry-run            Display manifest JSON and creation URL without starting server
  --json               Output machine-readable manifest JSON in dry-run mode
  --quiet, -q          Suppress non-essential console output
```

---

## 🪝 `review-yeti install-hook` & Git Hooks

Automatically block bad commits before they leave your workstation by installing Review Yeti as a pre-commit git hook.

### Native Git Hook (`.git/hooks/pre-commit`)

Run:
```bash
npx review-yeti install-hook
```

This creates `.git/hooks/pre-commit` with executable permissions (`0o755`):

```sh
#!/bin/sh
# Review Yeti pre-commit hook
# Evaluates staged changes before committing

if command -v npx >/dev/null 2>&1; then
  npx review-yeti pre-commit "$@"
elif command -v review-yeti >/dev/null 2>&1; then
  review-yeti pre-commit "$@"
elif command -v git-yeti >/dev/null 2>&1; then
  git-yeti pre-commit "$@"
else
  echo "[review-yeti] Warning: review-yeti CLI not found in PATH. Skipping hook."
fi
```

### Husky Integration (`.husky/pre-commit`)

For teams managing hooks via [Husky](https://typicode.github.io/husky/):

```bash
npx review-yeti install-hook --husky
```

Or manually add it to `.husky/pre-commit`:
```bash
npx husky add .husky/pre-commit "npx review-yeti pre-commit"
```

---

## 💡 Examples & Recipes

### 1. Run Pre-Commit on Staged Changes
```bash
git add src/auth/login.ts
git yeti pre-commit
```

### 2. Strict Mode: Block on Both P0 and P1 Issues
```bash
npx review-yeti pre-commit --strict
```

### 3. Evaluate an External Patch File
```bash
npx review-yeti pre-commit --diff /tmp/feature.patch --json
```

### 4. CI Output in Machine-Readable JSON
```bash
npx review-yeti pre-commit --json > review-verdict.json
```

### 5. Automated Organization Setup in Headless Environments
```bash
npx review-yeti init --org acme-corp --no-browser --gh-secrets --repo acme-corp/api-service
```

---

## 🛠️ Troubleshooting

| Issue | Cause | Resolution |
|---|---|---|
| **Port 3333 in use during `init`** | Another local service is bound to 3333 | The wizard automatically retries on an ephemeral port. Alternatively, specify `--port 4444`. |
| **`pre-commit` times out** | Remote LLM provider latency or connection issue | Use a fast flash model (e.g., `--model google/gemini-2.5-flash`), or run against local Ollama. |
| **`gh secret set` fails** | GitHub CLI not authenticated | Run `gh auth login` before running `review-yeti init --gh-secrets`. |
| **Pre-commit hook not executing** | File lacks executable bit | Run `chmod +x .git/hooks/pre-commit`. |
| **Terminal colors unreadable on light theme** | Shell color theme contrast | Run with `--no-color` or export `NO_COLOR=1`. |

---

👉 **Next Steps**:
- See [Interactive PR Chat Guide](INTERACTIVE_CHAT.md) for conversational code mentoring.
- See [Team Memory Guide](TEAM_MEMORY.md) for learning from suppressed nits.
- See [User Guide](USER_GUIDE.md) for web dashboard workflows.
