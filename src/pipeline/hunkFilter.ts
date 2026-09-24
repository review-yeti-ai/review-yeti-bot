export interface ChangedFile {
  path: string;
  patch?: string;
  content?: string;
}

/**
 * Largest single-file patch, in characters, sent to a reviewer. A longer patch
 * is cut here; the cut is recorded on the file (`truncation`) so every engine
 * can disclose it (REL-1092, plan section 3.5: nothing dropped silently).
 */
export const MAX_FILE_PATCH_CHARS = 20_000;

/** A patch cut at `MAX_FILE_PATCH_CHARS`: its size before and after the cut. */
export interface PatchTruncation {
  originalChars: number;
  keptChars: number;
}

export interface FilteredFileResult {
  path: string;
  status: 'included' | 'ignored' | 'truncated';
  ignoreReason?: string;
  originalPatchLength: number;
  filteredPatchLength: number;
  patch?: string;
  content?: string;
  /** Set exactly when `status` is `'truncated'`. */
  truncation?: PatchTruncation;
}

export interface HunkFilterResult {
  files: FilteredFileResult[];
  stats: {
    totalFiles: number;
    ignoredFilesCount: number;
    originalTokenEstimate: number;
    filteredTokenEstimate: number;
    tokensSaved: number;
    reductionPercentage: number;
  };
}

const IGNORED_LOCKFILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'go.sum',
  'cargo.lock',
  'poetry.lock',
  'gemfile.lock',
  'mix.lock',
  'pipfile.lock',
  'composer.lock',
];

const GENERATED_PATTERNS = [
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /\.pb\.go$/,
  /\.generated\.[t|j]s$/,
  /_pb\.[t|j]s$/,
  /^dist\//,
  /^build\//,
  /^target\//,
  /^\.next\//,
];

/**
 * The lockfile/generated classification the hunk filter excludes from review
 * context, independent of any repository `path_filters`. Shared with the
 * no-reviewable-content decision (REL-972) so both read one list.
 */
export function classifyLockfileOrGeneratedPath(filePath: string): 'lockfile' | 'generated' | null {
  const lowerPath = filePath.toLowerCase();
  const filename = lowerPath.split('/').pop() || lowerPath;
  if (IGNORED_LOCKFILES.includes(filename)) return 'lockfile';
  if (GENERATED_PATTERNS.some((pat) => pat.test(lowerPath))) return 'generated';
  return null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function matchGlob(pattern: string, targetPath: string): boolean {
  if (pattern === '**') return true;
  const lowerPattern = pattern.toLowerCase();
  const lowerPath = targetPath.toLowerCase();

  if (!pattern.includes('/')) {
    const filename = lowerPath.split('/').pop() || lowerPath;
    const escaped = lowerPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`).test(filename) || new RegExp(`^${escaped}$`).test(lowerPath);
  }

  const escaped = lowerPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*');
  return new RegExp(`^${escaped}$`).test(lowerPath);
}

export function filterDiffHunks(
  changedFiles: ChangedFile[],
  options?: { path_filters?: string[] }
): HunkFilterResult {
  let originalTokenEstimate = 0;
  let filteredTokenEstimate = 0;
  let ignoredFilesCount = 0;

  const files: FilteredFileResult[] = changedFiles.map((file) => {
    const rawText = (file.patch || '') + (file.content || '');
    const origTokens = estimateTokens(rawText);
    originalTokenEstimate += origTokens;

    const excludedKind = classifyLockfileOrGeneratedPath(file.path);

    // 0. Path Filters
    if (options?.path_filters && options.path_filters.length > 0) {
      if (options.path_filters.some((pattern) => matchGlob(pattern, file.path))) {
        ignoredFilesCount++;
        return {
          path: file.path,
          status: 'ignored',
          ignoreReason: 'Excluded by path_filters pattern',
          originalPatchLength: rawText.length,
          filteredPatchLength: 0,
        };
      }
    }

    // 1. Lockfile Filter
    if (excludedKind === 'lockfile') {
      ignoredFilesCount++;
      return {
        path: file.path,
        status: 'ignored',
        ignoreReason: 'Lockfile noise excluded from review context',
        originalPatchLength: rawText.length,
        filteredPatchLength: 0,
      };
    }

    // 2. Generated File Filter
    if (excludedKind !== null) {
      ignoredFilesCount++;
      return {
        path: file.path,
        status: 'ignored',
        ignoreReason: 'Generated / compiled asset excluded',
        originalPatchLength: rawText.length,
        filteredPatchLength: 0,
      };
    }

    // 3. Patch Truncation / Hunk Filtering
    let filteredPatch = file.patch;
    let status: 'included' | 'truncated' = 'included';
    let truncation: PatchTruncation | undefined;

    if (filteredPatch && filteredPatch.length > MAX_FILE_PATCH_CHARS) {
      // Truncate excessively large single diffs. The remaining hunks are not
      // sent; the cut is recorded so the check summary discloses it. Reviewing
      // the rest as further chunks is W6 (REL-1083, REVIEW_YETI_MAP_REDUCE,
      // src/review/mapReduceReview.ts). With REVIEW_YETI_BUDGET (REL-1082,
      // src/review/reviewBudget.ts) a file that fits a lane's budget is sent whole instead.
      truncation = { originalChars: filteredPatch.length, keptChars: MAX_FILE_PATCH_CHARS };
      filteredPatch = filteredPatch.slice(0, MAX_FILE_PATCH_CHARS)
        + `\n\n... [Diff truncated to ${MAX_FILE_PATCH_CHARS / 1000}k chars by Smart Hunk Filter] ...`;
      status = 'truncated';
    }

    const filteredText = (filteredPatch || '') + (file.content || '');
    const filtTokens = estimateTokens(filteredText);
    filteredTokenEstimate += filtTokens;

    return {
      path: file.path,
      status,
      originalPatchLength: rawText.length,
      filteredPatchLength: filteredText.length,
      patch: filteredPatch,
      content: file.content,
      ...(truncation ? { truncation } : {}),
    };
  });

  const tokensSaved = Math.max(0, originalTokenEstimate - filteredTokenEstimate);
  const reductionPercentage = originalTokenEstimate > 0
    ? Math.round((tokensSaved / originalTokenEstimate) * 100)
    : 0;

  return {
    files,
    stats: {
      totalFiles: changedFiles.length,
      ignoredFilesCount,
      originalTokenEstimate,
      filteredTokenEstimate,
      tokensSaved,
      reductionPercentage,
    },
  };
}
