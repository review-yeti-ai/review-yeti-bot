export type DecisionState = 'open' | 'resolved' | 'ignored' | 'obsolete';
export type DecisionKind = 'ignore' | 'unignore';
export type MaintainerPermission = 'write' | 'maintain' | 'admin';

export interface ParsedBotFinding {
  severity: 'P0' | 'P1' | 'P2';
  title: string;
  body: string;
  alternateTitles: string[];
  sha: string | null;
}

export interface ParsedDecisionCommand {
  kind: DecisionKind;
  reason: string;
  reasonDigest: string;
}

export interface DecisionLedgerEntry {
  threadId: string;
  findingCommentId: number | null;
  state: DecisionState;
  severity: 'P0' | 'P1' | 'P2';
  path: string;
  line: number | null;
  side: 'RIGHT' | 'LEFT';
  title: string;
  claimBody: string;
  alternateTitles: string[];
  claimKey: string;
  firstReportedSha: string | null;
  humanReplyCount: number;
  decision?: {
    kind: DecisionKind;
    commentId: number;
    author: string;
    permission: MaintainerPermission;
    reasonDigest: string;
    createdAt: string;
  };
}

export interface DecisionLedger {
  version: 1;
  pullRequest: string;
  headSha: string;
  available: boolean;
  complete: boolean;
  entries: DecisionLedgerEntry[];
  omittedEntries: number;
  truncated: boolean;
}

export interface DecisionSnapshot {
  repo: string;
  prNumber: string | number;
  headSha: string;
  expectedPublisherLogin: string | null;
  changedPaths?: string[];
  permissionsByLogin?: Record<string, string | null>;
  threads?: unknown[];
  available?: boolean;
  complete?: boolean;
}

export interface RenderedDecisionLedger {
  text: string;
  renderedEntries: number;
  omittedEntries: number;
}

export function parseBotFindingComment(body?: string | null): ParsedBotFinding | null;
export function parseDecisionCommand(body?: string | null): ParsedDecisionCommand | null;
export function buildDecisionLedger(
  snapshot: DecisionSnapshot,
  options?: { maintainerCommands?: boolean },
): DecisionLedger;
export function renderDecisionLedger(
  ledger: DecisionLedger,
  limits?: { maxEntries?: number; maxPromptChars?: number },
): RenderedDecisionLedger;

export const DEFAULT_MAX_ENTRIES: number;
export const DEFAULT_MAX_PROMPT_CHARS: number;
export const MAX_TITLE_CHARS: number;
export const MAX_CLAIM_BODY_CHARS: number;
export const MAX_ALTERNATE_TITLES: number;
export const MAX_ALTERNATE_TITLE_CHARS: number;
