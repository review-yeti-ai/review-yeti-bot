import { z } from 'zod';
import { MAX_PATH_CHARACTERS } from '../review/reviewEvidenceLimits';

/** GitHub compare responses expose at most 300 changed files. */
export const MAX_COMPARISON_FILES = 300;
export const MAX_COMPARISON_FILE_PATCH_BYTES = 512_000;
const count = z.number().int().nonnegative().safe();
export const comparisonFilePathSchema = z.string().min(1).max(MAX_PATH_CHARACTERS).refine((value) =>
  !/[\u0000-\u001f\u007f\\]/u.test(value) && !value.startsWith('/')
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'));
const entry = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/u), filename: comparisonFilePathSchema,
  status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
  previous_filename: comparisonFilePathSchema.optional(), additions: count, deletions: count, changes: count,
  patch: z.string().min(1).max(MAX_COMPARISON_FILE_PATCH_BYTES).nullish(),
});

export type ComparisonFileEvidence = {
  path: string;
  previousPath?: string;
  blobSha: string;
  status: z.infer<typeof entry>['status'];
  patch?: string;
};

/** The compare API can omit/truncate patches. Prove every hunk is closed and
 * totals match GitHub's independent per-file counters before using any lines.
 * Preserve the original patch; never manufacture a unified whole-PR diff. */
function completePatch(file: z.infer<typeof entry>): boolean {
  if (typeof file.patch !== 'string' || Buffer.byteLength(file.patch, 'utf8') > MAX_COMPARISON_FILE_PATCH_BYTES
    || file.changes !== file.additions + file.deletions) return false;
  let oldLeft = 0; let newLeft = 0; let additions = 0; let deletions = 0;
  let oldEnd = 0; let newEnd = 0; let hunks = 0; let mayMarkNoNewline = false;
  const lines = file.patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u.exec(line);
    if (header) {
      if (oldLeft !== 0 || newLeft !== 0) return false;
      const oldStart = Number(header[1]); const newStart = Number(header[3]);
      oldLeft = Number(header[2] ?? 1); newLeft = Number(header[4] ?? 1);
      if (![oldStart, newStart, oldLeft, newLeft, oldStart + oldLeft, newStart + newLeft].every(Number.isSafeInteger)
        || (oldLeft > 0 && oldStart === 0) || (newLeft > 0 && newStart === 0)
        || (oldLeft === 0 && newLeft === 0)
        || (hunks > 0 && (oldStart < oldEnd || newStart < newEnd))) return false;
      oldEnd = oldStart + oldLeft; newEnd = newStart + newLeft;
      hunks++; mayMarkNoNewline = false;
      continue;
    }
    if (line === '\\ No newline at end of file') {
      if (!mayMarkNoNewline) return false;
      mayMarkNoNewline = false;
      continue;
    }
    if (hunks === 0) return false;
    if (line.startsWith('+')) { newLeft--; additions++; }
    else if (line.startsWith('-')) { oldLeft--; deletions++; }
    else if (line.startsWith(' ')) { oldLeft--; newLeft--; }
    else return false;
    if (oldLeft < 0 || newLeft < 0) return false;
    mayMarkNoNewline = true;
  }
  return hunks > 0 && oldLeft === 0 && newLeft === 0
    && additions === file.additions && deletions === file.deletions;
}

export function parseComparisonFiles(input: unknown): ComparisonFileEvidence[] {
  try {
    return z.array(entry).max(MAX_COMPARISON_FILES).parse(input).map((file) => {
      const needsPrevious = file.status === 'renamed' || file.status === 'copied';
      if (needsPrevious !== Boolean(file.previous_filename)
        || file.previous_filename === file.filename) throw new Error();
      return {
        path: file.filename, blobSha: file.sha, status: file.status,
        ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
        ...(completePatch(file) ? { patch: file.patch! } : {}),
      };
    });
  } catch {
    // Neither validation errors nor upstream patches belong in service logs.
    throw new Error('Review reader file evidence unavailable');
  }
}
