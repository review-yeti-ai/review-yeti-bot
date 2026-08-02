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
    this.llmLearner = llmLearner || new LLMCommentLearner(undefined, learningStore?.getMemoryStore());
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

    if (result.learnedRule || result.intent === 'FALSE_POSITIVE_CORRECTION' || result.intent === 'REJECTED_SUGGESTION' || result.intent === 'REFUTATION') {
      const fullRepo = `${event.owner}/${event.repo}`;
      const pattern = result.learnedRule?.pattern || event.body.slice(0, 40);
      const reason = result.learnedRule?.rule || `User reply refutation: ${event.body}`;
      if (!result.learnedRule && this.learningStore?.recordFeedbackNit) {
        await this.learningStore.recordFeedbackNit(fullRepo, event.prNumber, pattern, event.filePath || '**', reason);
      }
    }

    logger.info('LLM Judgment Result', { intent: result.intent, reaction: result.githubReaction });
    return result;
  }
}
