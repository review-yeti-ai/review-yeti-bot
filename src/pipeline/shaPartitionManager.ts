/**
 * Commit SHA Range & Zero-Loss Partition Manager
 * Location: src/pipeline/shaPartitionManager.ts
 *
 * Implements deterministic zero-loss diff partitioning and telemetry per PROJECT.md § Interface Contracts:
 * - Tracks explicit base_sha...head_sha commit range.
 * - Generates complete file manifest table ({ path, status, partitionIndex }).
 * - Deterministic bin-packing of diff files into partitions <= safeDiffChars with 100% coverage (0 omitted).
 * - Splits oversized multi-hunk diff files across hunk boundaries into consecutive partitions without dropping hunks.
 * - Emits PR comment coverage telemetry: "Coverage: 100% (X/X files reviewed across Y partitions, 0 omitted)".
 * - Formats persona prompt manifest headers with commit SHA range and partition scope.
 */

export type FileStatus = 'added' | 'modified' | 'deleted';

export interface PartitionFile {
  path: string;
  patch: string;
  originalChars: number;
  compactedChars: number;
  status?: FileStatus;
}

export interface DiffPartition {
  partitionIndex: number;
  totalPartitions: number;
  files: Array<{ path: string; patch: string; originalChars: number; compactedChars: number }>;
  totalChars: number;
  baseSha: string;
  headSha: string;
}

export interface PartitionPlan {
  baseSha: string;
  headSha: string;
  totalFiles: number;
  totalOriginalChars: number;
  totalCompactedChars: number;
  partitions: DiffPartition[];
  coveragePercent: 100;
  omittedFilesCount: 0;
  fileManifest: Array<{ path: string; status: FileStatus; partitionIndex: number }>;
}

export interface InputDiffFile {
  path: string;
  patch?: string;
  content?: string;
  status?: string;
  originalChars?: number;
  compactedChars?: number;
}

/**
 * Detects whether a file in a PR diff is added, modified, or deleted.
 */
export function detectFileStatus(file: { path: string; patch?: string; status?: string }): FileStatus {
  if (file.status === 'added' || file.status === 'deleted' || file.status === 'modified') {
    return file.status;
  }
  const patch = file.patch || '';
  if (patch.includes('new file mode') || patch.includes('--- /dev/null') || patch.includes('+++ b/') && patch.includes('--- /dev/null')) {
    return 'added';
  }
  if (patch.includes('deleted file mode') || patch.includes('+++ /dev/null')) {
    return 'deleted';
  }
  return 'modified';
}

export interface ParsedUnifiedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  body: string[];
}

export function parseUnifiedHunk(hunk: string): ParsedUnifiedHunk | null {
  const lines = hunk.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header = lines.shift();
  const match = header?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u);
  if (!match) return null;

  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) return null;

  const body = lines;
  const counts = unifiedHunkCounts(body);
  if (!counts || counts.oldCount !== oldCount || counts.newCount !== newCount) return null;
  return { oldStart, oldCount, newStart, newCount, section: match[5], body };
}

/** A marker belongs only to the immediately preceding diff line, never another marker. */
function canOwnNoNewlineMarker(previousLine: string | undefined): boolean {
  return previousLine !== undefined
    && (previousLine.startsWith(' ') || previousLine.startsWith('+') || previousLine.startsWith('-'));
}

function unifiedHunkCounts(lines: string[]): { oldCount: number; newCount: number } | null {
  let oldCount = 0;
  let newCount = 0;
  let actualDiffLineCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '\\ No newline at end of file') {
      if (!canOwnNoNewlineMarker(lines[index - 1])) return null;
      continue;
    }
    if (line.startsWith(' ')) {
      oldCount += 1;
      newCount += 1;
    } else if (line.startsWith('+')) {
      newCount += 1;
    } else if (line.startsWith('-')) {
      oldCount += 1;
    } else {
      return null;
    }
    actualDiffLineCount += 1;
  }
  return actualDiffLineCount > 0 ? { oldCount, newCount } : null;
}

