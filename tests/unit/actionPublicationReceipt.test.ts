import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pipeline = require('../../.github/workflows/pipelines/review-pipeline.js');
const context = { repo: 'review-yeti-ai/review-yeti-bot', prNumber: 638, headSha: '366e0d5d43dae75609821a8a8a63725a63b8e9c8', baseSha: '7357e129f56fe4d94a947bcc0c0b2a2f66ef7531' };
const plan = { lineComments: [{ path: 'src/github/appAuth.ts', line: 48, side: 'RIGHT', body: 'PRIVATE_FINDING_BODY', markerKey: 'PRIVATE_MARKER', finding: { rawProviderOutput: 'PRIVATE_PROVIDER_OUTPUT' } }], fileComments: [], rejected: [], advisories: [], overflow: [] };
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-receipt-test-'));
  vi.stubEnv('RUNNER_TEMP', dir);
  vi.stubEnv('GITHUB_RUN_ID', '34406114670');
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('current-run-only publication evidence', () => {
  it.each([false, true])('records actual publication state, not an invented verdict (published=%s)', (published) => {
    const file = pipeline.writePublicationReceipt(context, plan, { success: published, postedViaGh: published, error: 'PRIVATE_ERROR', diagnostics: [] }, dir);
    const bytes = fs.readFileSync(file.path, 'utf8');
    const receipt = JSON.parse(bytes);
    expect(file.digest).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(fs.statSync(file.path).mode & 0o777).toBe(0o600);
    expect(receipt).toMatchObject({ schemaVersion: 'review-publication-receipt-v1', repository: context.repo, prNumber: 638, headSha: context.headSha, baseSha: context.baseSha, runId: '34406114670', runAttempt: 1, publicationStatus: published ? 'published' : 'failed', plannedCounts: { line: 1, file: 0, rejected: 0, advisory: 0, overflow: 0 } });
    expect(receipt.marker).toContain('34406114670:1');
    const wireBody = 'PRIVATE_FINDING_BODY\n\n<!-- review-yeti-bot:finding:v1:366e0d5d43dae75609821a8a8a63725a63b8e9c8:PRIVATE_MARKER -->';
    expect(receipt.items[0]).toMatchObject({ kind: 'line', line: 48, side: 'RIGHT', bodyBytes: Buffer.byteLength(wireBody), bodyDigest: crypto.createHash('sha256').update(wireBody).digest('hex'), pathDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(bytes).not.toMatch(/PRIVATE_|SHIP|rawProvider|error"/);
  });

  it('does not overwrite a prior artifact on the same head or attempt', () => {
    const first = pipeline.writePublicationReceipt(context, plan, { success: false }, dir);
    const before = fs.readFileSync(first.path, 'utf8');
    const second = pipeline.writePublicationReceipt(context, plan, { success: true, postedViaGh: true }, dir);
    expect(second.path).not.toBe(first.path);
    expect(fs.readFileSync(first.path, 'utf8')).toBe(before);
  });

  it.each(['', '1\nINJECTED=value', '0'])('does not expose a current-run output without a valid run identity (%j)', (id) => {
    vi.stubEnv('GITHUB_RUN_ID', id);
    expect(pipeline.writePublicationReceipt(context, plan, { success: false }, dir)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('bounds plan metadata and excludes untrusted error/provider fields', () => {
    const largePlan = { ...plan, lineComments: Array.from({ length: 1000 }, () => plan.lineComments[0]) };
    const file = pipeline.writePublicationReceipt(context, largePlan, { success: false, diagnostics: [{ secret: 'PRIVATE_SECRET', validation: [{ resource: 'PRIVATE_RESOURCE' }], request: { body: 'PRIVATE_BODY' } }] }, dir);
    const bytes = fs.readFileSync(file.path, 'utf8');
    const receipt = JSON.parse(bytes);
    expect(receipt.plannedCounts.line).toBe(1000);
    expect(receipt.items.length).toBeLessThanOrEqual(100);
    expect(bytes.length).toBeLessThan(64_000);
    expect(bytes).not.toContain('PRIVATE_');
  });

  it('routes uploads exclusively through newly emitted Action outputs, never the tracked sample', () => {
    const historical = path.join(dir, 'review-comment.md');
    fs.writeFileSync(historical, 'HISTORICAL_SAMPLE');
    const receipt = pipeline.writePublicationReceipt(context, plan, { success: false }, dir);
    const outputsFile = path.join(dir, 'outputs');
    pipeline.writeStepOutputs({ verdict: 'SHIP', metrics: {} }, outputsFile, null, null, null, receipt);
    const outputs = Object.fromEntries(fs.readFileSync(outputsFile, 'utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    expect(outputs['publication-receipt-path']).toBe(receipt.path);
    expect(outputs['publication-receipt-digest']).toBe(receipt.digest);
    const root = path.resolve(__dirname, '../..');
    const action = yaml.load(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as any;
    const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/review-bot.yaml'), 'utf8')) as any;
    const forwarded = action.outputs['publication-receipt-path'].value.replace(/\$\{\{ steps\.review\.outputs\.([\w-]+) \}\}/g, (_all: string, key: string) => outputs[key] || '');
    expect(forwarded).toBe(receipt.path);
    const uploads = workflow.jobs.review.steps.filter((s: any) => String(s.uses || '').startsWith('actions/upload-artifact@'));
    const resolve = (value: string) => value.replace(/\$\{\{ steps\.review\.outputs\.([\w-]+) \}\}/g, (_all: string, key: string) => outputs[key] || '').replace(/\$\{\{ github\.run_id \}\}/g, '34406114670').replace(/\$\{\{ github\.run_attempt \}\}/g, '1');
    const uploadPaths = uploads.flatMap((step: any) => resolve(step.with.path).split('\n').filter(Boolean));
    expect(uploadPaths).toEqual([receipt.path]);
    expect(uploadPaths.some((p: string) => p.includes('review-comment.md') || p.includes('sessions/'))).toBe(false);
    expect(uploads.every((s: any) => resolve(s.with.name).includes('34406114670-1'))).toBe(true);
    expect(fs.readFileSync(historical, 'utf8')).toBe('HISTORICAL_SAMPLE');
  });
});
