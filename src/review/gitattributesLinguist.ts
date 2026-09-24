/**
 * Reads the `linguist-generated` and `linguist-vendored` attributes from a
 * repository's root `.gitattributes`, for the deterministic diff-shrink
 * exclusions (REL-1079, plan 2026-09-23 section 4 W2).
 *
 * Only the subset of gitattributes needed for these two attributes is
 * implemented, and every unsupported construct resolves toward "not excluded"
 * (the file is reviewed, as it is today):
 *
 * - Quoted patterns and macro definitions (`[attr]...`) are skipped.
 * - Negative patterns (`!pattern`) are invalid in gitattributes and skipped.
 * - Nested `.gitattributes` files are not read; the caller refuses to apply
 *   root rules when any nested file exists (see `loadDiffShrinkInput`).
 * - Matching is case-sensitive, as git is on Linux.
 *
 * Semantics follow gitattributes(5): a pattern with no slash matches the file
 * name at any depth; a pattern with a slash is anchored to the repository root
 * and `*` does not cross a slash; `**` follows the gitignore rules; the last
 * matching line decides each attribute. Matching is done without regular
 * expressions, in time linear in pattern and path size, because the patterns
 * are repository content.
 */

import type { LinguistAttribute } from '../types/diffShrink';

export type { LinguistAttribute };

interface LinguistRule {
  matcher: GitattributesMatcher;
  pattern: string;
  /** true = set, false = unset/false, null = unspecified (`!attr`). */
  generated?: boolean | null;
  vendored?: boolean | null;
}

export interface LinguistAttributes {
  rules: readonly LinguistRule[];
  /** Whether any rule turns either attribute on. */
  hasExclusions: boolean;
}

const MAX_GITATTRIBUTES_BYTES = 256 * 1024;
const MAX_RULES = 2_000;

/** One glob token: `*`, `?`, a bracket class, or a literal character. */
type GlobToken =
  | { kind: 'star' }
  | { kind: 'any' }
  | { kind: 'class'; negated: boolean; items: ReadonlyArray<string | [string, string]> }
  | { kind: 'char'; char: string };

/** A compiled pattern: path segments of tokens, with `null` for a `**` segment. */
export interface GitattributesMatcher {
  /** No slash in the pattern: match the file name at any depth. */
  basenameOnly: boolean;
  segments: ReadonlyArray<ReadonlyArray<GlobToken> | null>;
  /** Whether the repo-relative path matches. Linear in pattern and path size. */
  test(path: string): boolean;
}

const MAX_PATTERN_CHARS = 512;
const MAX_PATH_SEGMENTS = 256;

function tokenize(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      // Consecutive stars inside a segment are one star.
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' });
      continue;
    }
    if (char === '?') { tokens.push({ kind: 'any' }); continue; }
    if (char === '[') {
      const close = glob.indexOf(']', index + 2);
      if (close > index) {
        let body = glob.slice(index + 1, close);
        const negated = body.startsWith('!') || body.startsWith('^');
        if (negated) body = body.slice(1);
        const items: Array<string | [string, string]> = [];
        for (let at = 0; at < body.length; at += 1) {
          if (body[at + 1] === '-' && at + 2 < body.length) { items.push([body[at], body[at + 2]]); at += 2; }
          else items.push(body[at]);
        }
        tokens.push({ kind: 'class', negated, items });
        index = close;
        continue;
      }
    }
    if (char === '\\' && index + 1 < glob.length) {
      tokens.push({ kind: 'char', char: glob[index + 1] });
      index += 1;
      continue;
    }
    tokens.push({ kind: 'char', char });
  }
  return tokens;
}

function tokenMatches(token: GlobToken, char: string): boolean {
  if (token.kind === 'any') return true;
  if (token.kind === 'char') return token.char === char;
  if (token.kind === 'class') {
    const hit = token.items.some((item) => (typeof item === 'string' ? item === char : char >= item[0] && char <= item[1]));
    return hit !== token.negated;
  }
  return false;
}

/**
 * Wildcard match of one path segment. The classic single-backtrack-point
 * algorithm: O(pattern x text) worst case, never exponential, so a crafted
 * `.gitattributes` cannot stall the worker.
 */
function matchSegment(tokens: ReadonlyArray<GlobToken>, text: string): boolean {
  let t = 0;
  let s = 0;
  let starToken = -1;
  let starText = 0;
  while (s < text.length) {
    if (t < tokens.length && tokens[t].kind !== 'star' && tokenMatches(tokens[t], text[s])) {
      t += 1; s += 1;
    } else if (t < tokens.length && tokens[t].kind === 'star') {
      starToken = t; starText = s; t += 1;
    } else if (starToken >= 0) {
      t = starToken + 1; starText += 1; s = starText;
    } else {
      return false;
    }
  }
  while (t < tokens.length && tokens[t].kind === 'star') t += 1;
  return t === tokens.length;
}

