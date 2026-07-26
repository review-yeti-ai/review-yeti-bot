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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function filterDiffHunks(changedFiles: ChangedFile[]): HunkFilterResult {
  let originalTokenEstimate = 0;
  let filteredTokenEstimate = 0;
  let ignoredFilesCount = 0;

  const files: FilteredFileResult[] = changedFiles.map((file) => {
    const rawText = (file.patch || '') + (file.content || '');
    const origTokens = estimateTokens(rawText);
    originalTokenEstimate += origTokens;

    const lowerPath = file.path.toLowerCase();
    const filename = lowerPath.split('/').pop() || lowerPath;

    // 1. Lockfile Filter
    if (IGNORED_LOCKFILES.includes(filename)) {
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
    if (GENERATED_PATTERNS.some((pat) => pat.test(lowerPath))) {
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
