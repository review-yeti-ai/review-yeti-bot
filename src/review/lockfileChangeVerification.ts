import { classifyLockfileOrGeneratedPath } from '../pipeline/hunkFilter';
import { isSubmodulePatch } from './submodulePatch';

/**
 * REL-972: deterministic content check for a lockfile change that no lane will
 * read.
 *
 * The shared hunk filter excludes lockfiles from every lane's context, so a
 * lockfile-only diff has nothing a persona could review. Exempting it on its
 * file name alone would make a hand-edited lockfile that redirects a package to
 * an attacker-controlled artifact indistinguishable from a Dependabot bump. So a
 * lockfile change qualifies for the no-reviewable-content exemption only when
 * its own added lines show every entry still resolves to its own package on the
 * default public registry:
 *
 * - the patch must be present (GitHub omits it for very large files, and an
 *   unread change cannot be verified);
 * - no added line may use a source protocol that bypasses the registry (git,
 *   GitHub/GitLab/Bitbucket shorthands, ssh, file/link/portal paths, exec);
 * - package-lock.json / yarn.lock (v1): every added source is an npm/Yarn
 *   registry tarball of the very package its entry declares, the entry being
 *   established from structure the patch shows;
 * - yarn.lock (berry): every added `resolution` is `<entry package>@npm:<version>`
 *   or Yarn's built-in compatibility patch of that same npm package;
 * - Cargo.lock / poetry.lock / mix.lock: the only URLs an added line may carry
 *   are the default registry index URLs themselves (those formats record
 *   per-package artifact URLs only for non-default sources);
 * - no change may add a new package entry: every added entry header must
 *   replace an identical removed one, so a bump can move an existing package
 *   to a new registry version but cannot introduce a package;
 * - the change must add something (a pure deletion is not a version bump),
 *   and no added line may carry an escape sequence, since the lockfile's parser
 *   would decode what these text checks would miss;
 * - any other lockfile format (pnpm, go.sum, Gemfile.lock, composer, Pipfile)
 *   is not verified.
 *
 * Anything else is not verified, and the diff keeps the fail-closed coverage
 * outcome it always had, which requires a human look.
 */

export type LockfileVerification = { ok: true } | { ok: false; reason: string };

const NPM_TARBALL_HOSTS = ['https://registry.npmjs.org/', 'https://registry.yarnpkg.com/'];

/** Default registry index URLs a non-npm lockfile may name (exact, case-sensitive). */
const REGISTRY_INDEX_URLS = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
  'sparse+https://index.crates.io/',
  'https://pypi.org/simple',
  'https://pypi.org/simple/',
  'https://rubygems.org',
  'https://rubygems.org/',
]);

const URL_TOKEN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;)}\]]+/giu;
const NON_REGISTRY_PROTOCOL = /(?:^|[\s"'@=(,{:])(?:git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|ssh:|file:|link:|portal:|exec:)|\bgit@[^\s:]+:/iu;

const NPM_ENTRY_HEADER = /^\s*"([^"]+)"\s*:\s*\{\s*$/u;
const NPM_SCALAR_FIELD = /^\s*"[^"]+"\s*:\s*(?:"(?:[^"\\]|\\.)*"|true|false|null|-?\d[\d.eE+-]*)\s*,?\s*$/u;
const NPM_RESOLVED_FIELD = /^\s*"resolved"\s*:\s*"[^"]*"\s*,?\s*$/u;
const NPM_METADATA_URL_FIELD = /^\s*"(?:url|funding)"\s*:\s*"[^"]*"\s*,?\s*$/u;

const YARN_RESOLVED_FIELD = /^\s+"?resolved"?\s+"[^"]*"\s*$/u;
const YARN_RESOLUTION_FIELD = /^\s+"?resolution"?:\s+"?([^"\s]*)"?\s*$/u;
const YARN_NPM_VERSION = /^npm:[\w.+-]+$/u;
const YARN_BUILTIN_PATCH = /^patch:(.+?)@npm%3A[\w.+-]+#(?:~|optional!)builtin<compat\/[a-z0-9-]+>(?:::[\w.=&-]*)?$/u;

/** Git mode headers naming anything but a regular file (symlink 120000, gitlink 160000, ...). */
const NON_REGULAR_MODE = /^(?:index [0-9a-f]+\.\.[0-9a-f]+|(?:new|deleted) file mode|old mode|new mode) (?!100644\b|100755\b)\d+/imu;

/** A changed file's git mode, when known, is a regular file's. */
export function isRegularFileMode(mode: unknown): boolean {
  return mode === undefined || mode === null || mode === '' || mode === '100644' || mode === '100755';
}

/**
 * Line shapes each format's serializer writes. An added line of any other
 * shape (a symlink target, hand-written text) is not a lockfile edit this
 * check understands.
 */