/**
 * Segment-wise match with `**` handled by memoised dynamic programming over
 * (pattern segment, path segment): O(segments^2) segment matches at most,
 * whatever the number of `**` segments.
 */
function matchSegments(pattern: ReadonlyArray<ReadonlyArray<GlobToken> | null>, path: readonly string[]): boolean {
  const memo = new Map<number, boolean>();
  const width = path.length + 1;
  const go = (p: number, q: number): boolean => {
    const key = p * width + q;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (p === pattern.length) {
      result = q === path.length;
    } else if (pattern[p] === null) {
      const last = p === pattern.length - 1;
      // Trailing `/**`: one or more remaining entries. Otherwise zero or more directories.
      result = last ? q < path.length : (go(p + 1, q) || (q < path.length - 1 && go(p, q + 1)));
    } else {
      result = q < path.length && matchSegment(pattern[p] as ReadonlyArray<GlobToken>, path[q]) && go(p + 1, q + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** Compile a gitattributes pattern to a matcher over repo-relative paths. */
export function compileGitattributesPattern(rawPattern: string): GitattributesMatcher | null {
  let pattern = rawPattern;
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_CHARS) return null;
  // A trailing slash names a directory; gitattributes never applies those to files.
  if (pattern.endsWith('/')) return null;
  const basenameOnly = !pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern.length === 0) return null;
  const segments: Array<ReadonlyArray<GlobToken> | null> = [];
  // No slash: one file-name glob. A bare `**` there is just a star.
  if (basenameOnly) segments.push(tokenize(pattern));
  else for (const segment of pattern.split('/')) {
    if (segment === '**') {
      // Adjacent `**` segments mean the same as one.
      if (segments.length === 0 || segments[segments.length - 1] !== null) segments.push(null);
      continue;
    }
    segments.push(tokenize(segment));
  }
  return {
    basenameOnly,
    segments,
    test(path: string): boolean {
      const parts = path.split('/');
      if (parts.length > MAX_PATH_SEGMENTS) return false;
      const first = segments[0];
      if (basenameOnly) return first !== null && first !== undefined && matchSegment(first, parts[parts.length - 1]);
      return matchSegments(segments, parts);
    },
  };
}

function attributeState(tokens: readonly string[], name: LinguistAttribute): boolean | null | undefined {
  let state: boolean | null | undefined;
  for (const token of tokens) {
    if (token === name) state = true;
    else if (token === `-${name}`) state = false;
    else if (token === `!${name}`) state = null;
    else if (token.startsWith(`${name}=`)) state = token.slice(name.length + 1).toLowerCase() === 'true';
  }
  return state;
}

/** Parse the linguist rules out of `.gitattributes` content. */
export function parseLinguistAttributes(content: string): LinguistAttributes {
  const rules: LinguistRule[] = [];
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_GITATTRIBUTES_BYTES) {
    return { rules, hasExclusions: false };
  }
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('"') || line.startsWith('[attr]')) continue;
    if (line.startsWith('!')) continue;
    const [pattern, ...tokens] = line.split(/[ \t]+/u);
    const generated = attributeState(tokens, 'linguist-generated');
    const vendored = attributeState(tokens, 'linguist-vendored');
    if (generated === undefined && vendored === undefined) continue;
    let matcher: GitattributesMatcher | null;
    try { matcher = compileGitattributesPattern(pattern); } catch { matcher = null; }
    if (!matcher) continue;
    rules.push({ matcher, pattern, generated, vendored });
    if (rules.length >= MAX_RULES) break;
  }
  return {
    rules,
    hasExclusions: rules.some((rule) => rule.generated === true || rule.vendored === true),
  };
}

/**
 * The linguist attribute that excludes this path, or null. When both are set,
 * `linguist-generated` is reported. The last matching rule decides each one.
 */
export function linguistExclusionFor(attributes: LinguistAttributes, filePath: string): LinguistAttribute | null {
  let generated: boolean | null | undefined;
  let vendored: boolean | null | undefined;
  for (const rule of attributes.rules) {
    let matched: boolean;
    // Fail open: a rule that cannot be evaluated excludes nothing.
    try { matched = rule.matcher.test(filePath); } catch { matched = false; }
    if (!matched) continue;
    if (rule.generated !== undefined) generated = rule.generated;
    if (rule.vendored !== undefined) vendored = rule.vendored;
  }
  if (generated === true) return 'linguist-generated';
  if (vendored === true) return 'linguist-vendored';
  return null;
}
