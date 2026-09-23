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

/**
 * The package the entry enclosing `lines[index]` declares, from the new side of
 * the hunk (context and added lines). package-lock.json: `"node_modules/a/node_modules/@s/b": {`
 * or v1 `"b": {`. yarn.lock v1: `"@s/b@^1.0.0", "@s/b@^1.1.0":` at column 0.
 */
function enclosingPackageName(lines: readonly string[], index: number, kind: 'npm' | 'yarn'): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.startsWith('@@')) return null;
    if (line.startsWith('-')) continue;
    const body = line.slice(1);
    if (kind === 'npm') {
      const match = /^\s*"([^"]+)":\s*\{\s*$/u.exec(body);
      if (!match) continue;
      const key = match[1];
      const segments = key.split('node_modules/');
      const last = segments[segments.length - 1].replace(/\/$/u, '');
      return last.length > 0 ? last : null;
    }
    if (/^\s/u.test(body) || body.length === 0 || body.startsWith('#')) continue;
    const spec = body.split(',')[0].trim().replace(/^"|"$/gu, '').replace(/:$/u, '').replace(/"$/u, '');
    const at = spec.lastIndexOf('@');
    return at > 0 ? spec.slice(0, at) : null;
  }
  return null;
}

/**
 * npm and Yarn fetch only from an entry's source field; other URLs in their
 * lockfiles (`funding`, ...) are metadata. Every other lockfile format has every
 * URL checked.
 */
function sourceLine(body: string, format: 'npm' | 'yarn'): 'resolved' | 'resolution' | null {
  if (format === 'npm') return /^\s*"resolved"\s*:/u.test(body) ? 'resolved' : null;
  if (/^\s+"?resolved"?\s/u.test(body)) return 'resolved';
  if (/^\s+"?resolution"?:\s/u.test(body)) return 'resolution';
  return null;
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
  const lines = patch.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (NON_REGISTRY_PROTOCOL.test(line)) {
      return { ok: false, reason: 'adds a non-registry dependency source' };
    }
    const urls = line.match(URL_TOKEN) ?? [];
    const source = format ? sourceLine(line.slice(1), format) : null;
    if (format && source === null) continue;
    if (source === 'resolved' && urls.length === 0) {
      return { ok: false, reason: 'resolves an entry outside a registry' };
    }
    for (const url of urls) {
      if (!isDefaultRegistryUrl(url)) {
        return { ok: false, reason: 'adds a URL outside the default public registries' };
      }
      if (format) {
        const tarball = npmTarballPackage(url);
        if (tarball !== null && (tarball === '' || enclosingPackageName(lines, index, format) !== tarball)) {
          return { ok: false, reason: 'resolves an entry to a different package' };
        }
      }
    }
  }
  return { ok: true };
}
