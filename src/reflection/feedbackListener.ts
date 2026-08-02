import { LearningStore } from './learningStore';
import { LLMCommentLearner, CommentJudgmentResult } from './llmCommentLearner';
import { logger } from '../utils/logger';

export interface ReactionEvent {
  owner?: string;
  repo?: string;
  prNumber?: number;
  commentId: number;
  reaction: string;
  sender?: string;
  comment?: { body?: string };
  commentBody?: string;
  body?: string;
}

export interface ReplyEvent {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  inReplyToId?: number;
  body: string;
  sender?: string;
  filePath?: string;
  lineNumber?: number;
  diffHunk?: string;
  originalFindingBody?: string;
  diffSnippet?: string;
  codeSemantics?: string;
}

export class FeedbackListener {
  private llmLearner: LLMCommentLearner;

  constructor(private learningStore: LearningStore, llmLearner?: LLMCommentLearner) {
    // Share the injected memory boundary; otherwise learned nits are written
    // to a private store that callers cannot query through LearningStore.
    this.llmLearner = llmLearner || new LLMCommentLearner(undefined, learningStore.getMemoryStore());
  }

  public async handleReaction(eventOrRepo: any, eventPayload?: any): Promise<void> {
    let repo = 'default';
    let event: ReactionEvent;

    if (typeof eventOrRepo === 'string' && eventPayload) {
      repo = eventOrRepo;
      event = eventPayload;
    } else {
      event = eventOrRepo;
      repo = `${event.owner || 'default'}/${event.repo || 'repo'}`;
    }

    const reactionStr = (event.reaction || '').toLowerCase().trim();
    const isNegative =
      reactionStr === '-1' ||
      reactionStr === 'thumbsdown' ||
      reactionStr === 'thumbs_down' ||
      reactionStr.includes('down') ||
      reactionStr === 'dislike';

    if (isNegative) {
      const commentText = event.comment?.body || event.commentBody || event.body || '';
      const pattern = commentText
        ? commentText.split('\n')[0].replace(/^###\s*/, '').trim()
        : 'Feedback nit suppression';

      await this.learningStore.recordFeedbackNit(
        repo,
        event.prNumber || 0,
        pattern,
        '**',
        'User rejected nit via thumbs down reaction'
      );
    }

    await this.learningStore.recordFeedback(repo, reactionStr);
  }

  public async handleReply(event: ReplyEvent): Promise<CommentJudgmentResult> {
    logger.info('Delegating PR comment reply to LLM Judgment Engine', {
      owner: event.owner,
      repo: event.repo,
      prNumber: event.prNumber,
      sender: event.sender,
    });

    const result = await this.llmLearner.processCommentWithJudgment({
      owner: event.owner,
      repo: event.repo,
      prNumber: event.prNumber,
      commentBody: event.body,
      sender: event.sender || 'unknown',
      filePath: event.filePath,
      lineNumber: event.lineNumber,
      diffHunk: event.diffHunk,
      originalFindingBody: event.originalFindingBody,
      diffSnippet: event.diffSnippet,
      codeSemantics: event.codeSemantics,
    });

    logger.info('LLM Judgment Result', { intent: result.intent, reaction: result.githubReaction });
    return result;
  }
}
