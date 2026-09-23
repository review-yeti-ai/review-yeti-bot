import { classifyLockfileOrGeneratedPath } from '../pipeline/hunkFilter';
import { isSubmodulePatch } from './submodulePatch';

/**
 * REL-972: deterministic content check for a lockfile change that no lane will
 * read.
 *
 * The shared hunk filter excludes lockfiles from every lane's context, so a
 * lockfile-only diff has nothing a persona could review. Exempting it on its
 * file name alone would make a hand-edited lockfile that redirects a package to
 * an attacker-controlled tarball indistinguishable from a Dependabot bump. So a
 * lockfile change qualifies for the no-reviewable-content exemption only when
 * its own added lines show it stays on the default public registries:
 *
 * - the patch must be present (GitHub omits it for very large files, and an
 *   unread change cannot be verified);
 * - no added line may use a source protocol that bypasses the registry (git,
 *   GitHub/GitLab/Bitbucket shorthands, ssh, file/link/portal paths, exec);
 * - every URL on an added line must start with a canonical default-registry
 *   prefix;
 * - an npm/Yarn registry tarball must belong to the package whose entry it sits
 *   under, so an entry cannot be pointed at a different package on the same
 *   registry.
 *
 * Anything else is not verified, and the diff keeps the fail-closed coverage
 * outcome it always had, which requires a human look.
 */

export type LockfileVerification = { ok: true } | { ok: false; reason: string };

/** Canonical default-registry URL prefixes. A trailing `/` pins the host boundary. */
const DEFAULT_REGISTRY_PREFIXES = [
  'https://registry.npmjs.org/',
  'https://registry.yarnpkg.com/',
  'https://repo.hex.pm/',
  'sparse+https://index.crates.io/',
  'https://pypi.org/simple',
  'https://files.pythonhosted.org/',
  'https://rubygems.org/',
];

/** Exact default-registry URLs (no suffix allowed). */
const DEFAULT_REGISTRY_EXACT = new Set([
  'registry+https://github.com/rust-lang/crates.io-index',
]);

const NPM_REGISTRY_HOSTS = ['https://registry.npmjs.org/', 'https://registry.yarnpkg.com/'];

