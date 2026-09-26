import { classifyLockfileOrGeneratedPath } from '../pipeline/hunkFilter';

/**
 * REL-1141: a deterministic, complete summary of the package changes in a
 * dependency lockfile patch, for a lockfile too large for a lane to read whole.
 *
 * calltelemetry/openclaw-linear-plugin#30 (Dependabot) changed package.json by
 * one line and package-lock.json by 41,140 characters, adding four new
 * packages. The patch was over the per-file cap, so the new-package routing
 * (REL-1136) did not apply, the shared filter hid the lockfile from every
 * lane, and the run shipped claiming every change was sent in full.
 *
 * Instead of the raw patch the lanes now receive this summary: every package
 * entry the change adds, removes or re-versions (`name@version`), extracted
 * from the whole patch. It is built only for formats this module can read
 * structurally -- package-lock.json / npm-shrinkwrap-style JSON and yarn.lock
 * (v1 and berry) -- and it refuses rather than guess:
 *
 * - every added or removed `version` line must belong to an entry whose header
 *   the patch shows (npm: by indentation, since npm writes two-space JSON;
 *   yarn: the nearest column-0 entry header), and every added or removed entry
 *   must show its version;
 * - any other format (pnpm-lock.yaml, go.sum, Gemfile.lock, ...) is refused.
 *
 * Changed lines that are neither an entry header nor a `version` line
 * (dependency ranges, integrity, metadata) are attributed to their entry when
 * its header is visible, and counted otherwise, so nothing in the patch goes
 * unmentioned. A refusal makes the caller fail closed (coverage incomplete).
 */

export type LockfileChangeSummary =
  | { ok: true; text: string; packageChanges: number }
  | { ok: false; reason: string };

type Side = 'old' | 'new';

interface EntryRef {
  /** Package name the entry resolves (npm: the last node_modules/ segment). */
  name: string;
  /** Unique id of this header occurrence on its side. */
  instance: number;
}

interface Collected {
  /** Versions of entries on each side: header instance -> version. */
  instanceVersion: Map<string, string>;
  /** Changed headers: [side, instance key, name]. */
  changedHeaders: Array<{ side: Side; key: string; name: string }>;
  /** Changed version lines: [side, name, version]. */
  changedVersions: Array<{ side: Side; name: string; version: string }>;
  /** Package names with some other changed line inside their entry. */
  touched: Set<string>;
  /** Changed lines that belong to no visible entry. */
  unattributed: number;
}

const refuse = (reason: string): LockfileChangeSummary => ({ ok: false, reason });

const NPM_HEADER = /^(\s*)"((?:[^"\\]|\\.)*)"\s*:\s*\{\s*$/u;
const NPM_CLOSE = /^(\s*)[}\]],?\s*$/u;
const NPM_KEY = /^(\s*)"(?:[^"\\]|\\.)*"\s*:/u;
const NPM_VERSION = /^(\s*)"version"\s*:\s*"([^"]*)"\s*,?\s*$/u;
/** Object-valued fields inside an npm entry whose children are NOT package entries. */
const NPM_NON_ENTRY_PARENTS = new Set([
  'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
  'requires', 'engines', 'funding', 'bin', 'workspaces', 'overrides',
]);
/** Object-valued fields that are never themselves package entries. */
const NPM_OBJECT_FIELDS = new Set([...NPM_NON_ENTRY_PARENTS, 'dependencies', 'packages']);
const ROOT = '(root project)';

function npmNameOfKey(key: string): string {
  if (key === '') return ROOT;
  const segments = key.split('node_modules/');
  return segments[segments.length - 1].replace(/\/$/u, '') || key;
}

function indentOf(match: RegExpExecArray): number {
  return match[1].length;
}

/**
 * npm lockfiles: JSON with two-space indentation. Structure is tracked per
 * side (context + removed lines = old, context + added lines = new) with an
 * indentation stack of open object keys, reset at every hunk.
 */
