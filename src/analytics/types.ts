export interface SessionFilterOptions {
  owner?: string;
  repo?: string;
  prNumber?: number | string;
  verdict?: string;
  minTurns?: number;
  maxTurns?: number;
  query?: string;
  startDate?: string;
  endDate?: string;
}

export interface SessionFinding {
  severity: string; // e.g. 'P0', 'P1', 'P2'
  title: string;
  path: string;
  line?: number;
  turn?: number;
  persona?: string;
}

export interface FindingsDelta {
  initialFindings: number;
  latestFindings: number;
  resolvedFindings: number;
  newFindings: number;
  persistentFindings: number;
  netChange: number;
}

export interface TurnDelta {
  turn: number;
  headSha: string;
  timestamp: string;
  verdict: string;
  findingsCount: number;
  findings?: SessionFinding[];
  deltaFromPrevious?: FindingsDelta;
}

export interface SessionRecord {
  id: string; // e.g. "owner/repo#123"
  owner: string;
  repo: string;
  prNumber: number;
  title: string;
  branch: string;
  initialHeadSha?: string;
  currentHeadSha?: string;
  totalTurns: number;
  maxTurns: number;
  createdAt: string;
  updatedAt: string;
  lastVerdict: string;
  status?: string;
  costUSD: number;
  latencyMs: number;
  tokens: { prompt: number; completion: number; total: number };
  findings: SessionFinding[];
  findingsDelta?: FindingsDelta;
}

export interface SessionTurnDetail {
  turn: number;
  headSha: string;
  recordedAt?: string;
  arbitration?: {
    verdict: string;
    rationale: string;
    metrics: { p0Count: number; p1Count: number; p2Count: number };
  };
  personaResults?: Array<{
    id: string;
    displayName: string;
    decision: string;
    findings: SessionFinding[];
  }>;
  costUSD?: number;
  durationMs?: number;
  tokens?: { prompt: number; completion: number; total: number };
}

export interface SessionDetail extends SessionRecord {
  history: TurnDelta[];
  turns: SessionTurnDetail[];
}

export interface SessionKPIs {
  totalSessions: number;
  totalTurns: number;
  avgTurnsPerSession: number;
  verdictCounts: Record<string, number>;
  passRatePercent: number;
  totalFindings: {
    p0: number;
    p1: number;
    p2: number;
    total: number;
  };
  totalCostUSD: number;
  totalTokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  avgDurationMs: number;
  turnBudgetUtilizationPercent: number;
  findingsResolutionRatePercent: number;
}

export interface FormatterOptions {
  format: 'okf' | 'json' | 'markdown' | 'table';
  pretty?: boolean;
  color?: boolean;
  out?: string;
}

export interface Formatter {
  formatSessions(sessions: SessionRecord[], options?: FormatterOptions): string;
  formatKPIs(kpis: SessionKPIs, options?: FormatterOptions): string;
  formatDetail(detail: SessionDetail, options?: FormatterOptions): string;
}
