/**
 * REL-1132: per-run token accounting over EVERY provider call.
 *
 * The worker's token figures used to come from each lane's terminal turn only, so a multi-turn
 * lane (tool exploration, a structured-output correction, a retried attempt) was under-counted,
 * and a lane that failed closed was not counted at all. Bifrost bills every request; on the
 * 2026-09-25 calibration the worker reported about 2.7x fewer tokens than Bifrost did.
 *
 * `meterModelClient` wraps the one `ReviewModelClient` a publishing run hands to its engines, so
 * every call that returns a response -- each lane turn and attempt, the map-reduce reduce pass,
 * the moderator, the arbiter, the triage classifier and the composed shadow engine -- lands in
 * one ledger. The ledger keeps a per-role and per-lane breakdown so cost can be attributed.
 *
 * A request that throws before a response exists records nothing: there is no usage to read, and
 * inventing one would be worse than the known gap.
 *
 * Telemetry never changes a review outcome: recording is fail-soft, and the wrapped client returns
 * or throws exactly what the inner client did.
 */
import type { OpenRouterRequest, OpenRouterResponse, ReviewModelClient } from '../gateway/openRouterClient';
import { resolveCachedTokens } from '../gateway/openRouterClient';
import { getMetrics } from './metrics';

export interface TokenUsageTotals {
  /** Provider calls that returned a response. */
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUSD: number;
}

export type TokenRole = 'lanes' | 'moderator' | 'arbiter' | 'other';

export interface TokenAccounting {
  /** What was counted: every provider call that returned a response, never only a terminal turn. */
  basis: 'every_provider_call';
  total: TokenUsageTotals;
  byRole: Record<TokenRole, TokenUsageTotals>;
  /** Lane (persona) id -> every call that lane made, including retries and its map-reduce reduce pass. */
  byLane: Record<string, TokenUsageTotals>;
  /** Calls outside the panel roles, keyed by caller label (e.g. `classifier`, `composed-shadow`). */
  byOther: Record<string, TokenUsageTotals>;
}

/** `metadata.role` of the map-reduce reduce pass; `createModelReducer` sets exactly this value. */
export const MAP_REDUCE_REDUCE_ROLE = 'map-reduce-reduce';
/** `metadata.role` values that are lane work: `invoke()`'s `'persona'` role and the reduce pass.
 * `panelEngineTokenMetrics.test.ts` runs the real producers through the ledger, so a renamed role
 * fails there instead of silently moving lane tokens to `other`. */
const LANE_ROLES = new Set(['persona', MAP_REDUCE_REDUCE_ROLE]);
const UNATTRIBUTED = 'unattributed';
/** Bounds the breakdown maps against an unexpected caller that labels every call uniquely. */
const MAX_BREAKDOWN_KEYS = 64;
const OVERFLOW_KEY = 'other-labels';

export function emptyTokenUsage(): TokenUsageTotals {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, costUSD: 0 };
}