function collectNpm(lines: readonly string[]): Collected | string {
  const out: Collected = { instanceVersion: new Map(), changedHeaders: [], changedVersions: [], touched: new Set(), unattributed: 0 };
  const stacks: Record<Side, Map<number, { key: string; ref: EntryRef | null }>> = { old: new Map(), new: new Map() };
  let instances = 0;
  const clearFrom = (stack: Map<number, unknown>, indent: number) => {
    for (const level of [...stack.keys()]) if (level >= indent) stack.delete(level);
  };
  const entryAbove = (stack: Map<number, { key: string; ref: EntryRef | null }>, indent: number): EntryRef | null => {
    for (let level = indent - 2; level >= 0; level -= 2) {
      const open = stack.get(level);
      if (open?.ref) return open.ref;
    }
    return null;
  };
  for (const line of lines) {
    if (line.startsWith('@@')) { stacks.old.clear(); stacks.new.clear(); continue; }
    if (line.startsWith('\\') || line.startsWith('+++') || line.startsWith('---')) continue;
    const marker = line[0];
    if (marker !== ' ' && marker !== '+' && marker !== '-' && line.length > 0) continue;
    const body = line.slice(1);
    const sides: Side[] = marker === '+' ? ['new'] : marker === '-' ? ['old'] : ['old', 'new'];
    const changed = marker === '+' || marker === '-';
    for (const side of sides) {
      const stack = stacks[side];
      const header = NPM_HEADER.exec(body);
      if (header) {
        const indent = indentOf(header);
        const key = header[2];
        const parent = stack.get(indent - 2);
        const isEntry = !NPM_OBJECT_FIELDS.has(key) && !(parent && NPM_NON_ENTRY_PARENTS.has(parent.key))
          && !(indent === 2 && key !== '');
        clearFrom(stack, indent);
        const ref = isEntry ? { name: npmNameOfKey(key), instance: (instances += 1) } : null;
        stack.set(indent, { key, ref });
        if (changed) {
          if (ref) out.changedHeaders.push({ side, key: `${side}:${ref.instance}`, name: ref.name });
          else {
            const owner = entryAbove(stack, indent);
            if (owner) out.touched.add(owner.name); else out.unattributed += 1;
          }
        }
        continue;
      }
      const close = NPM_CLOSE.exec(body);
      if (close) {
        // The brace closes the object opened at its own indentation.
        const indent = indentOf(close);
        const owner = stack.get(indent)?.ref ?? entryAbove(stack, indent);
        clearFrom(stack, indent);
        if (changed) { if (owner) out.touched.add(owner.name); else out.unattributed += 1; }
        continue;
      }
      // A scalar field at indentation i ends every object opened at i or deeper.
      const keyLine = NPM_KEY.exec(body);
      if (keyLine) clearFrom(stack, indentOf(keyLine));
      const version = NPM_VERSION.exec(body);
      if (version) {
        const indent = indentOf(version);
        const parent = stack.get(indent - 2);
        if (parent?.ref) {
          out.instanceVersion.set(`${side}:${parent.ref.instance}`, version[2]);
          if (changed) out.changedVersions.push({ side, name: parent.ref.name, version: version[2] });
          continue;
        }
        if (indent === 2 && !parent) {
          // The lockfile's own top-level "version" (the project's).
          if (changed) out.changedVersions.push({ side, name: ROOT, version: version[2] });
          continue;
        }
        if (parent && NPM_NON_ENTRY_PARENTS.has(parent.key)) {
          // A dependency literally named "version" inside a range map.
          const owner = entryAbove(stack, indent);
          if (changed) { if (owner) out.touched.add(owner.name); else out.unattributed += 1; }
          continue;
        }
        if (changed) return 'changes a package version whose entry the patch does not show';
        continue;
      }
      if (changed && body.trim().length > 0) {
        const indent = /^\s*/u.exec(body)![0].length;
        const owner = entryAbove(stack, indent);
        if (owner) out.touched.add(owner.name); else out.unattributed += 1;
      }
    }
  }
  return out;
}

const YARN_VERSION = /^ {2}"?version"?:?\s+"?([^"\s]+)"?\s*$/u;

function yarnHeaderNames(header: string): string[] {
  return [...new Set(header.replace(/:\s*$/u, '').split(',').map((descriptor) => {
    const trimmed = descriptor.trim().replace(/^"|"$/gu, '');
    const at = trimmed.indexOf('@', 1);
    return at > 0 ? trimmed.slice(0, at) : '';
  }))];
}

/** yarn.lock (v1 and berry): every indented line belongs to the nearest column-0 entry header. */
function collectYarn(lines: readonly string[]): Collected | string {
  const out: Collected = { instanceVersion: new Map(), changedHeaders: [], changedVersions: [], touched: new Set(), unattributed: 0 };
  const current: Record<Side, EntryRef | null | 'meta'> = { old: null, new: null };
  let instances = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) { current.old = null; current.new = null; continue; }
    if (line.startsWith('\\') || line.startsWith('+++') || line.startsWith('---')) continue;
    const marker = line[0];
    if (marker !== ' ' && marker !== '+' && marker !== '-' && line.length > 0) continue;
    const body = line.slice(1);
    const sides: Side[] = marker === '+' ? ['new'] : marker === '-' ? ['old'] : ['old', 'new'];
    const changed = marker === '+' || marker === '-';
    for (const side of sides) {
      if (body.trim().length === 0) continue;
      if (body.startsWith('#')) { if (changed) out.unattributed += 1; continue; }
      if (!/^\s/u.test(body)) {
        if (/^"?__metadata"?:\s*$/u.test(body)) {
          current[side] = 'meta';
          if (changed) out.unattributed += 1;
          continue;
        }
        const names = yarnHeaderNames(body);
        if (names.length !== 1 || names[0] === '') return 'changes an entry header whose package cannot be read';
        const ref = { name: names[0], instance: (instances += 1) };
        current[side] = ref;
        if (changed) out.changedHeaders.push({ side, key: `${side}:${ref.instance}`, name: ref.name });
        continue;
      }
      const entry = current[side];
      const version = YARN_VERSION.exec(body);
      if (version && entry !== 'meta') {
        if (entry === null) {
          if (changed) return 'changes a package version whose entry the patch does not show';
          continue;
        }
        out.instanceVersion.set(`${side}:${entry.instance}`, version[1]);
        if (changed) out.changedVersions.push({ side, name: entry.name, version: version[1] });
        continue;
      }
      if (!changed) continue;
      if (entry && entry !== 'meta') out.touched.add(entry.name); else out.unattributed += 1;
    }
  }
  return out;
}

