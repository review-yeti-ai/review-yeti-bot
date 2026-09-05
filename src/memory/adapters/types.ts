export interface ReviewerLearning {
  id?: string;
  repo: string;
  prNumber: number;
  category: "convention" | "architecture" | "security" | "performance" | "style" | "adr";
  title: string;
  description: string;
  filePath?: string;
  domain?: string;
  confidence?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface ResolvedNitPattern {
  id?: string;
  ruleId?: string;
  repo: string;
  prNumber: number;
  pattern: string;
  filePath: string;
  reason: string;
  headSha?: string;
  resolvedAt?: string;
  suppressionCount?: number;
  confidence?: number;
  domain?: string;
}

export interface ADRConstraint {
  id?: string;
  repo: string;
  adrNumber: number;
  title: string;
  status: "draft" | "accepted" | "deprecated";
  rule: string;
  targetPaths: string[];
  createdAt?: string;
}

export interface PathInstructionRule {
  id?: string;
  repo: string;
  pathPattern: string;
  instructions: string;
  createdAt?: string;
}

export interface RepoMemoryState {
  learnings: ReviewerLearning[];
  resolvedNits: ResolvedNitPattern[];
  adrConstraints: ADRConstraint[];
}

export interface LearningQueryOptions {
  category?: string;
  filePath?: string;
  domain?: string;
  distance?: number;
  limit?: number;
}

export interface NitQueryOptions {
  filePath?: string;
  ruleId?: string;
  domain?: string;
  distance?: number;
  limit?: number;
}

export interface MemoryAdapter {
  readonly providerName: string;

  initialize(): Promise<void>;

  recordLearning(
    repo: string,
    prNumber: number,
    learning: Omit<ReviewerLearning, "repo" | "prNumber">
  ): Promise<ReviewerLearning>;

  getLearnings(repo: string, options?: LearningQueryOptions): Promise<ReviewerLearning[]>;

  recordResolvedNit(
    repo: string,
    prNumber: number,
    nit: Omit<ResolvedNitPattern, "repo" | "prNumber">
  ): Promise<ResolvedNitPattern>;

  getResolvedNits(repo: string, filePath?: string): Promise<ResolvedNitPattern[]>;

  incrementNitSuppression(id: string): Promise<void>;

  recordAdrConstraint(
    repo: string,
    constraint: Omit<ADRConstraint, "repo">
  ): Promise<ADRConstraint>;

  getAdrConstraints(repo: string, status?: "draft" | "accepted" | "deprecated"): Promise<ADRConstraint[]>;

  recordPathInstruction?(
    repo: string,
    rule: Omit<PathInstructionRule, "repo">
  ): Promise<PathInstructionRule>;

  getPathInstructions?(repo: string, filePath?: string): Promise<PathInstructionRule[]>;

  deleteConclusion?(id: string): Promise<boolean>;

  forgetPattern?(repo: string, pattern: string): Promise<boolean>;

  degradePatternConfidence?(repo: string, pattern: string, penalty?: number): Promise<void>;

  clear?(repo?: string): Promise<void>;

  close?(): Promise<void>;
}

export interface HonchoAdapterConfig {
  baseUrl?: string;
  apiKey?: string;
  workspace?: string;
  peer?: string;
  observed?: string;
  recallPeers?: string[];
  recallDistance?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  syncIntervalMs?: number;
}

export interface SQLiteAdapterConfig {
  dbPath?: string;
}

export interface PostgresAdapterConfig {
  connectionString?: string;
}

export interface CompositeAdapterConfig {
  primary: MemoryAdapter;
  secondary: MemoryAdapter;
  readFallback?: boolean;
  writeAsync?: boolean;
}

export type MemoryProviderType = "sqlite" | "postgres" | "honcho" | "composite" | "auto";

export interface MemoryAdapterConfig {
  provider?: MemoryProviderType;
  sqlite?: SQLiteAdapterConfig;
  postgres?: PostgresAdapterConfig;
  honcho?: HonchoAdapterConfig;
  composite?: {
    primary?: MemoryProviderType;
    secondary?: MemoryProviderType;
  };
}