const LINE_SHAPES: Record<string, readonly RegExp[]> = {
  npm: [
    /^\s*$/u,
    /^\s*"[^"]+"\s*:\s*\{\s*$/u,
    /^\s*"[^"]+"\s*:\s*(?:"(?:[^"\\]|\\.)*"|true|false|null|-?\d[\d.eE+-]*|\{\}|\[\])\s*,?\s*$/u,
    /^\s*"[^"]+"\s*:\s*\[\s*$/u,
    /^\s*"(?:[^"\\]|\\.)*"\s*,?\s*$/u,
    /^\s*[{}\]],?\s*$/u,
  ],
  yarn: [/^\s*$/u, /^#/u, /^\S.*:$/u, /^\s+\S/u],
  mix: [/^\s*$/u, /^%\{\s*$/u, /^\}\s*$/u, /^\s*"[^"]+"\s*:\s*\{:[a-z_]+,.*\},?\s*$/u],
  toml: [/^\s*$/u, /^#/u, /^\[\[?[\w.-]+\]\]?\s*$/u, /^[\w.-]+\s*=\s*\S.*$/u, /^\s+\S.*$/u, /^\],?\s*$/u],
};

const refuse = (reason: string): LockfileVerification => ({ ok: false, reason });
const OK: LockfileVerification = { ok: true };

/** The package named by a descriptor or locator: `@s/b@...` -> `@s/b`, `b@...` -> `b`. */
function descriptorPackage(descriptor: string): string {
  const at = descriptor.indexOf('@', 1);
  return at > 0 ? descriptor.slice(0, at) : '';
}

/**
 * For an npm/Yarn registry tarball URL: the `@scope/name` or `name` it belongs
 * to; '' for any other URL (never trusted as an npm source).
 */
function npmTarballPackage(url: string): string {
  const host = NPM_TARBALL_HOSTS.find((prefix) => url.toLowerCase().startsWith(prefix));
  if (!host) return '';
  const path = url.slice(host.length).replace(/#.*$/u, '');
  const match = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)\/-\/[\w.-]+\.tgz$/iu.exec(path);
  return match ? match[1] : '';
}

/** Package name an npm entry key declares: the last `node_modules/` segment. */
function npmEntryNames(key: string): string[] {
  const segments = key.split('node_modules/');
  const last = segments[segments.length - 1].replace(/\/$/u, '');
  return last.length > 0 ? [last] : [];
}

/**
 * Every package a yarn.lock entry header binds, e.g. `"@s/b@^1.0.0", "@s/b@^1.1.0":`
 * or berry `"b@npm:^1.0.0, b@npm:^1.1.0":`. Yarn gives all of them the entry's one
 * resolution, so every one must name the resolved package.
 */
function yarnEntryNames(header: string): string[] {
  return header.replace(/:\s*$/u, '').split(',')
    .map((descriptor) => descriptorPackage(descriptor.trim().replace(/^"|"$/gu, '')));
}

/** The entry is established and every name it binds is exactly `pkg`. */
function entryIs(entryNames: readonly string[] | null, pkg: string): boolean {
  return pkg.length > 0 && entryNames !== null && entryNames.length > 0 && entryNames.every((name) => name === pkg);
}

function npmTarballFor(urls: readonly string[], entryNames: readonly string[] | null): LockfileVerification {
  if (urls.length === 0) return refuse('resolves an entry outside a registry');
  for (const url of urls) {
    const pkg = npmTarballPackage(url);
    if (pkg === '') return refuse('adds a URL outside the default public registries');
    if (!entryIs(entryNames, pkg)) return refuse('resolves an entry to a different package');
  }
  return OK;
}

interface EntryState { entry: string[] | null }

function verifyNpmLine(body: string, added: boolean, state: EntryState): LockfileVerification {
  const header = NPM_ENTRY_HEADER.exec(body);
  // Only plain scalar fields may sit between an entry key and its `resolved`;
  // anything else (a nested object, a closing brace) leaves the entry
  // unestablished, so a decoy key cannot re-parent a `resolved`.
  if (header) state.entry = npmEntryNames(header[1]);
  else if (!NPM_SCALAR_FIELD.test(body)) state.entry = null;
  if (!added) return OK;
  const urls = body.match(URL_TOKEN) ?? [];
  if (NPM_RESOLVED_FIELD.test(body)) return npmTarballFor(urls, state.entry);
  if (/"resolved"\s*:/u.test(body)) return refuse('adds an unrecognized source field');
  if (urls.length > 0 && !NPM_METADATA_URL_FIELD.test(body)) return refuse('adds a URL outside a source field');
  return OK;
}

function verifyYarnLine(body: string, added: boolean, state: EntryState): LockfileVerification {
  // Yarn binds every indented field to the nearest column-0 entry header.
  if (body.length > 0 && !/^\s/u.test(body) && !body.startsWith('#')) state.entry = yarnEntryNames(body);
  if (!added) return OK;
  const urls = body.match(URL_TOKEN) ?? [];
  if (YARN_RESOLVED_FIELD.test(body)) return npmTarballFor(urls, state.entry);
  const resolution = YARN_RESOLUTION_FIELD.exec(body);
  if (resolution) {
    const locator = resolution[1];
    const pkg = descriptorPackage(locator);
    const reference = locator.slice(pkg.length + 1);
    const patched = YARN_BUILTIN_PATCH.exec(reference);
    if (!YARN_NPM_VERSION.test(reference) && !(patched && patched[1] === pkg)) {
      return refuse('resolves an entry outside the npm registry');
    }
    return entryIs(state.entry, pkg) ? OK : refuse('resolves an entry to a different package');
  }
  if (/^\s+"?(?:resolved|resolution)"?\b/u.test(body)) return refuse('adds an unrecognized source field');
  if (urls.length > 0) return refuse('adds a URL outside a source field');
  return OK;
}

function verifyIndexOnlyLine(body: string, added: boolean): LockfileVerification {
  if (!added) return OK;
  for (const url of body.match(URL_TOKEN) ?? []) {
    if (!REGISTRY_INDEX_URLS.has(url)) return refuse('adds a URL outside the default public registries');
  }
  return OK;
}

/** Object-valued fields inside an npm lockfile entry; any other `"key": {` is an entry. */
const NPM_OBJECT_FIELDS = new Set([
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'requires', 'engines', 'funding', 'bin',
]);

type LockfileFormat = 'npm' | 'yarn' | 'toml' | 'mix';

const FORMATS: Record<string, LockfileFormat> = {
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'cargo.lock': 'toml',
  'poetry.lock': 'toml',
  'mix.lock': 'mix',
};

/** The line, if it opens a package entry in this format (compared verbatim). */
function entryHeader(body: string, format: LockfileFormat): string | null {
  if (format === 'npm') {
    const header = NPM_ENTRY_HEADER.exec(body);
    return header && !NPM_OBJECT_FIELDS.has(header[1]) ? body.trim() : null;
  }
  if (format === 'yarn') return body.length > 0 && !/^\s/u.test(body) && !body.startsWith('#') ? body.trim() : null;
  if (format === 'toml') return /^name\s*=/u.test(body) ? body.trim() : null;
  const mix = /^\s*("[^"]+")\s*:/u.exec(body);
  return mix ? mix[1] : null;
}

export function verifyLockfileOnlyChange(path: string, patch: unknown): LockfileVerification {
  if (classifyLockfileOrGeneratedPath(path) !== 'lockfile') return refuse('not a lockfile');
  if (typeof patch !== 'string' || patch.length === 0) return refuse('no patch to verify');
  if (isSubmodulePatch(patch)) return refuse('is a submodule gitlink');
  if (NON_REGULAR_MODE.test(patch)) return refuse('is not a regular file');
  const format = FORMATS[path.toLowerCase().split('/').pop() || ''];
  if (!format) return refuse('lockfile format not verifiable');
  const verifyLine: (body: string, added: boolean, state: EntryState) => LockfileVerification =
    format === 'npm' ? verifyNpmLine : format === 'yarn' ? verifyYarnLine : verifyIndexOnlyLine;

  const lines = patch.split('\n');
  // Entry headers the change removes; each may be re-added once (a rewritten
  // entry), but no added header may introduce a package the lockfile lacked.
  const removedHeaders = new Map<string, number>();
  for (const line of lines) {
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const header = entryHeader(line.slice(1), format);
    if (header !== null) removedHeaders.set(header, (removedHeaders.get(header) ?? 0) + 1);
  }

  // One forward pass over the post-image (context and added lines), tracking the
  // entry each line belongs to. Linear in patch size.
  const state: EntryState = { entry: null };
  let addedCount = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) { state.entry = null; continue; }
    if (line.startsWith('-') || line.startsWith('\\') || line.startsWith('+++')) continue;
    const added = line.startsWith('+');
    if (added) {
      addedCount += 1;
      if (line.includes('\\')) return refuse('adds an escape sequence');
      if (!LINE_SHAPES[format].some((shape) => shape.test(line.slice(1)))) return refuse('adds a line that is not lockfile content');
      if (NON_REGISTRY_PROTOCOL.test(line)) return refuse('adds a non-registry dependency source');
      const header = entryHeader(line.slice(1), format);
      if (header !== null) {
        const remaining = removedHeaders.get(header) ?? 0;
        if (remaining === 0) return refuse('adds a new package entry');
        removedHeaders.set(header, remaining - 1);
      }
    }
    const verdict = verifyLine(line.slice(1), added, state);
    if (!verdict.ok) return verdict;
  }
  if (addedCount === 0) return refuse('only removes lockfile content');
  return OK;
}
