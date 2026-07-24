# GitHub App Setup & Bot Account Integration Guide

This guide walks through configuring the **`ct-review-bot`** GitHub App so that reviews, inline code comments, and status checks are published natively under the official **`ct-review-bot[bot]`** account (instead of personal user developer tokens).

---

## 1. 1-Click GitHub App Manifest Creation

Navigate to your GitHub Organization App creation page:
- **URL**: `https://github.com/organizations/calltelemetry/settings/apps/new`

### App Manifest Configuration:
```json
{
  "name": "ct-review-bot",
  "url": "https://review-bot.calltelemetry.com",
  "hook_attributes": {
    "url": "https://review-bot.calltelemetry.com/webhook",
    "active": true
  },
  "public": false,
  "default_permissions": {
    "pull_requests": "write",
    "issues": "write",
    "contents": "read",
    "metadata": "read"
  },
  "default_events": [
    "pull_request",
    "issue_comment",
    "pull_request_review_comment"
  ]
}
```

---

## 2. Credentials & Environment Setup

After creating the GitHub App and installing it on `calltelemetry` repositories:

1. **App ID**: Found on the App Settings page (e.g. `1029384`).
2. **Private Key**: Generate a Private Key (`.pem` file) under App Settings.
3. **Installation ID**: Found in the URL when viewing installed organization apps (`https://github.com/organizations/calltelemetry/settings/installations/<INSTALLATION_ID>`).

Set these variables in `k8s/secret.yaml` or container environment:

```env
GITHUB_APP_ID=1029384
GITHUB_APP_INSTALLATION_ID=5930281
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
```

---

## 3. How Token Generation Works (`src/github/appAuth.ts`)

1. **JWT Generation**: `generateGitHubAppJwt()` creates a 2048-bit RS256-signed JWT valid for 10 minutes.
2. **Installation Token Exchange**: `getGitHubAppInstallationToken()` calls `POST /app/installations/:id/access_tokens` to retrieve a fresh `ghs_...` Installation Access Token.
3. **Bot Account Commenting**: All REST requests set `Authorization: Bearer ghs_...` and `User-Agent: ct-review-bot[bot]`.
4. **GitHub UI Display**: Comments posted with `ghs_...` tokens carry the official **`ct-review-bot[bot]`** badge in the GitHub UI.