const FORMATS: Record<string, (lines: readonly string[]) => Collected | string> = {
  'package-lock.json': collectNpm,
  'npm-shrinkwrap.json': collectNpm,
  'yarn.lock': collectYarn,
};

/** The lockfile formats this module can summarize (by file name). */
export function isSummarizableLockfilePath(path: string): boolean {
  return Object.hasOwn(FORMATS, (path.toLowerCase().split('/').pop() || ''));
}

const sortVersions = (versions: Iterable<string>) => [...new Set(versions)].sort();

/**
 * The complete package-change summary of one lockfile patch, or why it cannot
 * be built. Deterministic: the same patch always yields the same text.
 */
export function summarizeLockfileChange(path: string, patch: unknown, originalChars?: number): LockfileChangeSummary {
  if (classifyLockfileOrGeneratedPath(path) !== 'lockfile' && !isSummarizableLockfilePath(path)) return refuse('not a lockfile');
  const collect = FORMATS[path.toLowerCase().split('/').pop() || ''];
  if (!collect) return refuse('lockfile format cannot be summarized');
  if (typeof patch !== 'string' || patch.length === 0) return refuse('no patch to summarize');
  if (!patch.split('\n').some((line) => line.startsWith('@@'))) return refuse('patch has no hunks to summarize');
  const collected = collect(patch.split('\n'));
  if (typeof collected === 'string') return refuse(collected);

  const oldVersions = new Map<string, string[]>();
  const newVersions = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, name: string, version: string) => {
    const list = map.get(name);
    if (list) list.push(version); else map.set(name, [version]);
  };
  for (const header of collected.changedHeaders) {
    const version = collected.instanceVersion.get(header.key);
    if (version === undefined) return refuse(`${header.side === 'new' ? 'adds' : 'removes'} an entry whose version the patch does not show`);
    push(header.side === 'old' ? oldVersions : newVersions, header.name, version);
  }
  for (const change of collected.changedVersions) push(change.side === 'old' ? oldVersions : newVersions, change.name, change.version);

  const names = [...new Set([...oldVersions.keys(), ...newVersions.keys(), ...collected.touched])].sort();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  const fieldsOnly: string[] = [];
  for (const name of names) {
    const before = sortVersions(oldVersions.get(name) ?? []);
    const after = sortVersions(newVersions.get(name) ?? []);
    if (before.length === 0 && after.length === 0) fieldsOnly.push(name);
    else if (before.length === 0) added.push(...after.map((version) => `${name}@${version}`));
    else if (after.length === 0) removed.push(...before.map((version) => `${name}@${version}`));
    else if (before.join(' ') === after.join(' ')) fieldsOnly.push(`${name}@${after.join(', ')}`);
    else changed.push(`${name}: ${before.join(', ')} -> ${after.join(', ')}`);
  }
  const size = typeof originalChars === 'number' && Number.isSafeInteger(originalChars) ? originalChars : patch.length;
  const section = (title: string, rows: readonly string[]) => (rows.length === 0 ? [] : [`${title} (${rows.length}):`, ...rows.map((row) => `  ${row}`)]);
  const text = [
    `Review Yeti: summarized oversized lockfile ${path} (patch of ${size.toLocaleString('en-US')} characters; lanes receive this summary, not the patch).`,
    'Every package entry the change adds, removes or re-versions, extracted deterministically from the whole patch.',
    ...section('Added packages', added),
    ...section('Removed packages', removed),
    ...section('Changed versions', changed),
    ...section('Entries with other field changes only (dependency ranges, integrity, metadata)', fieldsOnly),
    ...(collected.unattributed > 0
      ? [`Changed lines outside any entry header the patch shows (dependency ranges or lockfile metadata): ${collected.unattributed}.`] : []),
    ...(added.length + removed.length + changed.length === 0 ? ['No package entry was added, removed or re-versioned.'] : []),
  ].join('\n');
  return { ok: true, text: `${text}\n`, packageChanges: added.length + removed.length + changed.length };
}
