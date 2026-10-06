import { createHash } from 'node:crypto';
import type { ReviewSourcePresence } from './reviewCore';

/**
 * Git writes a diff header as `diff --git a/<src> b/<dst>`. With no quoting and
 * a path containing a space that line is genuinely ambiguous -- `a/x y b/z` can
 * be split more than one way -- so the header is the LAST source consulted, not
 * the first. `+++`/`---`/`rename to` each carry exactly one path on their own
 * line and are unambiguous.
 *
 * The previous `(\S+)` header match stopped at the first space, so
 * `a/sip message.txt` yielded no usable path at all. That failed OPEN and
 * silently: the file dropped out of `changedFiles`, was never sent to the panel,
 * and any finding on it was discarded during arbitration. example-api has eight
 * such paths today.
 */
export function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2) return trimmed;
  const inner = trimmed.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 };
  const bytes: number[] = [];
  for (let index = 0; index < inner.length; index += 1) {
    if (inner[index] !== '\\') {
      // Re-encode so a literal multi-byte character survives the Buffer round trip.
      bytes.push(...Buffer.from(inner[index], 'utf8'));
      continue;
    }
    const octal = /^[0-7]{3}/u.exec(inner.slice(index + 1, index + 4));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const next = inner[index + 1];
    if (next && Object.prototype.hasOwnProperty.call(simple, next)) {
      bytes.push(simple[next]);
      index += 1;
      continue;
    }
    bytes.push(...Buffer.from(inner[index], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripSidePrefix(path: string): string {
  return /^[ab]\//u.test(path) ? path.slice(2) : path;
}

/** Reads the one path a finding could be anchored to, or '' if the chunk is unreadable. */
function pathFromChunk(chunk: string): string {
  const line = (pattern: RegExp): string => {
    const match = pattern.exec(chunk);
    return match ? unquoteGitPath(match[1].replace(/\r$/u, '')) : '';
  };

  // The post-image first: a finding anchors to an added line, which only the
  // destination path can carry.
  const plus = line(/^\+\+\+ (.+)$/mu);
  if (plus && plus !== '/dev/null') return stripSidePrefix(plus);

  // A pure rename or a binary change has no `+++` line.
  const renamed = line(/^rename to (.+)$/mu);
  if (renamed) return stripSidePrefix(renamed);

  const minus = line(/^--- (.+)$/mu);
  if (minus && minus !== '/dev/null') return stripSidePrefix(minus);

  // Last resort. Only trustworthy when the header is unambiguous: either both
  // sides are quoted, or neither path contains a space.
  const quoted = /^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")/u.exec(chunk);
  if (quoted) return stripSidePrefix(unquoteGitPath(quoted[2]));
  const plain = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/mu.exec(chunk);
  if (plain) return stripSidePrefix(`b/${plain[2]}`);
  return '';
}

import { isSubmodulePatch } from './submodulePatch';
export { isSubmodulePatch } from './submodulePatch';

export interface ChangedFile {
  path: string;
  patch: string;
  sourcePresence?: ReviewSourcePresence;
  mode?: string;
  isSubmodule?: boolean;
}

export interface ChangedFileIdentity {
  repository: string;
  baseSha: string;
  headSha: string;
}

function validIdentity(identity: ChangedFileIdentity | undefined): identity is ChangedFileIdentity {
  return Boolean(identity && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity.repository)
    && /^[a-f0-9]{40}$/u.test(identity.baseSha) && /^[a-f0-9]{40}$/u.test(identity.headSha));
}

function patchDigest(patch: string): string {
  return createHash('sha256').update(patch).digest('hex');
}

function nullSidePresence(chunk: string, path: string, identity: ChangedFileIdentity | undefined): ReviewSourcePresence | undefined {
  if (!validIdentity(identity)) return undefined;
  const oldPath = /^--- (.+)$/mu.exec(chunk)?.[1]?.replace(/\r$/u, '');
  const newPath = /^\+\+\+ (.+)$/mu.exec(chunk)?.[1]?.replace(/\r$/u, '');
  const oldAbsent = oldPath === '/dev/null';
  const newAbsent = newPath === '/dev/null';
  if (oldAbsent === newAbsent) return undefined;
  const presentSidePath = unquoteGitPath((oldAbsent ? newPath : oldPath) ?? '').replace(/^[ab]\//u, '');
  if (presentSidePath !== path) return undefined;
  return { version: 'ReviewSourcePresence.v1', repository: identity.repository, path,
    baseSha: identity.baseSha, headSha: identity.headSha, absentSide: oldAbsent ? 'base' : 'head',
    evidence: 'unified-diff-null-side', patchDigest: patchDigest(chunk) };
}

/** Bind explicit unified-diff absence markers to the admitted source revisions. */
export function bindChangedFileSourcePresence(files: readonly ChangedFile[], identity: ChangedFileIdentity): ChangedFile[] {
  if (!validIdentity(identity)) throw new Error('Changed-file source identity is invalid');
  return files.map((file) => {
    const sourcePresence = file.sourcePresence ?? nullSidePresence(file.patch, file.path, identity);
    return { ...file, ...(sourcePresence ? { sourcePresence } : {}) };
  });
}

/** Bind an authoritative comparison status to its exact changed-file patch. */
export function bindComparisonAbsentSide(file: ChangedFile, identity: ChangedFileIdentity,
  absentSide: 'head' | 'base'): ChangedFile {
  if (!validIdentity(identity)) throw new Error('Changed-file source identity is invalid');
  return { ...file, sourcePresence: { version: 'ReviewSourcePresence.v1', repository: identity.repository,
    path: file.path, baseSha: identity.baseSha, headSha: identity.headSha, absentSide,
    evidence: 'comparison-status', patchDigest: patchDigest(file.patch) } };
}

/** Old-file line numbers removed by a unified diff, used only for authenticated deletions. */
export function deletedLineNumbers(patch: string | undefined): Set<number> | null {
  if (typeof patch !== 'string') return null;
  const deleted = new Set<number>();
  let oldLine = 0; let inHunk = false;
  for (const line of patch.split(/\r?\n/u)) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('-')) { deleted.add(oldLine); oldLine += 1; }
    else if (line.startsWith('+')) continue;
    else if (line.startsWith(' ')) oldLine += 1;
  }
  return deleted;
}

function extractMode(chunk: string): string | undefined {
  const match = /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+ (\d+)/mu.exec(chunk)
    ?? /^(?:new|deleted) file mode (\d+)/mu.exec(chunk)
    ?? /^old mode (\d+)/mu.exec(chunk)
    ?? /^new mode (\d+)/mu.exec(chunk);
  return match ? match[1] : undefined;
}

/**
 * Splits a unified diff into per-file chunks. `unreadable` carries the header of
 * every chunk no path could be read from -- an unreviewable file, which the
 * caller must surface rather than drop.
 */
export function parseChangedFiles(diff: string, identity?: ChangedFileIdentity): { files: ChangedFile[]; unreadable: string[] } {
  const files: ChangedFile[] = [];
  const unreadable: string[] = [];
  for (const chunk of String(diff).split(/^(?=diff --git )/mu)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const path = pathFromChunk(chunk);
    const mode = extractMode(chunk);
    const isSubmodule = mode === '160000' || isSubmodulePatch(chunk);
    if (path && path !== '/dev/null') {
      const sourcePresence = nullSidePresence(chunk, path, identity);
      files.push({
        path,
        patch: chunk,
        ...(sourcePresence ? { sourcePresence } : {}),
        ...(mode ? { mode } : {}),
        ...(isSubmodule ? { isSubmodule: true } : {}),
      });
    } else {
      unreadable.push((chunk.split('\n', 1)[0] || '').slice(0, 200));
    }
  }
  return { files, unreadable };
}
