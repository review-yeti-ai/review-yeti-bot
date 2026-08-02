# GitHub App setup

Configure the private `ct-review-bot` App with:

- Homepage: `https://review-bot.calltelemetry.com`
- Webhook: `https://review-bot.calltelemetry.com/webhook`
- Events: pull request, issue comment, pull-request review comment
- Repository permissions:
  - metadata: read
  - contents: read
  - pull requests: write
  - issues: write
  - checks: write

Store only these values in managed GitHub/Kubernetes secrets:

- `CT_REVIEW_GITHUB_APP_ID`
- `CT_REVIEW_GITHUB_APP_PRIVATE_KEY`
- `CT_REVIEW_GITHUB_INSTALLATION_ID`
- `CT_REVIEW_WEBHOOK_SECRET`
- `CT_REVIEW_OMNIROUTE_STORAGE_KEY`
- `CT_REVIEW_OMNIROUTE_API_KEY`

The installation ID is required by dispatched worker Jobs. The bot creates an
RS256 App JWT and exchanges it for a short-lived installation token. It refuses
a missing permission or a token without the `ghs_` prefix.

Never commit a populated secret manifest. Rotate the client secret, webhook
secret, App private key, storage key, and OmniRoute API key after any exposure.
