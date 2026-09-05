import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const root = process.cwd();
const patrolPath = path.join(root, '.github/workflows/v1-release-integrity.yml');
const promotePath = path.join(root, '.github/workflows/update-major-tag.yml');

/**
 * REL-584. Consumers resolve this repository's rolling `v1` tag at review time, and the promise it
 * makes is "a commit that passed the release pipeline". `update-major-tag.yml`'s
 * `unreleased_recovery` input deliberately bypasses that and promotes the bare main tip — it has
 * been used (v1 -> 2742cf4, which carried no release tag), and ADR 0513 records routine use as the
 * trigger to re-derive what `v1` guarantees.
 *
 * The recovery path is intentionally kept: it exists for a real emergency. What was missing is any
 * way to notice it had been used. These assertions keep that observable.
 */
describe('v1 release integrity patrol (REL-584)', () => {
  const raw = fs.readFileSync(patrolPath, 'utf8');
  const workflow = yaml.load(raw) as any;

  it('runs on a schedule, not only by hand', () => {
    expect(workflow.on.schedule?.[0]?.cron).toBeTruthy();
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('asserts v1 carries a semver release tag, which is the actual guarantee', () => {
    // Not "v1 == main": v1 legitimately trails main between releases. The invariant is that the
    // commit v1 points at went through the release pipeline.
    expect(raw).toContain('git tag --points-at');
    expect(raw).toMatch(/\^v\[0-9\]\+\\?\.\[0-9\]\+\\?\.\[0-9\]\+\$/u);
    expect(raw).not.toMatch(/behind_by/u);
  });

  it('never moves v1 itself — promotion stays the exclusive writer', () => {
    expect(raw).not.toMatch(/git (tag|push)[^\n]*\bv1\b/u);
    expect(workflow.permissions.contents).toBe('read');
  });

  it('opens at most one issue, so a standing drift does not spam', () => {
    expect(raw).toContain('labels=v1-drift');
    expect(raw).toMatch(/already open/u);
  });

  it('still allows the emergency recovery path it is watching', () => {
    // The patrol observes; it must not have been "fixed" by deleting the escape hatch.
    const promote = fs.readFileSync(promotePath, 'utf8');
    expect(promote).toContain('unreleased_recovery');
  });
});
