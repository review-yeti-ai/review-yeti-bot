import { canonicalJson, sha256 } from './reviewCore';

export interface SemanticContextFinding { path?: string; line?: number }
export interface SemanticContextFile { path: string; patch?: string; mode?: string; isSubmodule?: boolean }

interface PatchEntry { kind: 'context' | 'add' | 'remove'; line: number; text: string }

function patchEntries(patch: string): { hunks: Array<{ start: number; end: number; entries: PatchEntry[] }>; normalized: PatchEntry[] } {
  const hunks: Array<{ start: number; end: number; entries: PatchEntry[] }> = [];
  const normalized: PatchEntry[] = [];
  let hunk: { start: number; end: number; entries: PatchEntry[] } | undefined;
  let newLine = 0;
  for (const line of patch.split(/\r?\n/u)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      hunk = { start, end: start + Math.max(0, count - 1), entries: [] };
      hunks.push(hunk);
      newLine = start;
      continue;
    }
    if (!hunk || line.startsWith('\\')) continue;
    let entry: PatchEntry | undefined;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      entry = { kind: 'add', line: newLine++, text: line.slice(1) };
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      entry = { kind: 'remove', line: newLine, text: line.slice(1) };
    } else if (line.startsWith(' ')) {
      entry = { kind: 'context', line: newLine++, text: line.slice(1) };
    }
    if (entry) {
      hunk.entries.push(entry);
      normalized.push(entry);
    }
  }
  return { hunks, normalized };
}

/**
 * Digest the changed hunk around a reported finding. Absolute line numbers and
 * hunk offsets are excluded so a pure line shift preserves context identity;
 * changed source lines or nearby code change the digest. Missing patches are
 * recorded explicitly as unavailable evidence.
 */
export function affectedContextDigest(
  finding: SemanticContextFinding,
  changedFiles: readonly SemanticContextFile[],
): string {
  const path = typeof finding.path === 'string' ? finding.path.replaceAll('\\', '/').replace(/^\.\//u, '') : '';
  const file = changedFiles.find((candidate) => candidate.path.replaceAll('\\', '/').replace(/^\.\//u, '') === path);
  if (!path || !file || typeof file.patch !== 'string') {
    return sha256(canonicalJson({ path, available: false, mode: file?.mode ?? null,
      isSubmodule: file?.isSubmodule === true }));
  }
  const parsed = patchEntries(file.patch);
  const targetLine = Number(finding.line);
  if (Number.isSafeInteger(targetLine) && targetLine > 0) {
    const targetHunk = parsed.hunks.find((candidate) => targetLine >= candidate.start && targetLine <= candidate.end);
    if (targetHunk) {
      const nearby = targetHunk.entries.filter((entry) => Math.abs(entry.line - targetLine) <= 2)
        .map(({ kind, text }) => ({ kind, text }));
      if (nearby.length > 0) {
        return sha256(canonicalJson({ path, mode: file.mode ?? null, isSubmodule: file.isSubmodule === true,
          available: true, context: nearby }));
      }
    }
  }
  // The finding may refer to an unchanged line inside an unusually sparse
  // hunk, or to a file-level finding. Retain the normalized patch as exact
  // context instead of inventing line-local evidence.
  return sha256(canonicalJson({ path, mode: file.mode ?? null, isSubmodule: file.isSubmodule === true,
    available: true, context: parsed.normalized.map(({ kind, text }) => ({ kind, text })) }));
}