function count(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

/** Normalizes one response's usage. Accepts both the client's `prompt`/`completion`/`total` shape
 * and the raw OpenAI-style `*_tokens` names. A missing total is prompt + completion. */
export function usageOfResponse(response: Pick<OpenRouterResponse, 'usage' | 'costUSD'>): TokenUsageTotals {
  const raw = (response.usage || {}) as unknown as Record<string, unknown>;
  const promptTokens = count(raw.prompt ?? raw.prompt_tokens);
  const completionTokens = count(raw.completion ?? raw.completion_tokens);
  const reportedTotal = count(raw.total ?? raw.total_tokens);
  return {
    calls: 1,
    promptTokens,
    completionTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens,
    cachedTokens: response.usage ? resolveCachedTokens(response.usage) : 0,
    costUSD: count(response.costUSD),
  };
}

export function addTokenUsage(into: TokenUsageTotals, usage: TokenUsageTotals): void {
  into.calls += usage.calls;
  into.promptTokens += usage.promptTokens;
  into.completionTokens += usage.completionTokens;
  into.totalTokens += usage.totalTokens;
  into.cachedTokens += usage.cachedTokens;
  into.costUSD += usage.costUSD;
}

/** Where a request's usage belongs. `forcedLabel` pins every call of one wrapped client (e.g. the
 * composed shadow engine) to a single `other` bucket regardless of the labels it sets. */
export function attributeRequest(request: Pick<OpenRouterRequest, 'persona' | 'metadata'>, forcedLabel?: string): { role: TokenRole; key: string } {
  if (forcedLabel) return { role: 'other', key: forcedLabel };
  const role = request.metadata?.role;
  if (role && LANE_ROLES.has(role)) {
    return { role: 'lanes', key: request.persona || request.metadata?.persona || UNATTRIBUTED };
  }
  if (role === 'moderator' || role === 'arbiter') return { role, key: role };
  return { role: 'other', key: request.persona || role || UNATTRIBUTED };
}

export class TokenLedger {
  private readonly totals = emptyTokenUsage();
  private readonly roles: Record<TokenRole, TokenUsageTotals> = {
    lanes: emptyTokenUsage(), moderator: emptyTokenUsage(), arbiter: emptyTokenUsage(), other: emptyTokenUsage(),
  };
  private readonly lanes = new Map<string, TokenUsageTotals>();
  private readonly others = new Map<string, TokenUsageTotals>();

  record(request: Pick<OpenRouterRequest, 'persona' | 'metadata'>, response: Pick<OpenRouterResponse, 'usage' | 'costUSD'>, forcedLabel?: string): void {
    const usage = usageOfResponse(response);
    const { role, key } = attributeRequest(request, forcedLabel);
    addTokenUsage(this.totals, usage);
    addTokenUsage(this.roles[role], usage);
    if (role === 'lanes') addTokenUsage(bucket(this.lanes, key), usage);
    if (role === 'other') addTokenUsage(bucket(this.others, key), usage);
  }

  get calls(): number {
    return this.totals.calls;
  }

  snapshot(): TokenAccounting {
    return {
      basis: 'every_provider_call',
      total: { ...this.totals },
      byRole: {
        lanes: { ...this.roles.lanes },
        moderator: { ...this.roles.moderator },
        arbiter: { ...this.roles.arbiter },
        other: { ...this.roles.other },
      },
      byLane: Object.fromEntries([...this.lanes].map(([key, usage]) => [key, { ...usage }])),
      byOther: Object.fromEntries([...this.others].map(([key, usage]) => [key, { ...usage }])),
    };
  }
}

function bucket(map: Map<string, TokenUsageTotals>, key: string): TokenUsageTotals {
  const effectiveKey = map.has(key) || map.size < MAX_BREAKDOWN_KEYS ? key : OVERFLOW_KEY;
  let existing = map.get(effectiveKey);
  if (!existing) {
    existing = emptyTokenUsage();
    map.set(effectiveKey, existing);
  }
  return existing;
}

/**
 * Returns a client that records the usage of every response the inner client returns into
 * `ledger`, then hands that response back unchanged. Errors pass through untouched.
 */
export function meterModelClient(client: ReviewModelClient, ledger: TokenLedger, options: { label?: string } = {}): ReviewModelClient {
  return {
    async complete(request: OpenRouterRequest): Promise<OpenRouterResponse> {
      const response = await client.complete(request);
      try {
        ledger.record(request, response, options.label);
      } catch {
        // Telemetry never changes a review outcome.
      }
      return response;
    },
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/**
 * The check-summary line. Always names the basis so a reader cannot mistake it for the old
 * terminal-turn figure, and always shows the role split and each lane.
 */
export function renderTokenAccountingSummary(accounting: TokenAccounting): string {
  const { total, byRole } = accounting;
  const lanes = Object.entries(accounting.byLane)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, usage]) => `\`${id}\` ${usage.totalTokens} (${usage.calls} calls)`);
  const others = Object.entries(accounting.byOther)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, usage]) => `\`${id}\` ${usage.totalTokens}`);
  return [
    `Tokens (every provider call): ${total.totalTokens} total over ${total.calls} calls `
      + `(prompt ${total.promptTokens}, completion ${total.completionTokens}, cached ${total.cachedTokens}; ${formatUsd(total.costUSD)}).`,
    ` By role: lanes ${byRole.lanes.totalTokens}, moderator ${byRole.moderator.totalTokens}, `
      + `arbiter ${byRole.arbiter.totalTokens}, other ${byRole.other.totalTokens}.`,
    ...(lanes.length > 0 ? [` Per lane: ${lanes.join(', ')}.`] : []),
    ...(others.length > 0 ? [` Other: ${others.join(', ')}.`] : []),
  ].join('');
}

