import { DomainLane } from '../pathDomainContract';

export interface ASTSymbolOutline {
  name: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'variable' | 'type';
  startLine: number;
  endLine: number;
  exported: boolean;
  signature?: string;
  containerName?: string;
}

export interface DiffHunkBoundary {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section?: string;
  modifiedLineNumbers?: number[];
}

export interface ASTFileOutline {
  filePath: string;
  domainLane: DomainLane;
  additions: number;
  deletions: number;
  hunkBoundaries: DiffHunkBoundary[];
  modifiedSymbols: ASTSymbolOutline[];
}

export interface FileTreeOutline {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: ASTFileOutline[];
  filesByDomain: Record<DomainLane, ASTFileOutline[]>;
  summaryText: string;
}

export interface TaskScopedOutlineOptions {
  task?: {
    id?: string;
    dimension?: string;
    paths?: string[];
    question?: string;
    rationale?: string;
  };
  paths?: string[];
  domainLanes?: DomainLane[];
  persona?: string;
}

export interface GenerateASTOutlineOptions {
  baseSha?: string;
  headSha?: string;
  repository?: string;
  domainLanes?: Record<string, DomainLane>;
  repoFileProvider?: {
    readFile(path: string): Promise<string | undefined> | string | undefined;
  };
}

export interface DomainScopedTaskContext {
  task: { id: string; dimension?: string; paths: string[] };
  assignedOutlines: ASTFileOutline[];
  externalFileManifest: Array<{ path: string; lane: DomainLane }>;
}