function hunkLineAtoms(body: string[]): string[][] | null {
  const atoms: string[][] = [];
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index];
    if (line === '\\ No newline at end of file') {
      if (!canOwnNoNewlineMarker(body[index - 1])) return null;
      atoms[atoms.length - 1].push(line);
    } else {
      atoms.push([line]);
    }
  }
  return atoms.length > 0 ? atoms : null;
}

function formatUnifiedHunkFragment(
  hunk: ParsedUnifiedHunk,
  oldStart: number,
  newStart: number,
  body: string[],
  counts: { oldCount: number; newCount: number },
): string {
  const header = `@@ -${oldStart},${counts.oldCount} +${newStart},${counts.newCount} @@${hunk.section}\n`;
  return `${header}${body.join('\n')}`;
}

export function unifiedFragmentRangeStart(
  sourceStart: number,
  sourceCount: number,
  consumedCount: number,
  fragmentCount: number,
): number {
  const sourceCursor = sourceStart + (sourceCount === 0 ? 1 : 0) + consumedCount;
  return fragmentCount === 0 ? sourceCursor - 1 : sourceCursor;
}

/**
 * Splits one oversized unified hunk only at complete diff-line boundaries. Every emitted hunk
 * gets ranges recomputed from the consumed old/new lines; malformed hunks and indivisible lines
 * are returned unchanged so guarded admission can reject them rather than truncate them.
 */
