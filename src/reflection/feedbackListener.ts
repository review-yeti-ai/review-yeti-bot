import { LearningStore } from './learningStore';

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
}

export class FeedbackListener {
  constructor(private learningStore: LearningStore) {}

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

  public async handleReply(event: ReplyEvent): Promise<void> {
    const repo = `${event.owner}/${event.repo}`;
    const bodyLower = (event.body || '').toLowerCase();

    if (bodyLower.includes('false positive') || bodyLower.includes('ignore') || bodyLower.includes('nit')) {
      const pattern = event.body
        ? event.body.split('\n')[0].replace(/^###\s*/, '').trim()
        : 'Feedback nit suppression';

      await this.learningStore.recordFeedbackNit(
        repo,
        event.prNumber,
        pattern,
        '**',
        `User indicated: ${event.body}`
      );
    }
  }
}

