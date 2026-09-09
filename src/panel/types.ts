import { ProviderId } from '../config/schema';
import { OpenRouterRequest, TokensUsed } from '../gateway/openRouterClient';
import { RepositoryVisibility } from '../review/repositoryVisibility';

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
  optionalFailures: Array<{ id: string; error: string }>;
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
>;
