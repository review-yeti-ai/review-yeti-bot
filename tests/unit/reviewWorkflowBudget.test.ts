import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('direct Review Bot workflow budget', () => {
  it('reserves a 20-minute evidence phase plus five-minute closeout', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../.github/workflows/review-bot.yaml'),
      'utf8',
    );
    expect(workflow).toMatch(/\n    timeout-minutes: 25\n/u);
    expect(workflow).toContain("action-budget-ms: '1200000'");
    // The pre-dispatch assignment cap must stay above the persona roster x
    // partition-count envelope (5 personas x up to 24 partitions = 120) so a
    // wide diff is fully reviewed instead of failing closed on
    // review_assignment_cap coverage gaps. It is not a spend ceiling: the
    // wall-clock budget above and the lane timeouts own that.
    expect(workflow).toContain("max-review-assignments: '120'");
    expect(workflow).not.toMatch(/\n    timeout-minutes: (?:2[6-9]|[3-9]\d|\d{3,})\n/u);
    expect(workflow).not.toContain('max-diff-chars:');
    expect(workflow).not.toContain("vars.MAX_DIFF_CHARS");
  });
});
