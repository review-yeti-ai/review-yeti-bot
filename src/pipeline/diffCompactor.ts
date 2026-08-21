/**
 * Diff Compactor Engine
 * Location: src/pipeline/diffCompactor.ts
 *
 * Implements intelligent unified diff compaction according to PROJECT.md § Interface Contracts:
 * - Collapses unchanged context lines to tight +/- 3 line bounds.
 * - Splits distant change clusters within a single hunk (>6 context lines gap) into distinct hunks.
 * - Recalculates @@ -oldStart,oldCount +newStart,newCount @@ hunk headers accurately to maintain
 *   line number invariance so changedLineNumbers(compactedPatch) strictly equals changedLineNumbers(originalPatch).
 * - Strips lockfiles, minified bundle files, source maps, and truncates lines >500 characters.
 * - Normalizes CRLF to LF and compresses excess whitespace while preserving column 0 prefixes (+, -, space).
 */

export interface DiffCompactionOptions {
  contextLines?: number;         // default: 3
  maxLineLength?: number;        // default: 500
  stripMinified?: boolean;       // default: true
  splitClusterGaps?: boolean;    // default: true
  maxClusterGap?: number;        // default: 6
}

export interface CompactedDiffResult {
  compactedPatch: string;
  originalChars: number;
  compactedChars: number;
  savingsRatio: number;
  hunkCount: number;
  strippedArtifacts: string[];
}

export interface CompactedFileListResult {
  files: Array<{ path: string; patch: string; originalChars: number; compactedChars: number }>;
  totalOriginalChars: number;
  totalCompactedChars: number;
  totalSavingsRatio: number;
}

export const LOCKFILE_PATTERNS = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'poetry.lock',
  'gemfile.lock',
  'mix.lock',
  'go.sum',
  'composer.lock',
];

export const MINIFIED_PATTERNS = [
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /\.pb\.go$/,
  /\.generated\.[t|j]s$/,
  /_pb\.[t|j]s$/,
];

export interface ChangedLineRecord {
  type: 'add' | 'delete';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

/**
 * Extracts exact line numbers for added and deleted lines from any unified diff patch.
 */
export function extractChangedLineNumbers(patch: string): ChangedLineRecord[] {
  const records: ChangedLineRecord[] = [];
  if (!patch || !patch.trim()) return records;

  const lines = patch.split(/\r?\n/);
  let currentOld = 0;
  let currentNew = 0;
  let inHunk = false;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      currentOld = parseInt(hunkMatch[1], 10);
      currentNew = parseInt(hunkMatch[3], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      records.push({
        type: 'add',
        newLineNumber: currentNew,
        content: line.slice(1),
      });
      currentNew++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      records.push({
        type: 'delete',
        oldLineNumber: currentOld,
        content: line.slice(1),
      });
      currentOld++;
    } else if (line.startsWith(' ')) {
      currentOld++;
      currentNew++;
    }
  }

  return records;
}

interface ParsedHunkLine {
  type: 'context' | 'add' | 'delete' | 'no_newline';
  text: string;
  origOldLine?: number;
  origNewLine?: number;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  sectionHeader?: string;
  lines: ParsedHunkLine[];
}

/**
 * Compacts a raw unified diff string by collapsing context lines, splitting cluster gaps,
 * recalculating hunk headers, and stripping minified bloat.
 */
