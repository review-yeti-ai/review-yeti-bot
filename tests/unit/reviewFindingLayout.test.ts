import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const { formatPRComment, abbreviatePath, computeArbitrationQuorum } = pipeline;

const LONG = 'server/ExampleApp/Services/Inbox/SmsComplianceReviewSupportNotifier.cs';

const prContext = { repo: 'example-org/example-app', prNumber: '7', headSha: '33833acdeadbeef', title: 'x' };

const results = [{
  personaId: 'observability',
  displayName: '🛰️ Observability and Attribution',
  model: 'openrouter/auto-beta',
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

const comment = () => formatPRComment(computeArbitrationQuorum(results, 1), results, prContext, {}, { enabled: true, model: 'openrouter/auto-beta' });

describe('abbreviatePath', () => {
  it('leaves short paths intact', () => {
    expect(abbreviatePath('src/api/orders.ts')).toBe('src/api/orders.ts');
  });

  it('shortens long paths while keeping the filename, which carries the most meaning', () => {
    const out = abbreviatePath(LONG);
    expect(out.length).toBeLessThan(LONG.length);
    expect(out).toContain('SmsComplianceReviewSupportNotifier.cs');
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
    expect(c).toContain('SmsComplianceReviewSupportNotifier.cs');
    expect(c).toContain('…');
  });

  it('links the location to the exact line on the reviewed commit', () => {
    expect(comment()).toContain(`https://github.com/example-org/example-app/blob/33833acdeadbeef/${LONG}#L293`);
  });

  it('renders P2 findings in one collapsed title-only advisory section', () => {
    const c = comment();
    expect(c).toContain('<summary><b>🟡 P2 advisories (1)</b></summary>');
    expect(c).toContain('Missing observability for uncovered notification channel');
  });

  it('omits P2 bodies and fixes from the compact review body', () => {
    const c = comment();
    expect(c).not.toContain('failures are invisible');
    expect(c).not.toContain('Emit a counter and structured log');
  });

  it('does not duplicate P0/P1 details that belong in resolvable conversations', () => {
    const actionable = [{
      ...results[0],
      findings: [{
        severity: 'P1',
        path: LONG,
        line: 293,
        title: 'Actionable inline title',
        body: 'Actionable explanation belongs inline.',
        suggestion: 'Actionable fix belongs inline.',
      }],
    }];
    const plan = {
      lineComments: [{ path: LONG, line: 293, side: 'RIGHT', body: 'inline', markerKey: 'one' }],
      fileComments: [],
      advisories: [],
      rejected: [],
    };
    const c = formatPRComment(computeArbitrationQuorum(actionable, 1), actionable, prContext, {}, {}, null, null, plan);
    expect(c).toContain('1 new P0/P1 finding(s) published as resolvable review conversation(s)');
    expect(c).not.toContain('Actionable inline title');
    expect(c).not.toContain('Actionable explanation belongs inline');
    expect(c).not.toContain('Actionable fix belongs inline');
  });

  it('omits the link when there is no commit to anchor against', () => {
    const noSha = { ...prContext, headSha: '' };
    const c = formatPRComment(computeArbitrationQuorum(results, 1), results, noSha, {}, {});
    expect(c).not.toContain('https://github.com//blob');
    expect(c).toContain('SmsComplianceReviewSupportNotifier.cs');
  });
});
