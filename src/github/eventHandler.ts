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
  triggerSource: 'pr_event' | 'comment_command' | 'label_trigger' | 'draft_precheck' | 'pr_close_event';
  triggerAction: string;
  commandText?: string;
  commentId?: number;
  inReplyToId?: number;
  deliveryId: string;
  isDraft?: boolean;
  isMerged?: boolean;
  mergedAt?: string;
  targetBranch?: string;
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

function extractOwnerRepo(payload: any): { owner: string; repo: string } {
  let owner = '';
  let repo = '';

  const repository = payload.repository;
  if (typeof repository === 'string' && repository.includes('/')) {
    const parts = repository.split('/');
    owner = parts[0];
    repo = parts[1];
  } else if (repository && typeof repository === 'object') {
    owner = repository.owner?.login || repository.owner?.name || (typeof repository.owner === 'string' ? repository.owner : '');
    if (!owner && repository.full_name && repository.full_name.includes('/')) {
      owner = repository.full_name.split('/')[0];
    }
    repo = repository.name || repository.repo || '';
    if (!repo && repository.full_name && repository.full_name.includes('/')) {
      repo = repository.full_name.split('/')[1];
    }
  }

  if (!owner && payload.owner) owner = String(payload.owner);
  if (!repo && (payload.repo || payload.repository_name)) repo = String(payload.repo || payload.repository_name);

  if (!owner) owner = process.env.GITHUB_REPOSITORY_OWNER || (process.env.GITHUB_REPOSITORY?.split('/')[0]) || '';
  if (!repo) repo = (process.env.GITHUB_REPOSITORY?.split('/')[1]) || '';

  return { owner, repo };
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

    const { owner, repo } = extractOwnerRepo(payload);

    if (eventName === 'pull_request') {
      const action = payload.action;
      const pr = payload.pull_request || {};
      
      if (action === 'closed') {
        const isMerged = pr.merged === true;
        if (!isMerged) {
          return { shouldTrigger: false, reason: 'PR is closed without being merged' };
        }
        
        const parsedPayload: ParsedPRPayload = {
          installationId: String(payload.installation?.id || ''),
          owner,
          repo,
          prNumber: pr.number || payload.number || 0,
          headSha: pr.head?.sha || payload.head_sha || payload.after || 'head-sha-latest',
          baseSha: pr.base?.sha || payload.base_sha || payload.before || 'base-sha-latest',
          title: pr.title || '',
          body: pr.body || '',
          sender,
          labels: labels(pr),
          changedFiles: changedFiles(pr, payload),
          triggerSource: 'pr_close_event',
          triggerAction: action,
          deliveryId,
          isMerged: true,
          mergedAt: pr.merged_at || new Date().toISOString(),
          targetBranch: pr.base?.ref || 'main',
        };

        if (!parsedPayload.owner || !parsedPayload.repo) {
          console.warn('Missing owner or repo in payload');
          return { shouldTrigger: false, reason: 'Missing owner or repo in payload' };
        }

        return {
          shouldTrigger: true,
          reason: 'PR closed and merged event triggered PR close action dispatcher',
          parsedPayload,
        };
      }

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

      const parsedPayload: ParsedPRPayload = {
        installationId: String(payload.installation?.id || ''),
        owner,
        repo,
        prNumber: pr.number || payload.number || 0,
        headSha: pr.head?.sha || '',
        baseSha: pr.base?.sha || '',
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

      if (!parsedPayload.owner || !parsedPayload.repo) {
        console.warn('Missing owner or repo in payload');
        return { shouldTrigger: false, reason: 'Missing owner or repo in payload' };
      }

      return {
        shouldTrigger: true,
        reason: pr.draft === true ? 'Draft PR policy precheck' : `PR ${action} event triggered review`,
        parsedPayload,
      };
    }

    if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
      const commentBody = payload.comment?.body || '';
      const inReplyToId = payload.comment?.in_reply_to_id || payload.comment?.inReplyToId;
      const isBotMention = /@(ct-review|bot|ct-review-bot)(\[[^\]]+\])?\b/i.test(commentBody);
      const isInlineReply = Boolean(inReplyToId);

      if (!isBotMention && !isInlineReply) {
        return { shouldTrigger: false, reason: 'not bot review command or inline reply' };
      }

      const issue = payload.issue || payload.pull_request || {};
      const parsedPayload: ParsedPRPayload = {
        installationId: String(payload.installation?.id || ''),
        owner,
        repo,
        prNumber: issue.number || payload.number || 0,
        headSha: issue.head?.sha || payload.pull_request?.head?.sha || '',
        baseSha: issue.base?.sha || payload.pull_request?.base?.sha || '',
        title: issue.title || '',
        body: issue.body || '',
        sender,
        labels: labels(issue),
        triggerSource: 'comment_command',
        triggerAction: payload.action || 'created',
        commandText: commentBody,
        commentId: payload.comment?.id,
        inReplyToId: inReplyToId ? Number(inReplyToId) : undefined,
        deliveryId,
      };

      if (!parsedPayload.owner || !parsedPayload.repo) {
        console.warn('Missing owner or repo in payload');
        return { shouldTrigger: false, reason: 'Missing owner or repo in payload' };
      }

      return {
        shouldTrigger: true,
        reason: isInlineReply ? 'Inline comment reply detected' : 'Comment review command detected',
        parsedPayload,
      };
    }

    return { shouldTrigger: false, reason: `Unsupported event type '${eventName}'` };
  }
}