const URL_TOKEN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,;)}\]]+/giu;
const NON_REGISTRY_PROTOCOL = /(?:^|[\s"'@=(,{:])(?:git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|ssh:|file:|link:|portal:|exec:)|\bgit@[^\s:]+:/iu;

function isDefaultRegistryUrl(url: string): boolean {
  const normalized = url.replace(/[#?].*$/u, '');
  if (DEFAULT_REGISTRY_EXACT.has(normalized)) return true;
  const lower = normalized.toLowerCase();
  return DEFAULT_REGISTRY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * For an npm/Yarn registry URL: the `@scope/name` or `name` whose tarball it is,
 * or '' when the URL is on those registries but is not a plain tarball path
 * (never trusted). Null for any other registry.
 */
function npmTarballPackage(url: string): string | null {
  const host = NPM_REGISTRY_HOSTS.find((prefix) => url.toLowerCase().startsWith(prefix));
  if (!host) return null;
  const path = url.slice(host.length).replace(/[#?].*$/u, '');
  const match = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)\/-\/[\w.-]+\.tgz$/iu.exec(path);
  return match ? match[1] : '';
}

const NPM_ENTRY_HEADER = /^\s*"([^"]+)"\s*:\s*\{\s*$/u;
const NPM_SCALAR_FIELD = /^\s*"[^"]+"\s*:\s*(?:"(?:[^"\\]|\\.)*"|true|false|null|-?\d[\d.eE+-]*)\s*,?\s*$/u;
const NPM_RESOLVED_FIELD = /^\s*"resolved"\s*:\s*"[^"]*"\s*,?\s*$/u;
const NPM_METADATA_URL_FIELD = /^\s*"(?:url|funding)"\s*:\s*"[^"]*"\s*,?\s*$/u;

/** Package name(s) an npm entry key declares: the last `node_modules/` segment. */
function npmEntryNames(key: string): string[] {
  const segments = key.split('node_modules/');
  const last = segments[segments.length - 1].replace(/\/$/u, '');
  return last.length > 0 ? [last] : [];
}

/**
 * Every package a yarn.lock entry header binds, e.g.
 * `"@s/b@^1.0.0", "@s/b@^1.1.0":` or berry `"b@npm:^1.0.0":`. Yarn gives all of
 * them the entry's one resolution, so every one must name the tarball's package.
 */
function yarnEntryNames(header: string): string[] {
  return header.replace(/:\s*$/u, '').split(',').map((descriptor) => {
    const spec = descriptor.trim().replace(/^"|"$/gu, '');
    const at = spec.lastIndexOf('@');
    return at > 0 ? spec.slice(0, at) : '';
  });
}

/**
 * npm and Yarn fetch only from an entry's source field. Other URLs in an npm
 * lockfile are metadata only when they sit in a plain `url`/`funding` field;
 * any other URL, and any `resolved` that is not a plain field of its own line,
 * is refused. Every other lockfile format has every added URL checked.
 */
function yarnSourceLine(body: string): 'resolved' | 'resolution' | null {
  if (/^\s+"?resolved"?\s+"[^"]*"\s*$/u.test(body)) return 'resolved';
  if (/^\s+"?resolution"?:\s+"?[^"\s]*"?\s*$/u.test(body)) return 'resolution';
  return null;
}

function checkRegistryUrls(
  urls: readonly string[],
  entryNames: readonly string[] | null,
  checkOwner: boolean,
): LockfileVerification {
  for (const url of urls) {
    if (!isDefaultRegistryUrl(url)) {
      return { ok: false, reason: 'adds a URL outside the default public registries' };
    }
    if (!checkOwner) continue;
    const tarball = npmTarballPackage(url);
    if (tarball === null) continue;
    if (tarball === '' || !entryNames || entryNames.length === 0 || entryNames.some((name) => name !== tarball)) {
      return { ok: false, reason: 'resolves an entry to a different package' };
    }
  }
  return { ok: true };
}

export function verifyLockfileOnlyChange(path: string, patch: unknown): LockfileVerification {
  if (classifyLockfileOrGeneratedPath(path) !== 'lockfile') return { ok: false, reason: 'not a lockfile' };
  if (typeof patch !== 'string' || patch.length === 0) {
    return { ok: false, reason: 'no patch to verify' };
  }
  if (isSubmodulePatch(patch)) return { ok: false, reason: 'is a submodule gitlink' };
  const filename = path.toLowerCase().split('/').pop() || '';
  const format: 'npm' | 'yarn' | null = filename === 'package-lock.json'
    ? 'npm' : filename === 'yarn.lock' ? 'yarn' : null;

  // One forward pass over the post-image (context and added lines), tracking the
  // entry each line belongs to from structure the patch itself shows:
  // - npm: the nearest `"key": {` with only plain scalar fields between it and
  //   the line. Anything else in between (a nested object, a closing brace)
  //   means the entry is not established and a tarball there is refused, so a
  //   decoy key cannot re-parent a `resolved`.
  // - yarn: the nearest column-0 entry header, as yarn itself parses it.
  let entryNames: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) { entryNames = null; continue; }
    if (line.startsWith('-') || line.startsWith('\\')) continue;
    if (line.startsWith('+++')) continue;
    const added = line.startsWith('+');
    const body = line.slice(1);

    if (format === 'npm') {
      const header = NPM_ENTRY_HEADER.exec(body);
      const isResolved = NPM_RESOLVED_FIELD.test(body);
      if (header) entryNames = npmEntryNames(header[1]);
      else if (!NPM_SCALAR_FIELD.test(body)) entryNames = null;
      if (!added) continue;
      if (NON_REGISTRY_PROTOCOL.test(line)) return { ok: false, reason: 'adds a non-registry dependency source' };
      const urls = line.match(URL_TOKEN) ?? [];
      if (/"resolved"\s*:/u.test(body) && !isResolved) {
        return { ok: false, reason: 'adds an unrecognized source field' };
      }
      if (!isResolved) {
        if (urls.length > 0 && !NPM_METADATA_URL_FIELD.test(body)) {
          return { ok: false, reason: 'adds a URL outside a source field' };
        }
        continue;
      }
      if (urls.length === 0) return { ok: false, reason: 'resolves an entry outside a registry' };
      const checked = checkRegistryUrls(urls, entryNames, true);
      if (!checked.ok) return checked;
      continue;
    }

    if (format === 'yarn') {
      if (body.length > 0 && !/^\s/u.test(body) && !body.startsWith('#')) entryNames = yarnEntryNames(body);
      if (!added) continue;
      if (NON_REGISTRY_PROTOCOL.test(line)) return { ok: false, reason: 'adds a non-registry dependency source' };
      const urls = line.match(URL_TOKEN) ?? [];
      const source = yarnSourceLine(body);
      if (source === null) {
        if (urls.length > 0) return { ok: false, reason: 'adds a URL outside a source field' };
        continue;
      }
      if (source === 'resolved' && urls.length === 0) {
        return { ok: false, reason: 'resolves an entry outside a registry' };
      }
      const checked = checkRegistryUrls(urls, entryNames, true);
      if (!checked.ok) return checked;
      continue;
    }

    if (!added) continue;
    if (NON_REGISTRY_PROTOCOL.test(line)) return { ok: false, reason: 'adds a non-registry dependency source' };
    const checked = checkRegistryUrls(line.match(URL_TOKEN) ?? [], null, false);
    if (!checked.ok) return checked;
  }
  return { ok: true };
}
