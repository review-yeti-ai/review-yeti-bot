import { GitHubInstallationClient, ReviewComment } from '../github/installationClient';
import { ReviewModelClient } from '../gateway/openRouterClient';
import { generatePRSummary } from '../review/summaryEngine';
import { generateMermaidDiagram } from '../review/mermaidEngine';
import { ReflectionCommandParser, LearningStore } from '../reflection';
import { PRMemoryStore } from '../memory/prMemoryStore';
import { getGitHubAppInstallationToken } from '../github/appAuth';
import { logger } from '../utils/logger';

export type CommandType = 'review' | 'explain' | 'fix' | 'refactor' | 'ignore' | 'mute' | 'summarize' | 'ask' | 'learn' | 'remember' | 'forget';

export interface ParsedCommand {
  command: CommandType;
  args: string;
  rawText: string;
}

export interface ChatContext {
  owner: string;
  repo: string;
  prNumber: number;
  headSha?: string;
  baseSha?: string;
  commentId?: number;
  inReplyToId?: number;
  diffHunk?: string;
  filePath?: string;
  lineNumber?: number;
  sender?: string;
  github: GitHubInstallationClient;
  /** @deprecated Unsupported legacy field; ignored. Pass the OpenRouter client via modelClient. */
  omniRoute?: ReviewModelClient;
  modelClient?: ReviewModelClient;
  memoryStore?: PRMemoryStore;
  onRunReviewPipeline?: (payload: any) => Promise<any>;
  payload?: any;
  appAuthConfig?: {
    appId: string;
    privateKey: string;
    installationId: string;
    baseUrl?: string;
  };
}

export interface DispatchResult {
  command: CommandType;
  success: boolean;
  message?: string;
  output?: string;
}

export function parseCommand(commandStr: string): ParsedCommand | null {
  if (!commandStr || typeof commandStr !== 'string') return null;
  const match = commandStr.match(
    /(?:^|\s)@(review-yeti|review-yeti-bot|ct-review|ct-review-bot|bot)(?:\[bot\])?\s+(review|explain|fix|refactor|ignore|mute|summarize|ask|learn|remember|forget)(?:\s+([\s\S]*))?$/i
  );
  if (!match) return null;
  return {
    command: match[2].toLowerCase() as CommandType,
    args: (match[3] || '').trim(),
    rawText: commandStr,
  };
}

export class CommandDispatcher {
  constructor(private readonly defaultModel: string = 'openrouter/auto') {}

  async dispatchCommand(commandStr: string, context: ChatContext): Promise<DispatchResult> {
    const parsed = parseCommand(commandStr);
    if (!parsed) {
      throw new Error(`Unrecognized command format: "${commandStr}"`);
    }

    if (!context.github && context.appAuthConfig) {
      const tokenResult = await getGitHubAppInstallationToken({
        appId: context.appAuthConfig.appId,
        privateKey: context.appAuthConfig.privateKey,
        installationId: context.appAuthConfig.installationId,
        baseUrl: context.appAuthConfig.baseUrl,
      });
      context.github = new GitHubInstallationClient({
        token: tokenResult.token,
        baseUrl: context.appAuthConfig.baseUrl || 'https://api.github.com',
      });
    }

    logger.info('Dispatching PR chat command', {
      command: parsed.command,
      owner: context.owner,
      repo: context.repo,
      prNumber: context.prNumber,
      commentId: context.commentId,
    });

    switch (parsed.command) {
      case 'review':
        return this.handleReview(parsed, context);
      case 'explain':
        return this.handleExplain(parsed, context);
      case 'fix':
      case 'refactor':
        return this.handleFix(parsed, context);
      case 'ignore':
      case 'mute':
        return this.handleIgnoreMute(parsed, context);
      case 'summarize':
        return this.handleSummarize(parsed, context);
      case 'ask':
        return this.handleAsk(parsed, context);
      case 'learn':
      case 'remember':
        return this.handleLearn(parsed, context);
      case 'forget':
        return this.handleForget(parsed, context);
      default:
        throw new Error(`Unsupported command: ${parsed.command}`);
    }
  }

