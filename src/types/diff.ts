export interface DiffLine {
  type: 'add' | 'delete' | 'context';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: (string | DiffLine)[];
}

export interface ChangedFileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  patch?: string;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface AnchoredFinding {
  id: string; // sha256(repo:file:line:title)
  severity: 'P0' | 'P1' | 'P2';
  file: string;
  line: number;
  startLine?: number;
  title: string;
  description: string;
  suggestion?: string;
  suggestedPatch?: string;
  status: 'active' | 'dismissed' | 'resolved';
  dismissedReason?: string;
  persona?: string;
}

export interface ReviewDiffResponse {
  success: boolean;
  jobId: string;
  repo: string;
  prNumber: number;
  headSha?: string;
  baseSha?: string;
  title?: string;
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  files: ChangedFileDiff[];
  findings?: AnchoredFinding[];
  error?: string;
}

export { computeFindingId } from '../lib/findingUtils';
