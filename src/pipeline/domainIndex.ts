/**
 * Master Domain Index — loader, schema validation, and file→persona resolution
 * Location: src/pipeline/domainIndex.ts
 *
 * Purely additive infrastructure for REL-551. Nothing in the review pipeline consumes this module
 * yet; a follow-up wires `resolveFileDomains` into persona/file routing. This module only builds
 * and reads the index and exposes the resolution primitive so that follow-up can be a small,
 * reviewable diff.
 *
 * Two layers, both community-extensible without anyone needing to reason about personas:
 *
 *   Layer 1 — domains/ecosystems/<ecosystem>.json
 *     One file per ecosystem (elixir, javascript-typescript, python, ...). Maps a fixed 14-value
 *     class vocabulary (CLASS_VOCABULARY below) to glob patterns for that ecosystem's files.
 *
 *   Layer 2 — domains/classes.json
 *     A curated matrix mapping every one of the 14 classes to the built-in reviewer persona ids
 *     (PERSONA_CHARTERS in .github/workflows/pipelines/review-pipeline.js). Contributors adding an
 *     ecosystem never touch this file — see domains/CONTRIBUTING.md.
 *
 * domains/compiled-index.json is the deterministic merge of both layers (scripts/build-domain-index.mjs
 * builds and `--check`-validates it as part of `npm test`'s `test:artifacts` pretest chain).
 *
 * Glob semantics are ported exactly from the reference Python implementation at
 * ct-meta/plugins/ct-workflow/skills/ct-review/scripts/ct_review/glob.py (git/CodeRabbit-style, NOT
 * Node minimatch/picomatch defaults):
 *   **      matches any number of path segments INCLUDING zero
 *   *       matches within one segment (does NOT cross `/`)
 *   ?       one non-`/` char
 *   {a,b,c} brace alternation; empty/blank alternatives are ignored
 *
 * Schema validation here interprets exactly the JSON Schema keyword subset used by
 * domains/index-schema.json: type, required, properties, additionalProperties, propertyNames,
 * items, enum, minLength, minItems, minProperties, and local `$ref`. It is not a general-purpose
 * JSON Schema engine — see the note at the top of index-schema.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/** The fixed, 14-value class vocabulary. Keep in sync with domains/index-schema.json. */
export const CLASS_VOCABULARY = [
  'source',
  'test',
  'docs',
  'deps-manifest',
  'lockfile',
  'ci',
  'infra',
  'database',
  'config',
  'ui-styles',
  'i18n',
  'license',
  'scripts',
  'assets',
] as const;

export type DomainClass = (typeof CLASS_VOCABULARY)[number];

/**
 * The 12 built-in reviewer persona ids. Mirrors `PERSONA_CHARTERS` ids in
 * `.github/workflows/pipelines/review-pipeline.js`. Kept as a local literal (rather than requiring
 * the CommonJS pipeline module from this TS file) to avoid a load-order dependency; a drift guard
 * test cross-checks this list against the live PERSONA_CHARTERS export.
 */
export const PERSONA_VOCABULARY = [
  'security',
  'performance',
  'architecture',
  'style',
  'testing',
  'documentation',
  'accessibility',
  'database',
  'devops',
  'i18n',
  'dependencies',
  'licensing',
] as const;

export type PersonaId = (typeof PERSONA_VOCABULARY)[number];

const CLASS_SET = new Set<string>(CLASS_VOCABULARY);
const PERSONA_SET = new Set<string>(PERSONA_VOCABULARY);

// ---------------------------------------------------------------------------------------------
// File shapes
// ---------------------------------------------------------------------------------------------

export interface EcosystemFile {
  ecosystem: string;
  description: string;
  classes: Record<string, string[]>;
}

export type ClassesFile = Record<string, string[]>;

export interface CompiledDomainIndex {
  schemaVersion: string;
  classVocabulary: string[];
  personaVocabulary: string[];
  classes: Record<string, string[]>;
  ecosystems: Record<string, { description: string; classes: Record<string, string[]> }>;
  indexDigest: string;
}

export interface DomainResolution {
  /** True when at least one ecosystem glob matched the path, whether or not any class carried personas. */
  matched: boolean;
  /** Union of every matched class, sorted. */
  classes: string[];
  /** Union of every persona reachable from a matched class, sorted. Legitimately empty even when matched. */
  personas: string[];
}

const SCHEMA_VERSION = 'domain-index-v1';

// ---------------------------------------------------------------------------------------------
// Glob → regex (ported from ct_review/glob.py — see module docstring)
// ---------------------------------------------------------------------------------------------

const GLOB_REGEX_CACHE = new Map<string, RegExp>();

