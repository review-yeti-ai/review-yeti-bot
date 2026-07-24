# Handoff Report: `src/router/tokenManager.ts` Design

**Agent**: Explorer 2 (Milestone 2)  
**Target File**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/src/router/tokenManager.ts`  
**Analysis File**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_2/analysis.md`  
**Handoff Type**: Hard Handoff (Task Complete)  

---

## 1. Observation

1. **Environment & Package Configuration**:
   - `package.json` specifies `"engines": { "node": ">=20.0.0" }` and TypeScript dependencies `zod` (`^3.23.8`) and `@types/node` (`^20.12.12`).
   - Node 20 natively supports `node:crypto` cipher algorithms including `aes-256-gcm`, eliminating external encryption library dependencies.

2. **Existing Types and Schema (`src/config/schema.ts`)**:
   - `PersonaEnum`: `z.enum(['security', 'architecture', 'performance', 'quality'])` (line 3).
   - `EffortLevelEnum`: `z.enum(['low', 'medium', 'high', 'reasoning'])` (line 6).

3. **Existing Token Handling & Mock Infrastructure**:
   - `src/gateway/omniRouteClient.ts` lines 52-72: Defines `refreshOAuthToken()` sending `grant_type: 'refresh_token'` to `${this.baseUrl}/v1/oauth/token`.
   - `tests/e2e/harness/mockOmniRouteServer.ts` lines 99-125: Exposes `/v1/oauth/token`, returning `{ access_token, token_type: 'Bearer', expires_in: 3600, refresh_token }`.

---

## 2. Logic Chain

1. **Secret Storage Security**:
   - *Observation*: API keys and OAuth refresh tokens must be kept safe in memory and when serialized.
   - *Deduction*: Implementing `SecureSecretStore` using Node's `node:crypto` `aes-256-gcm` cipher with 12-byte random IVs and 16-byte authentication tags provides authenticated symmetric encryption. Using SHA-256 derivation on `process.env.CT_SECRET_MASTER_KEY` guarantees a valid 32-byte AES key.

2. **OAuth Token Refresh Reliability**:
   - *Observation*: High concurrency in PR reviews can trigger multiple simultaneous requests when access tokens expire.
   - *Deduction*: Implementing an in-flight Promise map (`inFlightRefreshes`) acts as a single-flight mutex. Preemptive refresh (60s window before `expiresAt`) eliminates HTTP 401 latency spikes.

3. **Token Consumption Accounting**:
   - *Observation*: `ct-review-bot` executes multi-persona parallel reviews per PR.
   - *Deduction*: `TokenMetricsTracker` records `TokenUsageRecord` per request and provides rollup aggregations per persona (`security`, `architecture`, `performance`, `quality`) and per provider (`openai`, `anthropic`, etc.).

4. **Dynamic Effort Scaling**:
   - *Observation*: Review tasks range from trivial formatting checks to deep architectural and security reviews.
   - *Deduction*: `EffortScaler` maps effort levels (`low`, `medium`, `high`, `reasoning`) to token budget limits (1k/4k/8k/16k output tokens, 4k/16k/32k/64k prompt budgets), temperatures (0.1 - 0.5), timeouts (15s - 120s), and provider-specific reasoning parameters (`reasoning_effort` for OpenAI, `thinking` budget for Anthropic).

---

## 3. Caveats

- **Process Memory Lifetime**: `SecureSecretStore` stores encrypted payloads in memory by default. If persistent secret storage across daemon restarts is required, the store's `exportEncryptedStore()` output can be serialized to SQLite (`src/persistence/db.ts`) or disk.
- **Provider API Variations**: Anthropic's extended thinking parameters require specific headers or prompt payload fields, which `EffortScaler.getEffortConfig()` accounts for via `providerExtraParams`.

---

## 4. Conclusion

`src/router/tokenManager.ts` is fully designed and specified with complete TypeScript interface definitions and concrete implementations for:
- `SecureSecretStore` (AES-256-GCM authenticated secret management)
- `TokenMetricsTracker` (per-request & per-persona metrics aggregation)
- `EffortScaler` (dynamic effort level scaling matrix & provider param formatting)
- `TokenManager` (unified orchestrator managing refresh single-flight locks, credentials, metrics, and scaling)

The full specification and code implementation blueprint are saved in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_2/analysis.md`.

---

## 5. Verification Method

1. **Inspect Analysis Artifact**:
   - View `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_2/analysis.md`.

2. **Validation Commands (upon implementation by Worker)**:
   - Run type checking: `npm run lint`
   - Run unit tests: `npm test tests/unit/tokenManager.test.ts`
   - Run full test suite: `npm test`
