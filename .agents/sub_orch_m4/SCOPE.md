# Scope: Milestone 4 (GitHub App & Webhook Receiver Event Loop)

## Architecture
Milestone 4 connects GitHub Webhook events to the core evaluation engines (Milestones 1-3) and publishes review comments back to GitHub PRs via Octokit.

Component layout:
1. `src/github/signature.ts`: HMAC SHA-256 signature verification (`X-Hub-Signature-256`).
2. `src/github/webhookServer.ts`: Express web server receiving POST requests, raw body parsing, secret management, verification, route handling.
3. `src/github/eventHandler.ts`: Webhook Event Dispatcher & Listener handling PR events (`opened`, `synchronize`, `reopened`), comment command triggers (`@ct-review review`, `@bot review`), label/tag triggers, background job queueing.
4. `src/github/commentPublisher.ts`: Octokit PR Comment Publisher for inline code diff comments with ` ```suggestion ` blocks, PR summary reviews (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`), rate limit handling.
5. `src/app.ts`: Native event loop integration connecting Webhook Receiver -> Config Parser -> Ticket Linkage -> Constitution Engine -> Diff State Manager -> Quorum Engine -> Octokit Publisher.
6. Tests: `tests/unit/webhook.test.ts`, `tests/unit/publisher.test.ts`, `tests/integration/m4_webhook.test.ts`.

## Deliverables Checklist
- [ ] `src/github/signature.ts` implemented
- [ ] `src/github/webhookServer.ts` implemented
- [ ] `src/github/eventHandler.ts` implemented
- [ ] `src/github/commentPublisher.ts` implemented
- [ ] `src/app.ts` native event loop integrated
- [ ] `tests/unit/webhook.test.ts` implemented
- [ ] `tests/unit/publisher.test.ts` implemented
- [ ] `tests/integration/m4_webhook.test.ts` implemented
- [ ] `npm run build` succeeds (0 errors)
- [ ] `npm test` succeeds (100% tests passing)
