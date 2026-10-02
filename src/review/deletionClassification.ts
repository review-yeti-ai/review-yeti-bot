import { createHash } from 'node:crypto';
export const DELETION_CLASSIFICATION_VERSION = 'deletion-classification.v1';

export type DeletionRisk = 'low' | 'medium' | 'high' | 'unknown';
export interface DeletionClassificationGroup {
  id: string; label: string; proof: string; risk: DeletionRisk;
  paths: string[]; categories: string[]; obligationCount: number;
}
export interface DeletionClassificationPlan {
  version: typeof DELETION_CLASSIFICATION_VERSION; repository: string; headSha: string; digest: string;
  status: 'complete' | 'partial' | 'disabled' | 'unavailable';
  totalFiles: number; classifiedFiles: number; unresolvedFiles: number;
  groups: DeletionClassificationGroup[];
}
export const deletionRiskRank = (risk: DeletionRisk): number =>
  ({ high: 0, unknown: 1, medium: 2, low: 3 })[risk];
export function classificationAtHead(plan: DeletionClassificationPlan | undefined, repository: string, headSha: string) {
  return plan?.repository === repository && plan.headSha === headSha ? plan : undefined;
}

/** Candidates contain only admitted members; the model selects a closed key. */
export function deletionSubsystemCandidates(files: Array<{ path: string; oldPath: string }>) {
  const scopes = new Map<string, Set<string>>();
  const add = (label: string, path: string) => {
    if (!scopes.has(label)) scopes.set(label, new Set());
    scopes.get(label)!.add(path);
  };
  for (const file of files) {
    const parts = file.oldPath.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      add(parts.slice(0, depth).join('/'), file.path);
      const segment = parts[depth - 1];
      const family = /^([a-zA-Z0-9]+)-/u.exec(segment)?.[1];
      if (family) add([...parts.slice(0, depth - 1), family + '-*'].join('/'), file.path);
    }
  }
  const candidates = [...scopes].filter(([, members]) => members.size > 1)
    .map(([label, members]) => ({
      id: 'scope_' + createHash('sha256').update(label).digest('hex').slice(0, 16),
      label, paths: [...members].sort(),
    }));
  const byPath = new Map<string, typeof candidates>();
  for (const candidate of candidates) for (const path of candidate.paths) {
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path)!.push(candidate);
  }
  return (path: string) => (byPath.get(path) ?? [])
    // Bound each question, keeping the most specific scopes and family candidates.
    .sort((a, b) => b.label.split('/').length - a.label.split('/').length
      || Number(b.label.endsWith('*')) - Number(a.label.endsWith('*'))
      || a.label.localeCompare(b.label)).slice(0, 8);
}

/** Classifier metadata steers decomposition; it never replaces original evidence. */
export function formatDeletionClassification(plan?: DeletionClassificationPlan, paths?: string[]): string {
  if (!plan || plan.status === 'disabled' || plan.status === 'unavailable' || !plan.classifiedFiles) return '';
  const admitted = paths ? new Set(paths) : undefined;
  const groups = plan.groups.map((group) => ({
    ...group,
    fullGroupObligationCount: group.obligationCount,
    obligationCount: undefined,
    paths: admitted ? group.paths.filter((path) => admitted.has(path)) : group.paths,
  })).filter((group) => group.paths.length);
  if (!groups.length) return '';
  return [
    '=== DELETION CLASSIFICATION AND REVIEW GROUPS ===',
    `Classification: ${plan.status}; ${plan.classifiedFiles}/${plan.totalFiles} paths classified. Digest: ${plan.digest}`,
    'Use these subsystem groups to scope review tasks and investigate high-risk or unknown paths first.',
    'Retain every member path and its consumer, contract, security and test checks. A subsystem group does not prove source equivalence or deletion safety.',
    'Unclassified paths remain in the review. Inspect original diff/source pages when evidence is incomplete.',
    '<untrusted_classification_data>',
    JSON.stringify(groups).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e'),
    '</untrusted_classification_data>',
  ].join('\n');
}

/** May raise task priority; existing deterministic security floors still apply. */
export function deletionTaskPriority(paths: string[], plan?: DeletionClassificationPlan): number | undefined {
  if (!plan || plan.status === 'disabled' || plan.status === 'unavailable' || !plan.classifiedFiles) return undefined;
  const set = new Set(paths);
  const ranks = plan.groups.filter((group) => group.paths.some((path) => set.has(path)))
    .map((group) => deletionRiskRank(group.risk));
  return ranks.length ? Math.min(...ranks) : undefined;
}
