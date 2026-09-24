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
 *   root rules when any nested file exists (see `diffShrinkInput`).
 * - Matching is case-sensitive, as git is on Linux.
 *
 * Semantics follow gitattributes(5): a pattern with no slash matches the file
 * name at any depth; a pattern with a slash is anchored to the repository root
 * and `*` does not cross a slash; `**` follows the gitignore rules; the last
 * matching line decides each attribute.
 */

export type LinguistAttribute = 'linguist-generated' | 'linguist-vendored';

interface LinguistRule {
  matcher: RegExp;
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

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|\\]/gu, '\\$&');
}

/** Translate one glob segment run (no `**` handling) to a regex fragment. */
function translateGlob(glob: string): string {
  let out = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') { out += '[^/]*'; continue; }
    if (char === '?') { out += '[^/]'; continue; }
    if (char === '[') {
      const close = glob.indexOf(']', index + 2);
      if (close > index) {
        let body = glob.slice(index + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        // Keep the class literal except for the regex-significant backslash.
        out += `[${body.replace(/\\/gu, '\\\\')}]`;
        index = close;
        continue;
      }
      out += '\\[';
      continue;
    }
    if (char === '\\' && index + 1 < glob.length) {
      out += escapeRegex(glob[index + 1]);
      index += 1;
      continue;
    }
    out += escapeRegex(char);
  }
  return out;
}

/** Compile a gitattributes pattern to an anchored regex over repo-relative paths. */
export function compileGitattributesPattern(rawPattern: string): RegExp | null {
  let pattern = rawPattern;
  if (pattern.length === 0) return null;
  // A trailing slash names a directory; gitattributes never applies those to files.
  if (pattern.endsWith('/')) return null;
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern.length === 0) return null;
  if (!anchored) return new RegExp(`^(?:.*/)?${translateGlob(pattern)}$`, 'u');

  const segments = pattern.split('/');
  let regex = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (segment === '**') {
      // Leading or middle `**/`: zero or more directories. Trailing `/**`: everything inside.
      regex += last ? '.*' : '(?:[^/]*/)*';
      continue;
    }
    regex += translateGlob(segment) + (last ? '' : '/');
  }
  return new RegExp(`^${regex}$`, 'u');
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
    let matcher: RegExp | null;
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
    if (!rule.matcher.test(filePath)) continue;
    if (rule.generated !== undefined) generated = rule.generated;
    if (rule.vendored !== undefined) vendored = rule.vendored;
  }
  if (generated === true) return 'linguist-generated';
  if (vendored === true) return 'linguist-vendored';
  return null;
}