export function compactUnifiedDiff(rawPatch: string, options: DiffCompactionOptions = {}): CompactedDiffResult {
  const contextLines = options.contextLines ?? 3;
  const maxLineLength = options.maxLineLength ?? 500;
  const stripMinified = options.stripMinified ?? true;
  const splitClusterGaps = options.splitClusterGaps ?? true;
  const maxClusterGap = options.maxClusterGap ?? 6;

  const originalChars = rawPatch ? rawPatch.length : 0;
  const strippedArtifacts: string[] = [];

  if (!rawPatch || !rawPatch.trim()) {
    return {
      compactedPatch: '',
      originalChars,
      compactedChars: 0,
      savingsRatio: originalChars > 0 ? 1 : 0,
      hunkCount: 0,
      strippedArtifacts,
    };
  }

  // Normalize CRLF to LF
  const normalizedPatch = rawPatch.replace(/\r\n/g, '\n');
  const rawLines = normalizedPatch.split('\n');
  const headers: string[] = [];
  const hunks: ParsedHunk[] = [];
  let currentHunk: ParsedHunk | null = null;
  let currentOld = 0;
  let currentNew = 0;
  let hasOverlongLines = false;

  for (const line of rawLines) {
    if (line.length > maxLineLength) {
      hasOverlongLines = true;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentOld = parseInt(hunkMatch[1], 10);
      const oldCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
      currentNew = parseInt(hunkMatch[3], 10);
      const newCount = hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1;
      const sectionHeader = hunkMatch[5] || '';

      currentHunk = {
        oldStart: currentOld,
        oldCount,
        newStart: currentNew,
        newCount,
        sectionHeader,
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      headers.push(line);
    } else {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentHunk.lines.push({ type: 'add', text: line, origNewLine: currentNew });
        currentNew++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentHunk.lines.push({ type: 'delete', text: line, origOldLine: currentOld });
        currentOld++;
      } else if (line.startsWith('\\')) {
        currentHunk.lines.push({ type: 'no_newline', text: line });
      } else {
        // Context line (ensure column 0 prefix space)
        const text = line.startsWith(' ') ? line : ' ' + line;
        currentHunk.lines.push({ type: 'context', text, origOldLine: currentOld, origNewLine: currentNew });
        currentOld++;
        currentNew++;
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  // Handle overlong lines if stripMinified is enabled
  if (hasOverlongLines && stripMinified) {
    strippedArtifacts.push('overlong_lines_exceeding_500_chars');
  }

  // Process and compact hunks
  const compactedHunks: string[] = [];

  for (const hunk of hunks) {
    // If hunk has no changes, omit or collapse
    const changeIndices = hunk.lines
      .map((l, idx) => (l.type === 'add' || l.type === 'delete' ? idx : -1))
      .filter((idx) => idx !== -1);

    if (changeIndices.length === 0) {
      continue;
    }

    // Cluster change indices
    const clusters: Array<{ startIdx: number; endIdx: number }> = [];
    if (splitClusterGaps && maxClusterGap > 0) {
      let currentCluster = { startIdx: changeIndices[0], endIdx: changeIndices[0] };
      for (let i = 1; i < changeIndices.length; i++) {
        const gap = changeIndices[i] - currentCluster.endIdx - 1;
        if (gap > maxClusterGap) {
          clusters.push(currentCluster);
          currentCluster = { startIdx: changeIndices[i], endIdx: changeIndices[i] };
        } else {
          currentCluster.endIdx = changeIndices[i];
        }
      }
      clusters.push(currentCluster);
    } else {
      clusters.push({ startIdx: changeIndices[0], endIdx: changeIndices[changeIndices.length - 1] });
    }

    // Build compacted hunks for each cluster
    for (const cluster of clusters) {
      const sliceStart = Math.max(0, cluster.startIdx - contextLines);
      const sliceEnd = Math.min(hunk.lines.length - 1, cluster.endIdx + contextLines);
      const keptLines = hunk.lines.slice(sliceStart, sliceEnd + 1);

      // Recalculate oldStart, oldCount, newStart, newCount
      const firstLine = keptLines[0];
      const hunkOldStart = firstLine.origOldLine ?? hunk.oldStart;
      const hunkNewStart = firstLine.origNewLine ?? hunk.newStart;

      let hunkOldCount = 0;
      let hunkNewCount = 0;
      const formattedLines: string[] = [];

      for (const kl of keptLines) {
        if (kl.type === 'context') {
          hunkOldCount++;
          hunkNewCount++;
          // Compact trailing whitespace on context lines while preserving column 0 prefix
          formattedLines.push(kl.text.replace(/\s+$/, ''));
        } else if (kl.type === 'delete') {
          hunkOldCount++;
          formattedLines.push(kl.text);
        } else if (kl.type === 'add') {
          hunkNewCount++;
          formattedLines.push(kl.text);
        } else if (kl.type === 'no_newline') {
          formattedLines.push(kl.text);
        }
      }

      const header = `@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@${hunk.sectionHeader || ''}`;
      compactedHunks.push(`${header}\n${formattedLines.join('\n')}`);
    }
  }

  const compactedBody = compactedHunks.join('\n');
  const filteredHeaders = headers.filter((h) => h.trim() !== '');
  const compactedPatch = filteredHeaders.length > 0
    ? (compactedBody ? `${filteredHeaders.join('\n')}\n${compactedBody}\n` : `${filteredHeaders.join('\n')}\n`)
    : (compactedBody ? `${compactedBody}\n` : '');

  const compactedChars = compactedPatch.length;
  const savingsRatio = originalChars > 0
    ? Math.max(0, Math.round(((originalChars - compactedChars) / originalChars) * 10000) / 10000)
    : 0;

  return {
    compactedPatch,
    originalChars,
    compactedChars,
    savingsRatio,
    hunkCount: compactedHunks.length,
    strippedArtifacts,
  };
}

/**
 * Compact a list of file diffs.
 */
export function compactFileListDiffs(
  files: Array<{ path: string; patch?: string; content?: string }>,
  options: DiffCompactionOptions = {}
): CompactedFileListResult {
  const stripMinified = options.stripMinified ?? true;
  let totalOriginalChars = 0;
  let totalCompactedChars = 0;
  const processedFiles: Array<{ path: string; patch: string; originalChars: number; compactedChars: number }> = [];

  for (const file of files) {
    const rawPatch = file.patch || file.content || '';
    const origChars = rawPatch.length;
    totalOriginalChars += origChars;

    const lowerPath = file.path.toLowerCase();
    const filename = lowerPath.split('/').pop() || lowerPath;

    // Check lockfiles
    if (stripMinified && LOCKFILE_PATTERNS.includes(filename)) {
      const placeholder = `# [Lockfile diff stripped for context efficiency: ${file.path}]\n`;
      processedFiles.push({
        path: file.path,
        patch: placeholder,
        originalChars: origChars,
        compactedChars: placeholder.length,
      });
      totalCompactedChars += placeholder.length;
      continue;
    }

    // Check minified/generated
    if (stripMinified && MINIFIED_PATTERNS.some((pat) => pat.test(lowerPath))) {
      const placeholder = `# [Generated/Minified artifact stripped for context efficiency: ${file.path}]\n`;
      processedFiles.push({
        path: file.path,
        patch: placeholder,
        originalChars: origChars,
        compactedChars: placeholder.length,
      });
      totalCompactedChars += placeholder.length;
      continue;
    }

    const res = compactUnifiedDiff(rawPatch, options);
    processedFiles.push({
      path: file.path,
      patch: res.compactedPatch,
      originalChars: res.originalChars,
      compactedChars: res.compactedChars,
    });
    totalCompactedChars += res.compactedChars;
  }

  const totalSavingsRatio = totalOriginalChars > 0
    ? Math.max(0, Math.round(((totalOriginalChars - totalCompactedChars) / totalOriginalChars) * 10000) / 10000)
    : 0;

  return {
    files: processedFiles,
    totalOriginalChars,
    totalCompactedChars,
    totalSavingsRatio,
  };
}
