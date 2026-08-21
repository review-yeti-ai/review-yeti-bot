import { describe, expect, it } from 'vitest';
import { FixWorkflow } from '../../src/fix/fixWorkflow';
import { createPRSnapshot } from '../../src/review/prSnapshot';

const head = 'a'.repeat(40);
const snapshot = createPRSnapshot({ owner: 'o', repo: 'r', prNumber: 1, headSha: head, baseSha: 'b'.repeat(40), configRef: 'main:.ct-review.yaml', configDigest: 'c'.repeat(64), engineVersion: 'test', changedFiles: [{ path: 'src/a.ts' }] });
const allowedPatch = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

describe('validated fix workflow', () => {
  it('requires approval and exact head, then validates before proposing a PR', async () => {
    const calls: string[] = [];
    const workflow = new FixWorkflow({ currentHeadSha: async () => head, applyPatch: async () => {}, sandbox: { run: async (command) => { calls.push(command); return { command, exitStatus: 0, stdout: 'ok', stderr: '' }; } }, createBranch: async () => calls.push('branch'), createPullRequest: async () => ({ number: 2, url: 'https://github.com/o/r/pull/2' }) });
    const input = { snapshot, findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }], selectedFindingIds: ['f1'], proposedPatch: allowedPatch, patchPaths: ['src/a.ts'], validation: [{ command: 'npm', args: ['test'] }], approved: false, baseBranch: 'main' };
    expect((await workflow.start(input)).status).toBe('proposal_only');
    const result = await workflow.start({ ...input, approved: true });
    expect(result.status).toBe('ready_for_review');
    expect(result.pullRequest?.number).toBe(2);
    expect(calls).toEqual(['branch', 'npm']);
  });

  it('does not create a PR when validation fails', async () => {
    const workflow = new FixWorkflow({ currentHeadSha: async () => head, applyPatch: async () => {}, sandbox: { run: async (command) => ({ command, exitStatus: 1, stdout: '', stderr: 'failed' }) }, createPullRequest: async () => { throw new Error('must not create'); } });
    const result = await workflow.start({ snapshot, findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }], selectedFindingIds: ['f1'], proposedPatch: allowedPatch, patchPaths: ['src/a.ts'], validation: [{ command: 'npm', args: ['test'] }], approved: true, baseBranch: 'main' });
    expect(result.status).toBe('validation_failed');
  });

  it('applies the proposed patch to the target branch before sandbox validation and PR creation', async () => {
    const order: string[] = [];
    let appliedPatch: { branch: string; headSha: string; proposedPatch: string; patchPaths: string[] } | undefined;
    const dependencies = {
      currentHeadSha: async () => head,
      createBranch: async (branch: string, headSha: string) => {
        order.push('branch');
        expect(headSha).toBe(head);
        expect(branch).toBe(`codex/review-fix/${head.slice(0, 12)}`);
      },
      applyPatch: async (patch: typeof appliedPatch) => {
        order.push('apply');
        appliedPatch = patch;
      },
      sandbox: {
        run: async (command: string) => {
          order.push('validate');
          return { command, exitStatus: 0 as const, stdout: 'ok', stderr: '' };
        },
      },
      createPullRequest: async () => {
        order.push('pr');
        return { number: 2, url: 'https://github.com/o/r/pull/2' };
      },
    };
    const workflow = new FixWorkflow(dependencies);

    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: allowedPatch,
      patchPaths: ['src/a.ts'],
      validation: [{ command: 'npm', args: ['test'] }],
      approved: true,
      baseBranch: 'main',
    });

    expect(result.status).toBe('ready_for_review');
    expect(order).toEqual(['branch', 'apply', 'validate', 'pr']);
    expect(appliedPatch).toEqual({
      branch: `codex/review-fix/${head.slice(0, 12)}`,
      headSha: head,
      proposedPatch: allowedPatch,
      patchPaths: ['src/a.ts'],
    });
  });

  it('fails closed when applying the patch fails', async () => {
    const calls: string[] = [];
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      createBranch: async () => calls.push('branch'),
      applyPatch: async () => { throw new Error('patch does not apply'); },
      sandbox: { run: async (command) => { calls.push(command); return { command, exitStatus: 0, stdout: '', stderr: '' }; } },
      createPullRequest: async () => { calls.push('pr'); return { number: 2, url: 'https://github.com/o/r/pull/2' }; },
    });

    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: allowedPatch,
      patchPaths: ['src/a.ts'],
      validation: [{ command: 'npm', args: ['test'] }],
      approved: true,
      baseBranch: 'main',
    });

    expect(result).toMatchObject({ status: 'blocked', branch: `codex/review-fix/${head.slice(0, 12)}` });
    expect(result.reason).toContain('failed to apply fix patch');
    expect(calls).toEqual(['branch']);
  });

  it('returns validation_failed when the sandbox cannot start a command', async () => {
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => {},
      sandbox: { run: async () => { throw new Error('spawn denied'); } },
    });
    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: allowedPatch,
      patchPaths: ['src/a.ts'],
      validation: [{ command: 'npm', args: ['test'] }],
      approved: true,
      baseBranch: 'main',
    });
    expect(result.status).toBe('validation_failed');
    expect(result.reason).toContain('could not start');
  });

  it('applies an allowed unified diff after approval', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });

    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: allowedPatch,
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });

    expect(result.status).toBe('ready_for_review');
    expect(applyCount).toBe(1);
  });

  it('rejects a unified diff whose new path is outside the approved patch paths', async () => {
    const calls: string[] = [];
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      createBranch: async () => { calls.push('branch'); },
      applyPatch: async () => { calls.push('apply'); },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });

    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: [
        'diff --git a/src/a.ts b/secrets.txt',
        '--- a/src/a.ts',
        '+++ b/secrets.txt',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('outside');
    expect(calls).toEqual([]);
  });

  it('rejects traversal in a unified diff path even when the normalized path looks allowed', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });

    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: allowedPatch.replace('b/src/a.ts', 'b/src/../a.ts'),
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('invalid');
    expect(applyCount).toBe(0);
  });

  it('rejects malformed unified diff headers before applying a patch', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });

    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++\n@@ -1 +1 @@\n-old\n+new\n',
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('invalid');
    expect(applyCount).toBe(0);
  });

  it('rejects binary and link/gitlink modes before applying a fix', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });

    for (const marker of ['GIT binary patch', 'new file mode 120000']) {
      const result = await workflow.start({
        snapshot,
        findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
        selectedFindingIds: ['f1'],
        proposedPatch: [
          'diff --git a/src/a.ts b/src/a.ts',
          marker,
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
        patchPaths: ['src/a.ts'],
        validation: [],
        approved: true,
        baseBranch: 'main',
      });
      expect(result.status).toBe('blocked');
      expect(result.reason).toMatch(/binary|unsupported file mode/i);
    }
    expect(applyCount).toBe(0);
  });

  it('returns a blocked result when fix branch or pull request creation fails', async () => {
    const branchFailure = new FixWorkflow({
      currentHeadSha: async () => head,
      createBranch: async () => { throw new Error('branch already exists'); },
      applyPatch: async () => {},
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });
    await expect(branchFailure.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: allowedPatch,
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    })).resolves.toMatchObject({ status: 'blocked', reason: expect.stringMatching(/create fix branch/i) });

    const pullRequestFailure = new FixWorkflow({
      currentHeadSha: async () => head,
      createBranch: async () => {},
      applyPatch: async () => {},
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
      createPullRequest: async () => { throw new Error('pull request service unavailable'); },
    });
    await expect(pullRequestFailure.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: allowedPatch,
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    })).resolves.toMatchObject({ status: 'blocked', reason: expect.stringMatching(/open fix pull request/i) });
  });

  it('rejects an unapproved file in a raw multi-file diff after the first hunk', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });

    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: [
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '--- a/secrets.txt',
        '+++ b/secrets.txt',
        '@@ -1 +1 @@',
        '-secret',
        '+exposed',
        '',
      ].join('\n'),
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('outside');
    expect(applyCount).toBe(0);
  });

  it('treats an empty context line as part of a raw hunk before the next file boundary', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });

    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: [
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,3 +1,3 @@',
        ' keep',
        '-old',
        '+new',
        '',
        '--- a/secrets.txt',
        '+++ b/secrets.txt',
        '@@ -1 +1 @@',
        '-secret',
        '+exposed',
        '',
      ].join('\n'),
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('outside');
    expect(applyCount).toBe(0);
  });

  it('does not confuse adjacent SQL comments and increment operators for file headers', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });
    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,2 @@',
        '--- sql comment',
        '+++ count',
        '',
      ].join('\n'),
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });
    expect(result.status).toBe('ready_for_review');
    expect(applyCount).toBe(1);
  });

  it('does not confuse deleted header-looking lines with a raw file boundary', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });
    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: [
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,2 @@',
        '--- a/removed.txt',
        '+++ b/removed.txt',
        '',
      ].join('\n'),
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });
    expect(result.status).toBe('ready_for_review');
    expect(applyCount).toBe(1);
  });

  it('rejects an over-declared hunk before an unapproved file header', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });
    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,50 +1,50 @@',
        '+approved',
        '--- a/secrets.txt',
        '+++ b/secrets.txt',
      ].join('\n'),
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('hunk line counts');
    expect(applyCount).toBe(0);
  });

  it('allows repository paths that begin with a or b directories', async () => {
    const directorySnapshot = createPRSnapshot({ ...snapshot, changedFiles: [{ path: 'a/foo.ts' }] });
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });
    const result = await workflow.start({
      snapshot: directorySnapshot,
      findings: [{ id: 'f1', path: 'a/foo.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: 'diff --git a/a/foo.ts b/a/foo.ts\n--- a/a/foo.ts\n+++ b/a/foo.ts\n@@ -1 +1 @@\n-old\n+new\n',
      patchPaths: ['a/foo.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });
    expect(result.status).toBe('ready_for_review');
    expect(applyCount).toBe(1);
  });

  it('rejects an unapproved raw new-file boundary using /dev/null', async () => {
    let applyCount = 0;
    const workflow = new FixWorkflow({
      currentHeadSha: async () => head,
      applyPatch: async () => { applyCount += 1; },
      sandbox: { run: async (command) => ({ command, exitStatus: 0, stdout: '', stderr: '' }) },
    });
    const result = await workflow.start({
      snapshot,
      findings: [{ id: 'f1', path: 'src/a.ts', line: 2 }],
      selectedFindingIds: ['f1'],
      proposedPatch: [
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '--- /dev/null',
        '+++ b/secrets.ts',
        '@@ -0,0 +1 @@',
        '+secret',
        '',
      ].join('\n'),
      patchPaths: ['src/a.ts'],
      validation: [],
      approved: true,
      baseBranch: 'main',
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('outside');
    expect(applyCount).toBe(0);
  });
});
