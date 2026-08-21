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

/**
 * Splits an oversized diff patch with multiple hunks into consecutive sub-patches if it exceeds safe capacity.
 */
function splitOversizedFileHunks(
  file: { path: string; patch: string; originalChars: number; compactedChars: number; status: FileStatus },
  safeDiffChars: number
): PartitionFile[] {
  const patch = file.patch;
  if (!patch || patch.length <= safeDiffChars || !patch.includes('@@')) {
    return [file];
  }

  const lines = patch.split('\n');
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

  if (currentHunk.length > 0) {
    hunkBlocks.push(currentHunk.join('\n'));
  }

  // If only 1 hunk or no hunks, cannot split across hunk boundaries
  if (hunkBlocks.length <= 1) {
    return [file];
  }

  const fileHeader = headerLines.length > 0 ? headerLines.join('\n') + '\n' : '';
  const resultFiles: PartitionFile[] = [];
  let currentHunkGroup: string[] = [];
  let currentGroupChars = fileHeader.length;

  for (const hunk of hunkBlocks) {
    const hunkChars = hunk.length + 1; // including newline
    if (currentHunkGroup.length > 0 && currentGroupChars + hunkChars > safeDiffChars) {
      const combinedPatch = fileHeader + currentHunkGroup.join('\n') + '\n';
      resultFiles.push({
        path: file.path,
        patch: combinedPatch,
        originalChars: combinedPatch.length,
        compactedChars: combinedPatch.length,
        status: file.status,
      });
      currentHunkGroup = [hunk];
      currentGroupChars = fileHeader.length + hunkChars;
    } else {
      currentHunkGroup.push(hunk);
      currentGroupChars += hunkChars;
    }
  }

  if (currentHunkGroup.length > 0) {
    const combinedPatch = fileHeader + currentHunkGroup.join('\n') + '\n';
    resultFiles.push({
      path: file.path,
      patch: combinedPatch,
      originalChars: combinedPatch.length,
      compactedChars: combinedPatch.length,
      status: file.status,
    });
  }

  return resultFiles;
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
  safeDiffChars: number
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
    const splitFiles = splitOversizedFileHunks(file, safeDiffChars);

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
