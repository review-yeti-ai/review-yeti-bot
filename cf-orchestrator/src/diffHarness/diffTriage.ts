/**
 * diffTriage.ts
 *
 * Risk and Size Tiered Task Allocator for Pull Request Diffs (Elastic Context / No Strict Budgets).
 * Rather than imposing rigid, artificial token limits or skipping diffs:
 * - High-risk & large files get singular, dedicated investigation tasks with full context headroom.
 * - Medium-risk files are grouped naturally by cohesive module/subsystem clusters.
 * - Low-risk & simple diffs (e.g. `echo true`, typo fixes, version bumps, lockfiles)
 *   are lumped together into composite batch tasks to review multiple diffs in a single prompt.
 *
 * Designed to elastically leverage large context models (up to 1M+ tokens) while
 * organizing work for maximum concurrency, reasoning depth, and sub-2-minute speed.
 */

export interface RawFileDiff {
  filename: string;
  patch: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export type RiskLevel = 'low' | 'medium' | 'high';
export type SizeTier = 'small' | 'moderate' | 'large';
export type DiffTaskType = 'singular_deep' | 'module_cluster' | 'lumped_simple';
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

export interface TriagedFileDiff {
  filename: string;
  risk: RiskLevel;
  sizeTier: SizeTier;
  category: 'code' | 'test' | 'documentation' | 'config' | 'lockfile' | 'generated';
  tokenEstimate: number;
  patch: string;
  additions: number;
  deletions: number;
  isSimple: boolean;
}

export interface DiffTask {
  taskId: string;
  taskType: DiffTaskType;
  module: string;
  files: TriagedFileDiff[];
  totalTokens: number;
  requiresDeepInspection: boolean;
  priority: number; // 1 = high risk/singular, 2 = medium, 3 = lumped simple
  thinkingEffort: ThinkingEffort;
}



const SIMPLE_ONE_LINER_PATTERNS = [
  /^\s*(echo\s+['"]?true['"]?|console\.log\(.*\);?)\s*$/i,
  /^\s*(#|\/\/|\/\*|\*)\s*.*$/i, // Pure comments
  /^\s*version\s*[:=]\s*["'][0-9.]+["']\s*$/i, // Version bump
  /^\s*package\s+[a-zA-Z0-9_.]+\s*;?\s*$/, // Package declaration
];

const LOCKFILE_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /mix\.lock$/,
  /Gemfile\.lock$/,
  /Cargo\.lock$/,
  /poetry\.lock$/,
  /composer\.lock$/,
];

const GENERATED_PATTERNS = [
  /\.min\.(js|css)$/,
  /\.bundle\.(js|css)$/,
  /\.pb\.(go|ts|js)$/,
  /\.generated\./,
  /dist\//,
  /build\//,
  /\.map$/,
];

const HIGH_RISK_PATTERNS = [
  /auth/i,
  /token/i,
  /secret/i,
  /crypto/i,
  /password/i,
  /permission/i,
  /session/i,
  /tenant/i,
  /billing/i,
  /payment/i,
  /gateway/i,
  /sudo/i,
  /admin/i,
];

/**
 * Checks whether a diff patch is a simple one-liner, typo fix, or formatting change.
 */
export function isSimplePatch(patch: string): boolean {
  if (!patch || !patch.trim()) return true;

  const lines = patch
    .split('\n')
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);

  if (lines.length <= 2) {
    return lines.every((line) =>
      SIMPLE_ONE_LINER_PATTERNS.some((pattern) => pattern.test(line))
    );
  }

  return false;
}

/**
 * Triages a single file diff into risk and size tiers without artificial limits.
 */
export function triageFileDiff(diff: RawFileDiff): TriagedFileDiff {
  const { filename, patch, additions, deletions } = diff;
  const totalChangedLines = additions + deletions;

  // 1. Category Classification
  let category: TriagedFileDiff['category'] = 'code';
  if (LOCKFILE_PATTERNS.some((p) => p.test(filename))) {
    category = 'lockfile';
  } else if (GENERATED_PATTERNS.some((p) => p.test(filename))) {
    category = 'generated';
  } else if (/\.(md|markdown|txt|rst|adoc)$/i.test(filename) || filename.includes('docs/')) {
    category = 'documentation';
  } else if (/\.(json|yaml|yml|toml|ini|env)$/i.test(filename)) {
    category = 'config';
  } else if (/\.(test|spec)\.(ts|js|exs|go|py)$/i.test(filename) || filename.includes('test/')) {
    category = 'test';
  }

  // 2. Size Tier
  let sizeTier: SizeTier = 'small';
  if (totalChangedLines > 150) {
    sizeTier = 'large';
  } else if (totalChangedLines >= 30) {
    sizeTier = 'moderate';
  }

  // 3. Simple patch check
  const isSimple = isSimplePatch(patch) || (category === 'documentation' && totalChangedLines < 30);

  // 4. Risk Level
  let risk: RiskLevel = 'medium';
  const isHighRiskPattern = HIGH_RISK_PATTERNS.some((pat) => pat.test(filename));

  if (isHighRiskPattern || sizeTier === 'large') {
    risk = 'high';
  } else if (isSimple || category === 'lockfile' || category === 'generated' || (category === 'documentation' && sizeTier === 'small')) {
    risk = 'low';
  } else {
    risk = 'medium';
  }

  // Elastic token estimate without arbitrary ceiling clamping
  const tokenEstimate = Math.ceil((patch?.length || 0) / 4);

  return {
    filename,
    risk,
    sizeTier,
    category,
    tokenEstimate: Math.max(50, tokenEstimate),
    patch,
    additions,
    deletions,
    isSimple,
  };
}

/**
 * Groups and partitions file diffs into tasks according to natural semantic boundaries:
 * 1. High-risk / Large diffs -> Singular dedicated tasks with deep context & Zoekt lookup capacity.
 * 2. Medium-risk diffs -> Cohesive module clusters (grouped naturally by directory/module).
 * 3. Low-risk / Simple diffs -> Lumped together into composite batch tasks to review multiple diffs in one prompt.
 *
 * Does NOT enforce strict artificial budgets — context scales elastically with the underlying model.
 */
export function partitionDiffTasks(
  rawDiffs: RawFileDiff[]
): { tasks: DiffTask[]; triagedFiles: TriagedFileDiff[] } {
  const triagedFiles = rawDiffs.map(triageFileDiff);

  const highRiskFiles: TriagedFileDiff[] = [];
  const mediumRiskFiles: TriagedFileDiff[] = [];
  const lowRiskSimpleFiles: TriagedFileDiff[] = [];

  for (const file of triagedFiles) {
    if (file.risk === 'high' || file.sizeTier === 'large') {
      highRiskFiles.push(file);
    } else if (file.risk === 'medium') {
      mediumRiskFiles.push(file);
    } else {
      lowRiskSimpleFiles.push(file);
    }
  }

  const tasks: DiffTask[] = [];

  // Tier 1: High-Risk / Large Files -> Singular dedicated tasks (1 Task per file)
  for (const file of highRiskFiles) {
    const parts = file.filename.split('/');
    const module = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0] || 'core';

    const isMissionCritical =
      file.risk === 'high' && /(auth|fenc|crypto|token|secret|signature)/i.test(file.filename);

    tasks.push({
      taskId: `singular-${file.filename.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      taskType: 'singular_deep',
      module,
      files: [file],
      totalTokens: file.tokenEstimate,
      requiresDeepInspection: true,
      priority: 1,
      thinkingEffort: isMissionCritical ? 'max' : 'high',
    });
  }

  // Tier 2: Medium-Risk Files -> Grouped naturally by module/directory clusters (Medium Thinking Effort)
  const moduleGroups = new Map<string, TriagedFileDiff[]>();
  for (const file of mediumRiskFiles) {
    const parts = file.filename.split('/');
    const module = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0] || 'root';
    if (!moduleGroups.has(module)) {
      moduleGroups.set(module, []);
    }
    moduleGroups.get(module)!.push(file);
  }

  for (const [module, files] of moduleGroups.entries()) {
    const totalTokens = files.reduce((acc, f) => acc + f.tokenEstimate, 0);
    tasks.push({
      taskId: `cluster-${module.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      taskType: 'module_cluster',
      module,
      files,
      totalTokens,
      requiresDeepInspection: false,
      priority: 2,
      thinkingEffort: 'medium',
    });
  }

  // Tier 3: Low-Risk & Simple Files -> Lumped together elastically into composite batch task (Low Thinking Effort)
  if (lowRiskSimpleFiles.length > 0) {
    const totalTokens = lowRiskSimpleFiles.reduce((acc, f) => acc + f.tokenEstimate, 0);
    tasks.push({
      taskId: 'lumped-simple-batch',
      taskType: 'lumped_simple',
      module: 'simple_batch',
      files: lowRiskSimpleFiles,
      totalTokens,
      requiresDeepInspection: false,
      priority: 3,
      thinkingEffort: 'low',
    });
  }

  // Sort tasks by priority: High-risk singular first, then medium clusters, then lumped simple
  tasks.sort((a, b) => a.priority - b.priority);

  return { tasks, triagedFiles };
}
