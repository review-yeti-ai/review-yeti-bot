import { ProviderId } from '../config/schema';
import { OpenRouterRequest, TokensUsed } from '../gateway/openRouterClient';
import { RepositoryVisibility } from '../review/repositoryVisibility';
// Imported from the neutral `../types/workerFailure` module, not `../review/workerCompletion`
// (REL-892 finding 3): a panel domain type must not reach into the worker-completion/HTTP
// boundary module for a plain value type. See `../types/workerFailure` for the full rationale.
import type { WorkerFailureClass } from '../types/workerFailure';

export type FindingSeverity = 'P0' | 'P1' | 'P2';

export interface FixOption {
  rank?: number;
  title?: string;
  explanation?: string;
  suggestionCode?: string;
}

export interface PanelFinding {
  severity: FindingSeverity;
  path: string;
  line: number;
  startLine?: number;
  title: string;
  body: string;
  suggestion?: string;
  replacementCode?: string;
  confidence?: number;
  recommendation?: string;
  fixOptions?: FixOption[];
  isArchitectural?: boolean;
}

/**
 * Bounded, structured token usage carried alongside a failed lane. This is
 * strictly numeric -- no provider prompt/response text -- so it is safe to
 * publish on a fail-closed check even though the lane's free-form error
 * string is not.
 */
export interface LaneTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Bounded, numeric-only usage for exactly one provider turn inside a lane's `invoke()` loop.
 * `kind` records what that turn did: it requested a read-only tool, it was a bounded
 * structured-output correction, or it produced (or attempted to produce) the lane's final
 * result. A 15-turn lane makes up to 15 real provider calls; without one entry per call here,
 * only the last turn's tokens are ever visible and every aggregate figure is low by roughly
 * (turns - 1) prefills.
 */
export interface LaneTurnUsage {
  turn: number;
  kind: 'tool' | 'correction' | 'final';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUSD: number | null;
  model: string;
  durationMs: number;
}

/** Sum of every `LaneTurnUsage` entry for a lane -- the true per-lane total, as opposed to the
 * single-turn `usage`/`promptTokens`/`completionTokens`/`totalTokens` fields below, which have
 * always reflected only the lane's terminal turn. */
export interface LaneAggregateUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUSD: number;
}

export interface PersonaLaneResult {
  id: string;
  required: boolean;
  providerId: ProviderId;
  model: string;
  decision: 'APPROVE' | 'FINDINGS';
  findings: PanelFinding[];
  usage: TokensUsed | null;
  costUSD: number | null;
  durationMs: number;
  turnsCount?: number;
  /** Turns in which the lane requested a read-only tool, a strict subset of `turnsCount`. */
  toolTurns?: number;
  /** Turns spent on a bounded structured-output correction, a strict subset of `turnsCount`. */
  correctionTurns?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** One entry per provider call this lane made. Optional only so pre-existing fixtures that
   * construct a `PersonaLaneResult` literal without it still type-check; a real run always sets it. */
  turnUsages?: LaneTurnUsage[];
  /** Sum of `turnUsages`. See that field's doc comment for why this differs from `usage` above. */
  aggregateUsage?: LaneAggregateUsage;
  toolCalls?: Array<{ tool: string; args?: any; scope?: string; exhaustive?: boolean }>;
  isRedTeam?: boolean;
  crossExaminedModel?: string;
  mermaidDiagram?: string;
  notApplicable?: boolean;
  skipReason?: string;
}

export interface PanelResult {
  headSha: string;
  /**
   * Set when the approval came from path classification (documentation-only diff), not the
   * triage classifier. Declared on the base contract so CLI consumers read it directly instead
   * of casting, keeping the panel→CLI boundary compiler-checked.
   */
  documentationOnly?: true;
  /** Optional so pre-existing fixtures that construct a `PanelResult` literal do not need updating; a real run always sets it. */
  repositoryVisibility?: RepositoryVisibility;
  personas: PersonaLaneResult[];
  optionalFailures: Array<{
    id: string;
    error: string;
    /** Last observed token usage and resolved model for this lane before it failed closed, when
     * a provider response was received on at least one attempt. Never populated from an attempt
     * that never reached the provider (e.g. a local/transport error before any response). */
    lastKnownUsage?: LaneTokenUsage;
    lastKnownModel?: string;
    /**
     * Coded classification of why this lane failed, assigned by `runPersona` at the exact point
     * it observed the terminal error for the lane -- authoritative over any later re-derivation
     * from the free-form `error` string (REL-892 finding 2). Optional so a lane that failed
     * before this classification existed in the code path still degrades safely; a consumer must
     * fall back to `classifyFailure(error)` when this is undefined, never treat its absence as a
     * class of its own.
     */
    failureClass?: WorkerFailureClass;
    failureReason?: string;
  }>;
  /**
   * Tasks that did not produce a verdict and are deliberately absent from
   * `personas` and `optionalFailures`. Their ids must not enter the published
   * roster. A missing id keeps the roster invalid, so a partial plan cannot ship.
   */
  unreportedLanes?: Array<{
    id: string;
    error: string;
    failureClass: WorkerFailureClass;
  }>;
  /** Final path/config/classifier-selected roster used by the panel execution. */
  applicablePersonaIds: string[];
  zeroLaneNonEvidence?: boolean;
  quorum: { required: number; distinctProviders: string[]; satisfied: boolean };
  moderator: {
    providerId: ProviderId;
    model: string;
    decision: 'RECONCILED';
    findings: PanelFinding[];
    usage: TokensUsed | null;
    costUSD: number | null;
    durationMs: number;
  };
  arbiter: {
    providerId: ProviderId;
    model: string;
    verdict: 'SHIP' | 'FIX_FIRST' | 'BLOCK';
    rationale: string;
    usage: TokensUsed | null;
    costUSD: number | null;
    durationMs: number;
  };
  mermaidDiagram?: string;
  prSummary?: string;
  summary?: string;
  /** Wall-clock duration of the whole panel run (concurrent persona fan-out, then moderator, then
   * arbiter), as opposed to the SUM of individual lane `durationMs` values computed elsewhere.
   * Under concurrent fan-out that sum overstates wall time; comparing two engines on the sum alone
   * is meaningless. Optional only so pre-existing fixtures that construct a `PanelResult` literal
   * without it still type-check; a real run always sets it. */
  panelWallClockMs?: number;
}

/**
 * Provider request controls applied consistently to every persona, moderator, classifier, and arbiter call.
 */
export type PanelRequestPolicy = Pick<
  OpenRouterRequest,
  | 'stream'
  | 'ttftTimeoutMs'
  | 'maxTokens'
  | 'models'
  | 'temperature'
  | 'responseFormat'
  | 'provider'
  | 'plugins'
  | 'metadata'
  | 'signal'
>;
