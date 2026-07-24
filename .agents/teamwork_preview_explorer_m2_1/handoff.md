# Handoff Report: `src/router/omniRouteAdapter.ts` Design

## 1. Observation

- **Project Root**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`
- **Compiler Configuration (`tsconfig.json:3-17`)**: Target is `ES2022`, Module is `CommonJS`, Module Resolution is `node`, Strict mode enabled, rootDir is `./src`, outDir is `./dist`.
- **Dependencies (`package.json:21-41`)**: Dependencies include `@octokit/core`, `express`, `js-yaml`, `zod`, `vitest`, `supertest`, `ts-node`, `typescript`. No external vendor LLM SDKs (such as `@anthropic-ai/sdk` or `openai`) are present.
- **Existing Gateway (`src/gateway/omniRouteClient.ts:84-129`)**: Standard `fetch` calls to `${this.baseUrl}/v1/chat/completions` with Bearer token authentication and 5xx fallback loop.
- **Existing E2E Mock (`tests/e2e/harness/mockOmniRouteServer.ts:128-167`)**: Handles `LLMRequestPayload` with `prompt`, `systemPrompt`, `persona`, `effortLevel`, `provider`, `model`, `temperature` and returns `content`, `providerUsed`, `modelUsed`, `tokensUsed`, `reasoningTrace`.

---

## 2. Logic Chain

1. **Observation**: `package.json` contains no external vendor LLM SDK dependencies (`openai`, `@anthropic-ai/sdk`, etc.), but Node 20 provides standard global `fetch`.
2. **Deduction**: Concrete provider adapters in `omniRouteAdapter.ts` must use HTTP REST calls via standard `fetch` with dependency injection (`httpFetch?: typeof fetch`), keeping the codebase lightweight, dependency-free, and easily mockable in unit and E2E tests.
3. **Observation**: Milestone 2 scope requires supporting multiple providers (OpenAI, Anthropic, Gemini, DeepSeek, OmniRoute Gateway) with API key subscriptions, usage-based billing, and extra-usage tier subscriptions.
4. **Deduction**: We defined `LLMRequest`, `LLMResponse`, `ProviderConfig`, `BillingTier`, `ExtraUsageTierConfig`, and `IProviderAdapter` interfaces. Each provider type has a dedicated HTTP adapter (`OpenAIAdapter`, `AnthropicAdapter`, `GeminiAdapter`, `DeepSeekAdapter`, `OmniRouteGatewayAdapter`) that transforms `LLMRequest` (synthesizing persona system prompts and effort level token limits) into native API payloads and standardizes the returned output into `LLMResponse`.

---

## 3. Caveats

- **Network Mode**: Running under `CODE_ONLY` mode. Real external provider APIs were not queried over live internet. Design relies on official API contract specifications and `MockOmniRouteServer` behavior.
- **Token Manager Dependency**: `OmniRouteAdapter` expects token encryption and refresh credentials to be managed by `TokenManager` (`src/router/tokenManager.ts`), which is developed concurrently in Milestone 2.

---

## 4. Conclusion

The architectural design for `src/router/omniRouteAdapter.ts` is fully specified in `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_1/analysis.md`.
The design includes:
1. Exact TypeScript interfaces for `LLMRequest`, `LLMResponse`, `ProviderConfig`, `BillingTier`, and `ExtraUsageTierConfig`.
2. Multi-provider REST adapters for OpenAI, Anthropic, Google Gemini, DeepSeek, and OmniRoute Gateway.
3. Persona system prompt synthesis (`security`, `architecture`, `performance`, `quality`).
4. Effort level mapping (`low`, `medium`, `high`, `reasoning`) to token bounds, model defaults, and reasoning trace extraction.
5. Subscription tier handling and cost estimation formulas.

---

## 5. Verification Method

To verify the implementation once created:
1. Inspect design document: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_m2_1/analysis.md`.
2. Run build: `npm run build` to verify zero TypeScript compilation errors.
3. Run tests: `npm test` to verify unit and integration tests pass cleanly.