/** Flat, bounded fields for the structured completion log (numbers and lane ids only). */
export function tokenAccountingLogFields(accounting: TokenAccounting): Record<string, unknown> {
  const flat = (usage: TokenUsageTotals) => ({
    calls: usage.calls,
    prompt: usage.promptTokens,
    completion: usage.completionTokens,
    total: usage.totalTokens,
    cached: usage.cachedTokens,
    costUSD: Number(usage.costUSD.toFixed(6)),
  });
  return {
    tokenBasis: accounting.basis,
    tokensTotal: accounting.total.totalTokens,
    tokensPrompt: accounting.total.promptTokens,
    tokensCompletion: accounting.total.completionTokens,
    tokensCached: accounting.total.cachedTokens,
    tokenCostUSD: Number(accounting.total.costUSD.toFixed(6)),
    providerCalls: accounting.total.calls,
    tokensByRole: {
      lanes: flat(accounting.byRole.lanes),
      moderator: flat(accounting.byRole.moderator),
      arbiter: flat(accounting.byRole.arbiter),
      other: flat(accounting.byRole.other),
    },
    tokensByLane: Object.fromEntries(Object.entries(accounting.byLane).map(([id, usage]) => [id, flat(usage)])),
    tokensByOther: Object.fromEntries(Object.entries(accounting.byOther).map(([id, usage]) => [id, flat(usage)])),
  };
}

/**
 * Adds ONE provider call's usage to the worker token counters (`review_yeti_tokens_*_total`,
 * `review_yeti_model_cost_usd_total`). Called once per real call from the panel's turn loop, so
 * the counters sum every turn and every attempt of every lane, the moderator and the arbiter --
 * never only a terminal turn. Fail-soft.
 */
export function recordProviderCallTokenMetrics(
  labels: { persona: string; provider: string; model: string },
  response: Pick<OpenRouterResponse, 'usage' | 'costUSD'>,
): void {
  try {
    const usage = usageOfResponse(response);
    const metrics = getMetrics();
    metrics.tokensPrompt.add(usage.promptTokens, labels);
    metrics.tokensCompletion.add(usage.completionTokens, labels);
    metrics.tokensTotal.add(usage.totalTokens, labels);
    metrics.modelCostUsd.add(usage.costUSD, labels);
  } catch {
    // Telemetry never changes a review outcome.
  }
}

/**
 * The token fields of the worker's `Publishing review worker completed` log line, read from the
 * receipt's metrics (every provider call of the run). Empty when the receipt carries no metrics.
 */
export function receiptTokenLogFields(metrics: {
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  tokenAccounting?: TokenAccounting;
} | undefined): Record<string, number> {
  if (!metrics) return {};
  return {
    tokensTotal: metrics.totalTokens,
    tokensPrompt: metrics.totalPromptTokens,
    tokensCompletion: metrics.totalCompletionTokens,
    ...(metrics.tokenAccounting ? { providerCalls: metrics.tokenAccounting.total.calls } : {}),
  };
}
