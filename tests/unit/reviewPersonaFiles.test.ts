import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { loadPersonaFiles, resolvePersonaRoster, PERSONA_CHARTERS, DEFAULT_PERSONA_IDS } = pipeline;

let repo: string;

/** Writes a persona file into <repo>/.review-yeti/personas/<name>. */
function writePersona(name: string, contents: string) {
  const dir = path.join(repo, '.review-yeti', 'personas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), contents, 'utf-8');
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-personas-'));
});

describe('loadPersonaFiles', () => {
  it('returns nothing when the directory does not exist', () => {
    const r = loadPersonaFiles(repo);
    expect(r.personas).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('reads a persona from frontmatter plus a markdown body', () => {
    writePersona('tenancy.md', `---
name: "🏢 Multi-Tenant Isolation"
---

Every query touching customer data must be scoped by orgId.

## What to flag
- Repository methods accepting a raw id without a tenant bound
`);
    const { personas, errors } = loadPersonaFiles(repo);
    expect(errors).toEqual([]);
    expect(personas).toHaveLength(1);
    expect(personas[0].name).toBe('🏢 Multi-Tenant Isolation');
    expect(personas[0].charter).toContain('scoped by orgId');
    expect(personas[0].charter).toContain('What to flag');
  });

  it('derives the persona id from the filename', () => {
    writePersona('tenancy.md', '---\n---\nScope everything by orgId.\n');
    expect(loadPersonaFiles(repo).personas[0].id).toBe('tenancy');
  });

  it('lets frontmatter override the filename-derived id', () => {
    writePersona('01-tenancy.md', '---\nid: tenancy\n---\nScope everything by orgId.\n');
    expect(loadPersonaFiles(repo).personas[0].id).toBe('tenancy');
  });

  it('works with no frontmatter at all', () => {
    writePersona('bundle-size.md', 'Flag any dependency that adds more than 50kb gzipped.\n');
    const { personas, errors } = loadPersonaFiles(repo);
    expect(errors).toEqual([]);
    expect(personas[0].id).toBe('bundle-size');
    expect(personas[0].charter).toContain('50kb');
  });

  it('carries enabled and model through from frontmatter', () => {
    writePersona('a.md', '---\nenabled: false\nmodel: anthropic/claude-sonnet-4\n---\nBody.\n');
    const p = loadPersonaFiles(repo).personas[0];
    expect(p.enabled).toBe(false);
    expect(p.model).toBe('anthropic/claude-sonnet-4');
  });

  it('reads every persona file in the directory, sorted for deterministic ordering', () => {
    writePersona('b.md', 'Second.\n');
    writePersona('a.md', 'First.\n');
    expect(loadPersonaFiles(repo).personas.map((p: any) => p.id)).toEqual(['a', 'b']);
  });

  it('ignores files that are not markdown', () => {
    writePersona('notes.txt', 'not a persona');
    writePersona('real.md', 'A charter.\n');
    expect(loadPersonaFiles(repo).personas.map((p: any) => p.id)).toEqual(['real']);
  });

  it('errors on a persona file with no charter body', () => {
    writePersona('empty.md', '---\nname: Ghost\n---\n\n   \n');
    const { personas, errors } = loadPersonaFiles(repo);
    expect(personas).toEqual([]);
    expect(errors[0]).toContain('empty.md');
  });

  it('errors on malformed frontmatter rather than silently dropping the persona', () => {
    writePersona('bad.md', '---\nname: "unterminated\n  bad: [\n---\nBody.\n');
    expect(loadPersonaFiles(repo).errors.length).toBeGreaterThan(0);
  });
});

describe('resolvePersonaRoster with persona files', () => {
  const filePersona = (over: any = {}) => ({
    id: 'tenancy',
    name: '🏢 Multi-Tenant Isolation',
    charter: 'Scope every customer query by orgId.',
    enabled: true,
    source: '.review-yeti/personas/tenancy.md',
    ...over,
  });

  it('adds file personas to the built-in roster when no explicit selection exists', () => {
    const r = resolvePersonaRoster({}, null, {}, [filePersona()]);
    expect(r.errors).toEqual([]);
    expect(r.personas.map((p: any) => p.id)).toContain('tenancy');
    expect(r.personas.map((p: any) => p.id)).toContain('security');
    expect(r.personas).toHaveLength(DEFAULT_PERSONA_IDS.length + 1);
  });

  it('excludes a file persona disabled in its frontmatter', () => {
    const r = resolvePersonaRoster({}, null, {}, [filePersona({ enabled: false })]);
    expect(r.personas.map((p: any) => p.id)).not.toContain('tenancy');
  });

  it('lets an explicit selection reference a file-defined persona', () => {
    const r = resolvePersonaRoster({}, null, { ACTIVE_PERSONAS: 'tenancy' }, [filePersona()]);
    expect(r.personas.map((p: any) => p.id)).toEqual(['tenancy']);
    expect(r.personas[0].charter).toContain('orgId');
  });

  it('lets a persona file override a built-in charter', () => {
    const r = resolvePersonaRoster({}, null, { ACTIVE_PERSONAS: 'security' }, [
      filePersona({ id: 'security', name: undefined, charter: 'Only flag hardcoded credentials.' }),
    ]);
    expect(r.personas[0].charter).toBe('Only flag hardcoded credentials.');
    // Keeps the built-in display name when the file does not set one.
    expect(r.personas[0].name).toBe(PERSONA_CHARTERS.find((p: any) => p.id === 'security').name);
  });

  it('rejects the same id declared both in a file and inline, rather than guessing precedence', () => {
    const localConfig = {
      file: '.review-yeti.yaml',
      parsed: { personas: [{ id: 'tenancy', charter: 'Inline version.' }] },
    };
    const r = resolvePersonaRoster({}, localConfig, {}, [filePersona()]);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]).toContain('tenancy');
  });

  it('still fails loudly on an unknown id when persona files are present', () => {
    const r = resolvePersonaRoster({ activePersonas: ['nope'] }, null, {}, [filePersona()]);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
