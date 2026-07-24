export interface ParsedPRPayload {
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  sender: string;
  labels: string[];
  changedFiles?: Array<{ path: string; content?: string; patch?: string }>;
  triggerSource: 'pr_event' | 'comment_command' | 'label_trigger' | 'draft_precheck';
  triggerAction: string;
  commandText?: string;
  commentId?: number;
  deliveryId: string;
  isDraft?: boolean;
}

export interface TriggerResult {
  shouldTrigger: boolean;
  reason: string;
  parsedPayload?: ParsedPRPayload;
}

export interface EventHandlerOptions {
  triggerLabels?: string[];
}

function changedFiles(pr: any, payload: any): ParsedPRPayload['changedFiles'] {
  if (Array.isArray(payload.changed_files)) return payload.changed_files;
  if (Array.isArray(pr.changed_files)) return pr.changed_files;
  if (!Array.isArray(pr.files)) return undefined;
  return pr.files.map((file: any) => ({
    path: file.filename || file.path,
    content: file.content,
    patch: file.patch,
  }));
}

function labels(subject: any): string[] {
  return Array.isArray(subject.labels)
    ? subject.labels.map((label: any) => (typeof label === 'string' ? label : label.name))
    : [];
}

export class GitHubEventHandler {
  private readonly triggerLabels: Set<string>;

  constructor(options: EventHandlerOptions = {}) {
    this.triggerLabels = new Set(options.triggerLabels || ['ct-review', 'ai-review', 'needs-review', 'bot-review']);
  }

  public evaluateTrigger(eventName: string, payload: any, deliveryId = ''): TriggerResult {
    const sender = payload.sender?.login || '';
    if (sender.endsWith('[bot]') || sender === 'ct-review-bot') {
      return { shouldTrigger: false, reason: `Ignored bot action from sender: ${sender}` };
    }

    if (eventName === 'pull_request') {
      const action = payload.action;
      const pr = payload.pull_request || {};
      if (pr.state === 'closed') return { shouldTrigger: false, reason: 'PR is closed' };

      const prLabels = labels(pr);
      const triggerSource = pr.draft === true
        ? 'draft_precheck'
        : action === 'labeled'
          ? 'label_trigger'
          : 'pr_event';
      const isAutomatic = ['opened', 'synchronize', 'reopened'].includes(action)
        || (action === 'labeled' && prLabels.some((label) => this.triggerLabels.has(label)));
      if (pr.draft !== true && !isAutomatic) {
        return { shouldTrigger: false, reason: `PR action '${action}' is not configured for automatic review` };
      }

      const repository = payload.repository || {};
      const parsedPayload: ParsedPRPayload = {
        installationId: String(payload.installation?.id || ''),
        owner: repository.owner?.login || 'calltelemetry',
        repo: repository.name || 'ai-workspace',
        prNumber: pr.number || payload.number || 0,
        headSha: pr.head?.sha || 'head-sha-latest',
        baseSha: pr.base?.sha || 'base-sha-latest',
        title: pr.title || '',
        body: pr.body || '',
        sender,
        labels: prLabels,
        changedFiles: changedFiles(pr, payload),
        triggerSource,
        triggerAction: action,
        deliveryId,
        ...(pr.draft === true ? { isDraft: true } : {}),
      };
      return {
        shouldTrigger: true,
        reason: pr.draft === true ? 'Draft PR policy precheck' : `PR ${action} event triggered review`,
        parsedPayload,
      };
    }

    if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
      const commentBody = payload.comment?.body || '';
      if (!/@(ct-review|bot|ct-review-bot)\s+review/i.test(commentBody)) {
        return { shouldTrigger: false, reason: 'not bot review command' };
      }
      const issue = payload.issue || payload.pull_request || {};
      const repository = payload.repository || {};
      return {
        shouldTrigger: true,
        reason: 'Comment review command detected',
        parsedPayload: {
          installationId: String(payload.installation?.id || ''),
          owner: repository.owner?.login || 'calltelemetry',
          repo: repository.name || 'ai-workspace',
          prNumber: issue.number || payload.number || 0,
          headSha: issue.head?.sha || payload.pull_request?.head?.sha || 'head-sha-latest',
          baseSha: issue.base?.sha || payload.pull_request?.base?.sha || 'base-sha-latest',
          title: issue.title || '',
          body: issue.body || '',
          sender,
          labels: labels(issue),
          triggerSource: 'comment_command',
          triggerAction: payload.action || 'created',
          commandText: commentBody,
          commentId: payload.comment?.id,
          deliveryId,
        },
      };
    }

    return { shouldTrigger: false, reason: `Unsupported event type '${eventName}'` };
  }
}