/** Ported 1:1 from `glob_to_regex` in the reference Python implementation. */
export function globToRegex(glob: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(glob);
  if (cached) return cached;

  let i = 0;
  const n = glob.length;
  const out: string[] = ['^'];

  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  while (i < n) {
    const c = glob[i];
    if (c === '*') {
      if (glob.slice(i, i + 2) === '**') {
        const j = i + 2;
        if (glob.slice(j, j + 1) === '/') {
          // `**/` -> zero-or-more segments
          out.push('(?:.*/)?');
          i = j + 1;
          continue;
        }
        out.push('.*'); // trailing `**`
        i = j;
        continue;
      }
      out.push('[^/]*'); // single `*`
      i += 1;
      continue;
    }
    if (c === '?') {
      out.push('[^/]');
      i += 1;
      continue;
    }
    if (c === '{') {
      const j = glob.indexOf('}', i);
      if (j !== -1) {
        const opts = glob
          .slice(i + 1, j)
          .split(',')
          .map((o) => o.trim())
          .filter((o) => o.length > 0);
        if (opts.length > 0) {
          out.push('(?:' + opts.map(escapeRegExp).join('|') + ')');
        }
        i = j + 1;
        continue;
      }
      // no closing brace -> treat '{' literally
    }
    out.push(escapeRegExp(c));
    i += 1;
  }
  out.push('$');

  const regex = new RegExp(out.join(''));
  GLOB_REGEX_CACHE.set(glob, regex);
  return regex;
}

export function matchOne(glob: string, filePath: string): boolean {
  return globToRegex(glob).test(filePath);
}

// ---------------------------------------------------------------------------------------------
// Minimal JSON Schema (subset) interpreter — see module docstring for supported keywords
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchema = any;

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  const parts = ref.replace(/^#\//, '').split('/');
  let node = root;
  for (const part of parts) {
    node = node?.[part];
  }
  if (node === undefined) {
    throw new Error(`domainIndex schema: unresolved $ref "${ref}"`);
  }
  return node;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/**
 * Validates `value` against `schema`, resolving local `$ref`s against `root`. Returns a list of
 * human-readable error strings (empty = valid). Supports exactly the keywords used by
 * domains/index-schema.json: type, required, properties, additionalProperties, propertyNames,
 * items, enum, minLength, minItems, minProperties, $ref.
 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, root: JsonSchema, at = '$'): string[] {
  if (schema.$ref) {
    return validateAgainstSchema(resolveRef(schema.$ref, root), value, root, at);
  }

  const errors: string[] = [];

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return errors; // enum failure makes further structural checks meaningless
  }

  if (schema.type) {
    const actual = typeOf(value);
    if (actual !== schema.type) {
      errors.push(`${at}: expected type "${schema.type}", got "${actual}"`);
      return errors;
    }
  }

  if (schema.type === 'string') {
    if (typeof schema.minLength === 'number' && (value as string).length < schema.minLength) {
      errors.push(`${at}: string shorter than minLength ${schema.minLength}`);
    }
  }

  if (schema.type === 'array') {
    const arr = value as unknown[];
    if (typeof schema.minItems === 'number' && arr.length < schema.minItems) {
      errors.push(`${at}: array has ${arr.length} items, minItems is ${schema.minItems}`);
    }
    if (schema.items) {
      arr.forEach((item, idx) => {
        errors.push(...validateAgainstSchema(schema.items, item, root, `${at}[${idx}]`));
      });
    }
  }

  if (schema.type === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      errors.push(`${at}: object has ${keys.length} properties, minProperties is ${schema.minProperties}`);
    }

    if (Array.isArray(schema.required)) {
      for (const requiredKey of schema.required) {
        if (!(requiredKey in obj)) {
          errors.push(`${at}: missing required property "${requiredKey}"`);
        }
      }
    }

    if (schema.propertyNames) {
      for (const key of keys) {
        errors.push(...validateAgainstSchema(schema.propertyNames, key, root, `${at} (property name "${key}")`));
      }
    }

    const declaredProps: Record<string, JsonSchema> = schema.properties || {};
    for (const key of keys) {
      const propSchema = declaredProps[key];
      if (propSchema) {
        errors.push(...validateAgainstSchema(propSchema, obj[key], root, `${at}.${key}`));
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${at}: unexpected property "${key}"`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateAgainstSchema(schema.additionalProperties, obj[key], root, `${at}.${key}`));
      }
    }
  }

  return errors;
}

let cachedIndexSchema: JsonSchema | null = null;

function loadIndexSchema(domainsDir: string): JsonSchema {
  if (cachedIndexSchema) return cachedIndexSchema;
  const raw = fs.readFileSync(path.join(domainsDir, 'index-schema.json'), 'utf8');
  cachedIndexSchema = JSON.parse(raw);
  return cachedIndexSchema;
}

export function validateEcosystemFile(value: unknown, domainsDir: string): string[] {
  const schema = loadIndexSchema(domainsDir);
  return validateAgainstSchema(schema.definitions.ecosystemFile, value, schema);
}

export function validateClassesFile(value: unknown, domainsDir: string): string[] {
  const schema = loadIndexSchema(domainsDir);
  return validateAgainstSchema(schema.definitions.classesFile, value, schema);
}

// ---------------------------------------------------------------------------------------------
// Loading + compiling
// ---------------------------------------------------------------------------------------------

/** Default `domains/` directory: two levels up from this module in both src/pipeline and dist/pipeline. */
export function defaultDomainsDir(): string {
  return path.join(__dirname, '..', '..', 'domains');
}

export function loadEcosystemFiles(domainsDir: string): EcosystemFile[] {
  const ecosystemsDir = path.join(domainsDir, 'ecosystems');
  const files = fs
    .readdirSync(ecosystemsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(ecosystemsDir, file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`domains/ecosystems/${file}: invalid JSON (${(err as Error).message})`);
    }
    const errors = validateEcosystemFile(parsed, domainsDir);
    if (errors.length > 0) {
      throw new Error(`domains/ecosystems/${file}: schema violations:\n  ${errors.join('\n  ')}`);
    }
    return parsed as EcosystemFile;
  });
}