  private async handleReview(_parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    if (context.onRunReviewPipeline && context.payload) {
      await context.onRunReviewPipeline(context.payload);
      return { command: 'review', success: true, message: 'Full panel code review pipeline triggered.' };
    }
    return { command: 'review', success: true, message: 'Review command parsed.' };
  }

  private async handleExplain(parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    let threadHistory = '';
    let diffContext = '';
    if (context.commentId) {
      const thread = await context.github.getReviewCommentThread(context.owner, context.repo, context.prNumber, context.commentId);
      if (thread.length > 0) {
        threadHistory = thread.map((c) => `${c.user?.login || 'User'}: ${c.body}`).join('\n');
        if (thread[0].diff_hunk) {
          diffContext = `Diff Hunk (${thread[0].path || 'file'}):\n${thread[0].diff_hunk}`;
        }
      }
    }

    if (!diffContext) {
      const files = await context.github.getChangedFiles(context.owner, context.repo, context.prNumber).catch(() => []);
      diffContext = files.map((f) => `File: ${f.path}\n${f.patch || ''}`).join('\n\n').slice(0, 4000);
    }

    let explanationText = '';
    const modelClient = context.modelClient;
    if (modelClient) {
      const prompt = `Please provide a concise architectural and security rationale explaining the following PR code changes / diff hunk for ${context.owner}/${context.repo} PR #${context.prNumber}.\n` +
        (parsed.args ? `Specific request: ${parsed.args}\n` : '') +
        (threadHistory ? `Thread History:\n${threadHistory}\n` : '') +
        `Context:\n${diffContext}`;
      try {
        const res = await modelClient.complete({
          model: this.defaultModel,
          messages: [
            { role: 'system', content: 'You are an expert PR reviewer and software architect explaining code changes, architectural rationale, and security implications concisely.' },
            { role: 'user', content: prompt },
          ],
          timeoutMs: 30_000,
        });
        explanationText = res.content;
      } catch {
        explanationText = `### Code Explanation\n\nExplanation of PR #${context.prNumber} changes:\n\n${diffContext.slice(0, 1000)}`;
      }
    } else {
      explanationText = `### Code Explanation\n\nExplanation of changes in PR #${context.prNumber}:\n\n${diffContext ? diffContext.slice(0, 1000) : 'Concise overview of PR diff hunks and changed modules.'}`;
    }

    const replyBody = explanationText.startsWith('###') ? explanationText : `### Code Explanation\n\n${explanationText}`;

    if (context.commentId) {
      await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, replyBody);
    } else {
      await context.github.postIssueComment(context.owner, context.repo, context.prNumber, replyBody);
    }