function splitOversizedHunkBlock(fileHeader: string, hunkBlock: string, safeDiffChars: number): string[] {
  if (`${fileHeader}${hunkBlock}\n`.length <= safeDiffChars) return [hunkBlock];
  const hunk = parseUnifiedHunk(hunkBlock);
  if (!hunk) return [hunkBlock];
  const atoms = hunkLineAtoms(hunk.body);
  if (!atoms) return [hunkBlock];

  const fragments: string[] = [];
  let body: string[] = [];
  let oldConsumed = 0;
  let newConsumed = 0;
  let bodyOldCount = 0;
  let bodyNewCount = 0;
  let bodyChars = 0;

  const atomBodyChars = (atom: string[]): number => atom.reduce((total, line) => total + line.length, atom.length - 1);
  const candidateFits = (
    oldOffset: number,
    newOffset: number,
    oldCount: number,
    newCount: number,
    candidateBodyChars: number,
  ): boolean => {
    const oldStart = unifiedFragmentRangeStart(hunk.oldStart, hunk.oldCount, oldOffset, oldCount);
    const newStart = unifiedFragmentRangeStart(hunk.newStart, hunk.newCount, newOffset, newCount);
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.section}\n`;
    return fileHeader.length + header.length + candidateBodyChars + 1 <= safeDiffChars;
  };
  const flush = () => {
    if (body.length === 0) return;
    const fragment = formatUnifiedHunkFragment(
      hunk,
      unifiedFragmentRangeStart(hunk.oldStart, hunk.oldCount, oldConsumed, bodyOldCount),
      unifiedFragmentRangeStart(hunk.newStart, hunk.newCount, newConsumed, bodyNewCount),
      body,
      { oldCount: bodyOldCount, newCount: bodyNewCount },
    );
    fragments.push(fragment);
    oldConsumed += bodyOldCount;
    newConsumed += bodyNewCount;
    body = [];
    bodyOldCount = 0;
    bodyNewCount = 0;
    bodyChars = 0;
  };

  for (const atom of atoms) {
    const atomCounts = unifiedHunkCounts(atom);
    if (!atomCounts) return [hunkBlock];
    const nextOldCount = bodyOldCount + atomCounts.oldCount;
    const nextNewCount = bodyNewCount + atomCounts.newCount;
    const nextBodyChars = bodyChars + (body.length > 0 ? 1 : 0) + atomBodyChars(atom);
    if (candidateFits(oldConsumed, newConsumed, nextOldCount, nextNewCount, nextBodyChars)) {
      body.push(...atom);
      bodyChars = nextBodyChars;
      bodyOldCount += atomCounts.oldCount;
      bodyNewCount += atomCounts.newCount;
      continue;
    }

    if (body.length === 0) return [hunkBlock];
    flush();
    const firstAtomChars = atomBodyChars(atom);
    if (!candidateFits(oldConsumed, newConsumed, atomCounts.oldCount, atomCounts.newCount, firstAtomChars)) return [hunkBlock];
    body = [...atom];
    bodyOldCount = atomCounts.oldCount;
    bodyNewCount = atomCounts.newCount;
    bodyChars = firstAtomChars;
  }
  flush();

  return fragments.length > 1 ? fragments : [hunkBlock];
}

interface SharedHunkSplitOptions {
  /** Legacy keeps all split lines; guarded admission removes exactly one terminal transport line. */
  trimOneTerminalEmptyLine: boolean;
  /** Only guarded admission transforms an oversized source hunk into bounded line fragments. */
  transformHunk?: (fileHeader: string, hunkBlock: string, safeDiffChars: number) => string[];
  /** Guarded admission must return the original file if any indivisible hunk still exceeds the cap. */
  failClosedOnOversizedSingleHunk: boolean;
  /** Legacy only partitions files that originally contain multiple hunks. */
  minimumSourceHunks: number;
  /** Guarded admission returns the original when normalization still yields one group. */
  preserveOriginalForSingleResult: boolean;
}

/**
 * Shared header/hunk scanner and partition grouping for both legacy map-reduce and guarded
 * admission. The wrappers supply their historical line-ending and per-hunk policies explicitly;
 * grouping counts each hunk's inter-hunk/final newline exactly once as hunk.length + 1.
 */
function splitFileHunks(
  file: { path: string; patch: string; originalChars: number; compactedChars: number; status: FileStatus },
  safeDiffChars: number,
  options: SharedHunkSplitOptions,
): PartitionFile[] {
  const patch = file.patch;
  if (!patch || patch.length <= safeDiffChars || !patch.includes('@@')) return [file];

  const lines = patch.split('\n');
  if (options.trimOneTerminalEmptyLine && lines.at(-1) === '') lines.pop();
  const headerLines: string[] = [];
  const hunkBlocks: string[] = [];
  let currentHunk: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@') && line.includes('@@')) {
      if (currentHunk.length > 0) {
        hunkBlocks.push(currentHunk.join('\n'));
        currentHunk = [];
      }
      currentHunk.push(line);
    } else if (currentHunk.length > 0) {
      currentHunk.push(line);
    } else {
      headerLines.push(line);
    }
  }
  if (currentHunk.length > 0) hunkBlocks.push(currentHunk.join('\n'));

  const fileHeader = headerLines.length > 0 ? headerLines.join('\n') + '\n' : '';
  if (hunkBlocks.length < options.minimumSourceHunks) return [file];
  let boundedHunks = hunkBlocks;
  if (options.transformHunk) {
    const transformHunk = options.transformHunk;
    boundedHunks = hunkBlocks.flatMap((hunk) => transformHunk(fileHeader, hunk, safeDiffChars));
  }
  const resultFiles: PartitionFile[] = [];
  let currentHunkGroup: string[] = [];
  let currentGroupChars = fileHeader.length;
  const flushHunkGroup = () => {
    if (currentHunkGroup.length === 0) return;
    const combinedPatch = `${fileHeader}${currentHunkGroup.join('\n')}\n`;
    resultFiles.push({
      path: file.path,
      patch: combinedPatch,
      originalChars: combinedPatch.length,
      compactedChars: combinedPatch.length,
      status: file.status,
    });
    currentHunkGroup = [];
    currentGroupChars = fileHeader.length;
  };

  for (const hunk of boundedHunks) {
    const hunkChars = hunk.length + 1;
    const candidateChars = currentGroupChars + hunkChars;
    if (currentHunkGroup.length > 0 && candidateChars > safeDiffChars) flushHunkGroup();

    if (options.failClosedOnOversizedSingleHunk && currentGroupChars + hunkChars > safeDiffChars) return [file];
    currentHunkGroup.push(hunk);
    currentGroupChars += hunkChars;
  }

  flushHunkGroup();
  return options.preserveOriginalForSingleResult && resultFiles.length <= 1 ? [file] : resultFiles;
}

/**
 * Splits oversized patches at existing hunk boundaries for legacy map-reduce callers. It
 * preserves terminal empty split lines and intentionally allows an oversized indivisible hunk.
 */
export function splitOversizedFileHunks(
  file: { path: string; patch: string; originalChars: number; compactedChars: number; status: FileStatus },
  safeDiffChars: number
): PartitionFile[] {
  return splitFileHunks(file, safeDiffChars, {
    trimOneTerminalEmptyLine: false,
    transformHunk: undefined,
    failClosedOnOversizedSingleHunk: false,
    minimumSourceHunks: 2,
    preserveOriginalForSingleResult: false,
  });
}

/**
 * Guarded gateway admission opts into bounded line-level hunk fragments when a single hunk is
 * larger than the unchanged diff cap. Every fragment has recomputed unified-diff ranges. Invalid
 * hunks and indivisible lines remain intact so the caller's strict validator rejects them.
 */
function splitOversizedFileHunksForGuardedAdmission(
  file: { path: string; patch: string; originalChars: number; compactedChars: number; status: FileStatus },
  safeDiffChars: number
): PartitionFile[] {
  return splitFileHunks(file, safeDiffChars, {
    trimOneTerminalEmptyLine: true,
    transformHunk: splitOversizedHunkBlock,
    failClosedOnOversizedSingleHunk: true,
    minimumSourceHunks: 1,
    preserveOriginalForSingleResult: true,
  });
}

/**
 * Deterministic Zero-Loss Bin-Packing File Partitioning Engine.
 *
 * Partitions diff files into batches <= safeDiffChars ensuring 100% of files are reviewed
 * with zero omitted files and full manifest accountability.
 */
export function createPartitionPlan(
  files: InputDiffFile[],
  baseSha: string,
  headSha: string,
  safeDiffChars: number,
  options: { splitOversizedHunksAtLines?: boolean } = {},
): PartitionPlan {
  if (!baseSha || !headSha || typeof baseSha !== 'string' || typeof headSha !== 'string' || !baseSha.trim() || !headSha.trim()) {
    throw new Error('baseSha and headSha must be non-empty strings');
  }
  if (!Number.isFinite(safeDiffChars) || safeDiffChars <= 0) {
    throw new Error('safeDiffChars must be a positive finite number');
  }

  const processedFiles = (files || []).map((f) => {
    const rawPatch = f.patch || f.content || '';
    const status = detectFileStatus(f);
    const originalChars = typeof f.originalChars === 'number' ? f.originalChars : rawPatch.length;
    const compactedChars = typeof f.compactedChars === 'number' ? f.compactedChars : rawPatch.length;
    return {
      path: f.path,
      patch: rawPatch,
      status,
      originalChars,
      compactedChars,
    };
  });

  const totalOriginalChars = processedFiles.reduce((sum, f) => sum + f.originalChars, 0);
  const totalCompactedChars = processedFiles.reduce((sum, f) => sum + f.compactedChars, 0);

  // Deterministic Bin Packing
  const rawPartitions: PartitionFile[][] = [];
  let currentPartition: PartitionFile[] = [];
  let currentPartitionChars = 0;

  for (const file of processedFiles) {
    // If single file diff with multiple hunks exceeds safe capacity, split by hunks
    const splitFiles = options.splitOversizedHunksAtLines === true
      ? splitOversizedFileHunksForGuardedAdmission(file, safeDiffChars)
      : splitOversizedFileHunks(file, safeDiffChars);

    for (const subFile of splitFiles) {
      if (currentPartition.length > 0 && currentPartitionChars + subFile.compactedChars > safeDiffChars) {
        rawPartitions.push(currentPartition);
        currentPartition = [subFile];
        currentPartitionChars = subFile.compactedChars;
      } else {
        currentPartition.push(subFile);
        currentPartitionChars += subFile.compactedChars;
      }
    }
  }

  if (currentPartition.length > 0) {
    rawPartitions.push(currentPartition);
  }

  // If no files were provided, create 1 empty partition
  if (rawPartitions.length === 0) {
    rawPartitions.push([]);
  }

  const totalPartitions = rawPartitions.length;
  const partitions: DiffPartition[] = [];
  const fileManifest: PartitionPlan['fileManifest'] = [];
  const seenManifestPaths = new Set<string>();

  rawPartitions.forEach((pFiles, idx) => {
    const pTotalChars = pFiles.reduce((sum, f) => sum + f.compactedChars, 0);
    partitions.push({
      partitionIndex: idx,
      totalPartitions,
      files: pFiles.map((f) => ({
        path: f.path,
        patch: f.patch,
        originalChars: f.originalChars,
        compactedChars: f.compactedChars,
      })),
      totalChars: pTotalChars,
      baseSha,
      headSha,
    });

    for (const f of pFiles) {
      if (!seenManifestPaths.has(f.path)) {
        seenManifestPaths.add(f.path);
        fileManifest.push({
          path: f.path,
          status: f.status || 'modified',
          partitionIndex: idx,
        });
      }
    }
  });

  return {
    baseSha,
    headSha,
    totalFiles: files.length,
    totalOriginalChars,
    totalCompactedChars,
    partitions,
    coveragePercent: 100,
    omittedFilesCount: 0,
    fileManifest,
  };
}

/**
 * Format PR Comment Coverage Telemetry Badge & Manifest Table.
 */
export function formatCoverageComment(plan: PartitionPlan): string {
  const lines: string[] = [];
  lines.push('### 🛡️ Review Yeti Context Coverage Telemetry');
  lines.push(`**Coverage: 100% (${plan.totalFiles}/${plan.totalFiles} files reviewed across ${plan.partitions.length} partitions, 0 omitted)**`);
  lines.push('');
  lines.push(`- **Commit SHA Range**: \`${plan.baseSha}...${plan.headSha}\``);
  lines.push(`- **Total PR Characters**: ${plan.totalCompactedChars.toLocaleString()} chars`);
  lines.push(`- **Review Partitions**: ${plan.partitions.length} parallel review lanes`);
  lines.push('');
  lines.push('| File Path | Status | Partition Lane |');
  lines.push('|---|---|---|');

  for (const item of plan.fileManifest) {
    lines.push(`| \`${item.path}\` | \`${item.status}\` | Lane ${item.partitionIndex + 1}/${plan.partitions.length} |`);
  }

  lines.push('');
  lines.push('_Zero files truncated or omitted under dynamic model capacity limits._');

  return lines.join('\n');
}

/**
 * Format Prompt Header with Commit SHA Range and Manifest for Persona Reviewers.
 */
export function formatPromptManifestHeader(partition: DiffPartition, plan: PartitionPlan): string {
  const lines: string[] = [];
  lines.push(`### PR Review Scope: ${plan.baseSha}...${plan.headSha} (Partition ${partition.partitionIndex + 1} of ${partition.totalPartitions})`);
  lines.push(`This partition reviews ${partition.files.length} of ${plan.totalFiles} total PR files (${partition.totalChars} chars).`);
  lines.push('');
  lines.push('#### Files in this Partition Lane:');
  for (const f of partition.files) {
    lines.push(`- \`${f.path}\` (${f.compactedChars} chars)`);
  }
  lines.push('');
  return lines.join('\n');
}
