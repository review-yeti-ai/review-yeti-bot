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
 * and any finding on it was discarded during arbitration. cisco-cdr has eight
 * such paths today.
 */
function unquoteGitPath(raw: string): string {
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

export interface ChangedFile {
  path: string;
  patch: string;
}

/**
 * Splits a unified diff into per-file chunks. `unreadable` carries the header of
 * every chunk no path could be read from -- an unreviewable file, which the
 * caller must surface rather than drop.
 */
export function parseChangedFiles(diff: string): { files: ChangedFile[]; unreadable: string[] } {
  const files: ChangedFile[] = [];
  const unreadable: string[] = [];
  for (const chunk of String(diff).split(/^(?=diff --git )/mu)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const path = pathFromChunk(chunk);
    if (path && path !== '/dev/null') files.push({ path, patch: chunk });
    else unreadable.push((chunk.split('\n', 1)[0] || '').slice(0, 200));
  }
  return { files, unreadable };
}