    return { command: 'explain', success: true, output: replyBody };
  }

  private async handleFix(parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    let threadHistory = '';
    let diffContext = '';
    if (context.commentId) {
      const thread = await context.github.getReviewCommentThread(context.owner, context.repo, context.prNumber, context.commentId);
      if (thread.length > 0) {
        threadHistory = thread.map((c) => `${c.user?.login || 'User'}: ${c.body}`).join('\n');
        if (thread[0].diff_hunk) {
          diffContext = `Diff Hunk (${thread[0].path || 'file'}):\n${thread[0].diff_hunk}`;
        }
      }
    }

    if (!diffContext) {
      const files = await context.github.getChangedFiles(context.owner, context.repo, context.prNumber).catch(() => []);
      diffContext = files.map((f) => `File: ${f.path}\n${f.patch || ''}`).join('\n\n').slice(0, 4000);
    }

    let refactorText = '';
    const modelClient = context.modelClient;
    if (modelClient) {
      const prompt = `Generate clean code suggestions and fixes with 1-click apply blocks (\`\`\`suggestion) for ${context.owner}/${context.repo} PR #${context.prNumber}.\n` +
        (parsed.args ? `Specific instructions: ${parsed.args}\n` : '') +
        (threadHistory ? `Thread History:\n${threadHistory}\n` : '') +
        `Context:\n${diffContext}`;
      try {
        const res = await modelClient.complete({
          model: this.defaultModel,
          messages: [
            { role: 'system', content: 'You are an expert PR reviewer providing clean code suggestions with ```suggestion blocks.' },
            { role: 'user', content: prompt },
          ],
          timeoutMs: 30_000,
        });
        refactorText = res.content;
      } catch {
        refactorText = parsed.command === 'fix'
          ? `### Code Fix Suggestion\n\nHere is a clean code fix suggestion:\n\n\`\`\`suggestion\n// Fixed code suggestion\n\`\`\``
          : `### Refactoring Suggestion\n\nHere is a clean refactoring suggestion:\n\n\`\`\`suggestion\n// Refactored code\n\`\`\``;
      }
    } else {
      refactorText = parsed.command === 'fix'
        ? `### Code Fix Suggestion\n\nHere is a clean code fix suggestion:\n\n\`\`\`suggestion\n// Fixed code suggestion\n\`\`\``
        : `### Refactoring Suggestion\n\nHere is a clean refactoring suggestion:\n\n\`\`\`suggestion\n// Refactored code suggestion\n\`\`\``;
    }

    const defaultHeading = parsed.command === 'fix' ? '### Code Fix Suggestion' : '### Refactoring Suggestion';
    let replyBody = refactorText.startsWith('###') ? refactorText : `${defaultHeading}\n\n${refactorText}`;
    if (!replyBody.includes('```suggestion')) {
      replyBody += `\n\n\`\`\`suggestion\n// Refactored code suggestion\n\`\`\``;
    }

    if (context.commentId) {
      await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, replyBody);
    } else {
      await context.github.postIssueComment(context.owner, context.repo, context.prNumber, replyBody);
    }

    return { command: parsed.command, success: true, output: replyBody };
  }

  private async handleRefactor(parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    return this.handleFix(parsed, context);
  }

  private async handleIgnoreMute(parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    let threadHistory: Array<ReviewComment> = [];
    if (context.commentId) {
      threadHistory = await context.github
        .getReviewCommentThread(context.owner, context.repo, context.prNumber, context.commentId)
        .catch(() => []);
    }

    const rootComment = threadHistory[0];
    const filePath = context.filePath || rootComment?.path || '**';

    let pattern = '';
    let reason = '';
    let ruleId: string | undefined;

    if (parsed.args) {
      if (parsed.args.toLowerCase().startsWith('rule:')) {
        const afterPrefix = parsed.args.slice(5).trim();
        const dashIndex = afterPrefix.indexOf(' - ');
        if (dashIndex !== -1) {
          ruleId = afterPrefix.slice(0, dashIndex).trim();
          pattern = ruleId;
          reason = afterPrefix.slice(dashIndex + 3).trim();
        } else {
          ruleId = afterPrefix.trim();
          pattern = ruleId;
          reason = parsed.command === 'mute' ? 'Muted rule via chat command' : 'Suppressed rule via chat command';
        }
      } else {
        const colonIndex = parsed.args.indexOf(': ');
        const dashIndex = parsed.args.indexOf(' - ');
        if (colonIndex !== -1 && (dashIndex === -1 || colonIndex < dashIndex)) {
          pattern = parsed.args.slice(0, colonIndex).trim();
          reason = parsed.args.slice(colonIndex + 2).trim();
        } else {
          const parts = parsed.args.split(/\s+-\s+/);
          if (parts.length > 1) {
            pattern = parts[0].trim();
            reason = parts.slice(1).join(' - ').trim();
          } else if (parsed.command === 'mute') {
            pattern = parsed.args.trim();
            ruleId = pattern;
            reason = 'Muted rule via chat command';
          } else {
            if (rootComment?.body) {
              const cleanTitle = rootComment.body
                .split('\n')[0]
                .replace(/^[#*`\s-]+/g, '')
                .replace(/[#*`\s-]+$/g, '')
                .replace(/^(?:P[0-3]|critical|major|minor):\s*/i, '')
                .trim();
              pattern = cleanTitle || parsed.args.trim();
              reason = parsed.args.trim();
            } else {
              pattern = parsed.args.trim();
              reason = 'Suppressed nit via chat command';
            }
          }
        }
      }
    } else {
      if (rootComment?.body) {
        const cleanTitle = rootComment.body
          .split('\n')[0]
          .replace(/^[#*`\s-]+/g, '')
          .replace(/[#*`\s-]+$/g, '')
          .replace(/^(?:P[0-3]|critical|major|minor):\s*/i, '')
          .trim();
        pattern = cleanTitle || 'Suppressed Nit';
      } else {
        pattern = 'Suppressed Nit';
      }
      reason = 'Suppressed via chat command';
    }

    const repoFull = `${context.owner}/${context.repo}`;
    const store = context.memoryStore || new PRMemoryStore();
    try {
      await store.recordResolvedNit(repoFull, context.prNumber, {
        pattern,
        filePath,
        reason,
        ruleId,
        headSha: context.headSha,
      });
    } finally {
      if (!context.memoryStore) {
        store.close();
      }
    }

    const replyBody = `### Finding Suppressed\n\nRecorded nit suppression rule in persistent team memory:\n- **Pattern**: \`${pattern}\`${ruleId ? `\n- **Rule ID**: \`${ruleId}\`` : ''}\n- **File Path**: \`${filePath}\`\n- **Reason**: ${reason}\n\nFuture reviews on this repository will automatically suppress this finding.`;

    if (context.commentId) {
      await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, replyBody);
    } else {
      await context.github.postIssueComment(context.owner, context.repo, context.prNumber, replyBody);
    }

    return { command: parsed.command, success: true, output: replyBody };
  }

  private async handleSummarize(_parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    const changedFiles = await context.github.getChangedFiles(context.owner, context.repo, context.prNumber);
    const diff = changedFiles
      .map((f) => (f.patch ? `diff --git a/${f.path} b/${f.path}\n${f.patch}` : f.path))
      .join('\n');

    const summaryMd = generatePRSummary(diff);
    const diagramMd = generateMermaidDiagram(diff);

    const parts = [
      '## Updated PR Summary',
      '',
      summaryMd,
    ];
    if (diagramMd) {
      parts.push('', '### Architecture Diagram', diagramMd);
    }

    const fullSummary = parts.join('\n');
    await context.github.postIssueComment(context.owner, context.repo, context.prNumber, fullSummary);

    return { command: 'summarize', success: true, output: fullSummary };
  }

  private async handleAsk(parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    const question = parsed.args;
    if (!question) {
      const errorMsg = 'Please provide a question after `@ct-review ask`. E.g., `@ct-review ask How does this handle error cases?`';
      if (context.commentId) {
        await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, errorMsg);
      } else {
        await context.github.postIssueComment(context.owner, context.repo, context.prNumber, errorMsg);
      }
      return { command: 'ask', success: false, output: errorMsg };
    }

    let threadHistory = '';
    let diffContext = '';
    if (context.commentId) {
      const thread = await context.github.getReviewCommentThread(context.owner, context.repo, context.prNumber, context.commentId);
      if (thread.length > 0) {
        threadHistory = thread.map((c) => `${c.user?.login || 'User'}: ${c.body}`).join('\n');
        if (thread[0].diff_hunk) {
          diffContext = `Diff Hunk (${thread[0].path || 'file'}):\n${thread[0].diff_hunk}`;
        }
      }
    }

    if (!diffContext) {
      const files = await context.github.getChangedFiles(context.owner, context.repo, context.prNumber).catch(() => []);
      diffContext = files.map((f) => `File: ${f.path}\n${f.patch || ''}`).join('\n\n').slice(0, 4000);
    }

    let answerText = '';
    const modelClient = context.modelClient;
    if (modelClient) {
      const prompt = `Answer user question about ${context.owner}/${context.repo} PR #${context.prNumber}.\n` +
        `Question: ${question}\n` +
        (threadHistory ? `Thread History:\n${threadHistory}\n` : '') +
        `Code Context:\n${diffContext}`;
      try {
        const res = await modelClient.complete({
          model: this.defaultModel,
          messages: [
            { role: 'system', content: 'You are an intelligent PR assistant answering developer questions about code changes.' },
            { role: 'user', content: prompt },
          ],
          timeoutMs: 30_000,
        });
        answerText = res.content;
      } catch {
        answerText = `Answer to question "${question}":\nBased on PR #${context.prNumber} changes in ${context.owner}/${context.repo}.`;
      }
    } else {
      answerText = `Answer to question "${question}":\nBased on PR #${context.prNumber} changes in ${context.owner}/${context.repo}.`;
    }

    const replyBody = answerText;

    if (context.commentId) {
      await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, replyBody);
    } else {
      await context.github.postIssueComment(context.owner, context.repo, context.prNumber, replyBody);
    }

    return { command: 'ask', success: true, output: replyBody };
  }

  private async handleLearn(parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    const reflectionParser = new ReflectionCommandParser();
    const parsedCmd = reflectionParser.parse(parsed.rawText, { filePath: context.filePath });
    if (!parsedCmd) {
      const errorMsg = 'Failed to parse `@ct-review learn` command. Usage:\n- `@ct-review learn convention: <title> - <description>`\n- `@ct-review learn nit <pattern> [reason]`\n- `@ct-review learn adr <adr_number>: <title> | <rule> | <target_paths>`';
      if (context.commentId) {
        await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, errorMsg);
      } else {
        await context.github.postIssueComment(context.owner, context.repo, context.prNumber, errorMsg);
      }
      return { command: 'learn', success: false, output: errorMsg };
    }

    const learningStore = new LearningStore(context.memoryStore);
    try {
      await learningStore.saveCommandLearning(`${context.owner}/${context.repo}`, context.prNumber, parsedCmd);
    } finally {
      if (!context.memoryStore) {
        learningStore.close();
      }
    }

    const replyBody = `### Team Memory Updated\n\nRecorded learning rule to repository persistent memory:\n- **Type**: \`${parsedCmd.type}\`\n- **Category**: \`${parsedCmd.category}\`\n- **Title**: ${parsedCmd.title}\n- **Details**: ${parsedCmd.description}`;

    if (context.commentId) {
      await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, replyBody);
    } else {
      await context.github.postIssueComment(context.owner, context.repo, context.prNumber, replyBody);
    }

    return { command: parsed.command, success: true, output: replyBody };
  }

  private async handleForget(parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
    const pattern = parsed.args.trim();
    if (!pattern) {
      const errorMsg = 'Please specify a pattern, rule title, or topic to forget. Usage:\n`@review-yeti forget <pattern>`';
      if (context.commentId) {
        await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, errorMsg);
      } else {
        await context.github.postIssueComment(context.owner, context.repo, context.prNumber, errorMsg);
      }
      return { command: 'forget', success: false, output: errorMsg };
    }

    const repoFull = `${context.owner}/${context.repo}`;
    const store = context.memoryStore || new PRMemoryStore();
    let deleted = false;
    try {
      deleted = await store.forgetPattern(repoFull, pattern);
    } finally {
      if (!context.memoryStore) {
        store.close();
      }
    }

    const replyBody = deleted
      ? `### Memory Removed\n\nPattern \`${pattern}\` has been removed from persistent team memory for \`${repoFull}\`. Future reviews will no longer enforce or suppress this finding.`
      : `### Memory Not Found\n\nNo matching memory rule or nit suppression found for pattern \`${pattern}\` in \`${repoFull}\`.`;

    if (context.commentId) {
      await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, replyBody);
    } else {
      await context.github.postIssueComment(context.owner, context.repo, context.prNumber, replyBody);
    }

    return { command: 'forget', success: true, output: replyBody };
  }
}

export const defaultDispatcher = new CommandDispatcher();

export function dispatchCommand(commandStr: string, context: ChatContext): Promise<DispatchResult> {
  return defaultDispatcher.dispatchCommand(commandStr, context);
}
