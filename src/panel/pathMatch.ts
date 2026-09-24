import picomatch from 'picomatch';

/**
 * Path matching for the persona `find_files` tool (REL-1102).
 *
 * Reviewer models ask for globs such as `tests/fixtures/jev/*` or `**\/*.json`. The tool used to
 * treat every query as a plain substring, so those globs never matched anything. On #1030 that
 * zero-hit result became a false BLOCKING "fixture file missing" finding for a fixture that was
 * committed and read by CI.
 *
 * Rules:
 * - Matching is case-insensitive, and a leading `./` or `/` is ignored.
 * - Every query is still matched as a plain substring, so older queries keep working. This also
 *   covers literal paths that contain glob characters, such as the Next.js path `app/[id]/page.tsx`.
 * - A query that contains `*`, `?`, `[` or `{` is also matched as a glob with picomatch.
 *   `*` and `?` do not cross `/`, `**` does, and `{a,b}` is an alternation. Dotfiles match.
 * - A glob with no `/` is matched against the file name at any depth, so `*.json` finds
 *   `tests/fixtures/jev/score.json`.
 * - A glob with a `/` is matched from the repository root and also as a path suffix at any
 *   depth, so `fixtures/jev/*.json` finds `tests/fixtures/jev/score.json`.
 *
 * The matcher is deliberately permissive. An extra hit costs the model a few tokens, but a
 * missed hit becomes a false "file is missing" finding.
 */

/** Longer queries are rejected rather than compiled into a regex. */
export const MAX_PATH_QUERY_CHARS = 1024;

const GLOB_CHARS = /[*?[{]/u;

/** Remove a leading `./` or `/`. Tree paths never start with either. */
export function normalizeRepoPath(path: string): string {
  return path.trim().replace(/^(?:\.\/|\/)+/u, '');
}

/** True when `query` contains a glob character (`*`, `?`, `[` or `{`). */
export function isGlobQuery(query: string): boolean {
  return GLOB_CHARS.test(query);
}

export type PathMatcher = ((path: string) => boolean) & { mode: 'glob' | 'substring' };

/**
 * Build a path predicate for a `find_files` query. It never throws: if picomatch rejects the
 * pattern, the matcher falls back to substring matching.
 */
export function createPathMatcher(rawQuery: string): PathMatcher {
  const query = normalizeRepoPath(String(rawQuery ?? '')).slice(0, MAX_PATH_QUERY_CHARS);
  const needle = query.toLowerCase();
  const substring = (path: string) => path.toLowerCase().includes(needle);

  if (!isGlobQuery(query)) {
    return Object.assign(substring, { mode: 'substring' as const });
  }

  let glob: ((path: string) => boolean) | undefined;
  try {
    const options = { dot: true, nocase: true, basename: !query.includes('/') };
    const patterns = query.includes('/') && !query.startsWith('**/') ? [query, `**/${query}`] : [query];
    glob = picomatch(patterns, options);
  } catch {
    glob = undefined;
  }
  if (!glob) {
    return Object.assign(substring, { mode: 'substring' as const });
  }
  const matchGlob = glob;
  return Object.assign((path: string) => matchGlob(path) || substring(path), { mode: 'glob' as const });
}

/**
 * Tool guidance for `find_files`, included in the persona and composed-engine prompts so the
 * model knows how queries are matched and what a zero-hit result means.
 */
export const FIND_FILES_TOOL_GUIDE = [
  `find_files: {"tool": "find_files", "args": {"query": "<glob or text>"}} lists file paths (any file type, including JSON/YAML fixtures) at the reviewed head.`,
  `Globs are supported: * and ? within one path segment, ** across directories, {a,b} alternatives (e.g. "tests/fixtures/**/*.json", "**/*.{yml,yaml}"); plain text matches as a case-insensitive substring of the path.`,
  `A zero-hit result is proof of absence ONLY when the result says it searched the full repository tree. If it says the search was diff-scoped, the tree was truncated, or the lookup failed, the file may still exist: do not report it as missing; call read_file on the exact path, which is conclusive.`,
].join(' ');