export function loadClassesFile(domainsDir: string): ClassesFile {
  const raw = fs.readFileSync(path.join(domainsDir, 'classes.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const errors = validateClassesFile(parsed, domainsDir);
  if (errors.length > 0) {
    throw new Error(`domains/classes.json: schema violations:\n  ${errors.join('\n  ')}`);
  }
  return parsed as ClassesFile;
}

/** Recursively sorts object keys and (homogeneous string) array elements for deterministic output. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize);
    if (mapped.every((v) => typeof v === 'string')) {
      return [...(mapped as string[])].sort();
    }
    return mapped;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, canonicalize(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Builds the compiled index in memory from the checked-in Layer 1 + Layer 2 sources. Pure and
 * deterministic: two calls against the same `domainsDir` produce byte-identical output.
 */
export function buildCompiledIndex(domainsDir: string): CompiledDomainIndex {
  const ecosystemFiles = loadEcosystemFiles(domainsDir);
  const classesFile = loadClassesFile(domainsDir);

  const seenEcosystemNames = new Set<string>();
  const ecosystems: Record<string, { description: string; classes: Record<string, string[]> }> = {};
  for (const file of ecosystemFiles) {
    if (seenEcosystemNames.has(file.ecosystem)) {
      throw new Error(`domains/ecosystems: duplicate ecosystem name "${file.ecosystem}"`);
    }
    seenEcosystemNames.add(file.ecosystem);
    ecosystems[file.ecosystem] = { description: file.description, classes: file.classes };
  }

  const missingClasses = CLASS_VOCABULARY.filter((c) => !(c in classesFile));
  if (missingClasses.length > 0) {
    throw new Error(`domains/classes.json: missing class(es): ${missingClasses.join(', ')}`);
  }
  for (const [cls, personas] of Object.entries(classesFile)) {
    if (!CLASS_SET.has(cls)) {
      throw new Error(`domains/classes.json: unknown class "${cls}"`);
    }
    for (const persona of personas) {
      if (!PERSONA_SET.has(persona)) {
        throw new Error(`domains/classes.json: class "${cls}" maps to unknown persona "${persona}"`);
      }
    }
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    classVocabulary: [...CLASS_VOCABULARY],
    personaVocabulary: [...PERSONA_VOCABULARY],
    classes: classesFile,
    ecosystems,
  };

  const canonicalPayload = canonicalize(payload);
  const indexDigest = `sha256:${sha256Hex(JSON.stringify(canonicalPayload))}`;

  return { ...(canonicalPayload as Omit<CompiledDomainIndex, 'indexDigest'>), indexDigest };
}

export function loadCompiledIndex(domainsDir: string = defaultDomainsDir()): CompiledDomainIndex {
  const raw = fs.readFileSync(path.join(domainsDir, 'compiled-index.json'), 'utf8');
  return JSON.parse(raw) as CompiledDomainIndex;
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/**
 * Resolves the domain classes and reviewer personas for `filePath` against a compiled index.
 *
 * `matched=true, personas=[]` (e.g. a binary asset) is legitimate and distinct from
 * `matched=false` (no ecosystem glob matched at all). Callers that want fail-closed behavior for
 * unmatched paths (treat as "all personas") implement that policy themselves — it does not live
 * in this resolver.
 */
export function resolveFileDomains(filePath: string, index: CompiledDomainIndex): DomainResolution {
  const matchedClasses = new Set<string>();

  for (const ecosystem of Object.values(index.ecosystems)) {
    for (const [cls, globs] of Object.entries(ecosystem.classes)) {
      if (globs.some((g) => matchOne(g, filePath))) {
        matchedClasses.add(cls);
      }
    }
  }

  if (matchedClasses.size === 0) {
    return { matched: false, classes: [], personas: [] };
  }

  const personas = new Set<string>();
  for (const cls of matchedClasses) {
    for (const persona of index.classes[cls] || []) {
      personas.add(persona);
    }
  }

  return {
    matched: true,
    classes: [...matchedClasses].sort(),
    personas: [...personas].sort(),
  };
}
