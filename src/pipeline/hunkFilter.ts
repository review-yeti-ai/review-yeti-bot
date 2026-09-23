export interface ChangedFile {
  path: string;
  patch?: string;
  content?: string;
}

export interface FilteredFileResult {
  path: string;
  status: 'included' | 'ignored' | 'truncated';
  ignoreReason?: string;
  originalPatchLength: number;
  filteredPatchLength: number;
  patch?: string;
  content?: string;
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

/** Generated or compiled files recognizable by their own file name. */
const GENERATED_FILE_PATTERNS = [
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /\.pb\.go$/,
  /\.generated\.[t|j]s$/,
  /_pb\.[t|j]s$/,
];

/**
 * Build output directories. Only the location marks these as generated, so a
 * hand-written script placed there looks identical to compiler output.
 */
const GENERATED_OUTPUT_DIR_PATTERNS = [
  /^dist\//,
  /^build\//,
  /^target\//,
  /^\.next\//,
];

/**
 * - `lockfile`: a dependency lockfile (the manifest that drives it is not one).
 * - `generated-artifact`: generated or compiled output identified by file name.
 * - `generated-output-dir`: any file under a build output directory.
 */
export type ExcludedFileKind = 'lockfile' | 'generated-artifact' | 'generated-output-dir';

/**
 * The lockfile/generated classification the hunk filter excludes from review
 * context, independent of any repository `path_filters`.
 */
export function classifyLockfileOrGeneratedPath(filePath: string): ExcludedFileKind | null {
  const lowerPath = filePath.toLowerCase();
  const filename = lowerPath.split('/').pop() || lowerPath;
  if (IGNORED_LOCKFILES.includes(filename)) return 'lockfile';
  if (GENERATED_FILE_PATTERNS.some((pat) => pat.test(lowerPath))) return 'generated-artifact';
  if (GENERATED_OUTPUT_DIR_PATTERNS.some((pat) => pat.test(lowerPath))) return 'generated-output-dir';
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

    if (filteredPatch && filteredPatch.length > 20000) {
      // Truncate excessively large single diffs
      filteredPatch = filteredPatch.slice(0, 20000) + '\n\n... [Diff truncated to 20k chars by Smart Hunk Filter] ...';
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
