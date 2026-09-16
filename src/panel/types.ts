import { ProviderId } from '../config/schema';
import { OpenRouterRequest, TokensUsed } from '../gateway/openRouterClient';
import { RepositoryVisibility } from '../review/repositoryVisibility';
import type { WorkerFailureClass } from '../review/workerCompletion';

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
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCalls?: Array<{ tool: string; args?: any; scope?: string; exhaustive?: boolean }>;
  isRedTeam?: boolean;
  crossExaminedModel?: string;
  mermaidDiagram?: string;
}

export interface PanelResult {
  headSha: string;
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
  }>;
  /** Final path/config/classifier-selected roster used by the panel execution. */
  applicablePersonaIds?: string[];
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
