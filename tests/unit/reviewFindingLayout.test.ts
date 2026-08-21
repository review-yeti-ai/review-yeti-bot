import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { formatPRComment, abbreviatePath, computeArbitrationQuorum } = pipeline;

const LONG = 'server/CoolFocus/Services/Inbox/SmsComplianceWayCoolReviewSupportNotifier.cs';

const prContext = { repo: 'waycool/CoolFocus', prNumber: '7', headSha: '33833acdeadbeef', title: 'x' };

const results = [{
  personaId: 'observability',
  displayName: '🛰️ Observability and Attribution',
  model: 'openrouter/auto',
  decision: 'FINDINGS',
  findings: [{
    severity: 'P2',
    path: LONG,
    line: 293,
    title: 'Missing observability for uncovered notification channel',
    body: 'The new channel emits no telemetry, so failures are invisible.',
    suggestion: 'Emit a counter and structured log alongside the existing channels.',
  }],
}];

const comment = () => formatPRComment(computeArbitrationQuorum(results, 1), results, prContext, {}, { enabled: true, model: 'openrouter/auto' });

describe('abbreviatePath', () => {
  it('leaves short paths intact', () => {
    expect(abbreviatePath('src/api/orders.ts')).toBe('src/api/orders.ts');
  });

  it('shortens long paths while keeping the filename, which carries the most meaning', () => {
    const out = abbreviatePath(LONG);
    expect(out.length).toBeLessThan(LONG.length);
    expect(out).toContain('SmsComplianceWayCoolReviewSupportNotifier.cs');
    expect(out).toContain('…');
  });

  it('keeps the leading segment for orientation', () => {
    expect(abbreviatePath(LONG).startsWith('server/')).toBe(true);
  });
});

describe('Finding layout survives long file paths', () => {
  it('does not render findings as a fixed-column table', () => {
    // A markdown table gives the path its own column, so one long path crushes every other
    // column into vertical text.
    expect(comment()).not.toContain('| Severity | Path | Line | Title | Suggestion |');
  });

  it('shows the abbreviated path, not the full one, in the visible text', () => {
    const c = comment();
    expect(c).toContain('SmsComplianceWayCoolReviewSupportNotifier.cs');
    expect(c).toContain('…');
  });

  it('links the location to the exact line on the reviewed commit', () => {
    expect(comment()).toContain(`https://github.com/waycool/CoolFocus/blob/33833acdeadbeef/${LONG}#L293`);
  });

  it('keeps severity and title together on one line', () => {
    expect(comment()).toMatch(/P2.*Missing observability for uncovered notification channel/);
  });

  it('still renders the body and the suggestion', () => {
    const c = comment();
    expect(c).toContain('failures are invisible');
    expect(c).toContain('Emit a counter and structured log');
  });

  it('omits the link when there is no commit to anchor against', () => {
    const noSha = { ...prContext, headSha: '' };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, noSha, {}, {});
    expect(c).not.toContain('https://github.com//blob');
    expect(c).toContain('SmsComplianceWayCoolReviewSupportNotifier.cs');
  });
});
