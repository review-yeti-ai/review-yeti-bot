import { describe, expect, it } from 'vitest';
import { ReviewConversation } from '../../src/chat/reviewConversation';
import { createPRSnapshot } from '../../src/review/prSnapshot';
import type { ReviewRun } from '../../src/review/reviewRun';

const head = 'a'.repeat(40);
const run = { identity: { owner: 'o', repo: 'r', prNumber: 1, headSha: head, baseSha: 'b'.repeat(40), snapshotDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64) } } as ReviewRun;

describe('cited review conversation', () => {
  it('answers with exact-head citations and never silently changes the verdict', () => {
    const comment = { id: 'f1', path: 'src/a.ts', line: 2, body: 'unsafe input', citations: [{ path: 'src/a.ts', startLine: 2, endLine: 3, commitSha: head }] };
    expect(new ReviewConversation().answer('explain', comment, run)).toMatchObject({ kind: 'explanation', citations: comment.citations });
    expect(new ReviewConversation().answer('fix', comment, run).kind).toBe('review_requested');
  });

  it('rejects stale conversation citations', () => {
    const comment = { id: 'f1', path: 'src/a.ts', line: 2, body: 'unsafe input', citations: [{ path: 'src/a.ts', startLine: 2, endLine: 3, commitSha: 'e'.repeat(40) }] };
    expect(new ReviewConversation().answer('challenge', comment, run).kind).toBe('rejected');
  });

  it('rejects comments with missing citations without throwing', () => {
    const comment = { id: 'f2', path: 'src/a.ts', line: 2, body: 'unsafe input' } as Parameters<ReviewConversation['answer']>[1];
    expect(new ReviewConversation().answer('explain', comment, run)).toMatchObject({ kind: 'rejected', citations: [] });
  });
});
