import type { ReviewRun } from '../review/reviewRun';

export interface ReviewConversationComment {
  id: string;
  path: string;
  line: number;
  body: string;
  citations?: Array<{ path: string; startLine: number; endLine: number; commitSha: string }>;
}

export type ReviewConversationCommand = 'explain' | 'challenge' | 'fix';

export interface ReviewConversationAnswer {
  kind: 'explanation' | 'review_requested' | 'rejected';
  text: string;
  citations: Array<{ path: string; startLine: number; endLine: number; commitSha: string }>;
}

export class ReviewConversation {
  answer(command: ReviewConversationCommand, comment: ReviewConversationComment, run: ReviewRun): ReviewConversationAnswer {
    const citations = (comment.citations ?? []).filter((citation) =>
      citation.commitSha === run.identity.headSha
      && citation.path === comment.path
      && citation.startLine <= comment.line
      && comment.line <= citation.endLine,
    );
    if (citations.length === 0) {
      return { kind: 'rejected', text: 'This comment is not bound to the exact reviewed head; request a fresh review before acting on it.', citations: [] };
    }
    if (command === 'fix') return { kind: 'review_requested', text: `A fix proposal may be prepared for ${comment.path}:${comment.line}; the verdict remains unchanged until the new head is validated and re-reviewed.`, citations };
    if (command === 'challenge') return { kind: 'review_requested', text: `The finding at ${comment.path}:${comment.line} is queued for a cited re-review; no verdict was changed implicitly.`, citations };
    return { kind: 'explanation', text: `${comment.body}\n\nExact reviewed head: ${run.identity.headSha}.`, citations };
  }
}
