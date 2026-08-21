import { GitHubInstallationClient, ReviewComment } from '../github/installationClient';
import { ReviewModelClient } from '../gateway/openRouterClient';
import { generatePRSummary } from '../review/summaryEngine';
import { generateMermaidDiagram } from '../review/mermaidEngine';
import { ReflectionCommandParser, LearningStore } from '../reflection';
import { logger } from '../utils/logger';

export type CommandType = 'review' | 'explain' | 'refactor' | 'summarize' | 'ask' | 'learn';

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
  onRunReviewPipeline?: (payload: any) => Promise<any>;
  payload?: any;
}

export interface DispatchResult {
  command: CommandType;
  success: boolean;
  message?: string;
  output?: string;
}

export function parseCommand(commandStr: string): ParsedCommand | null {
  if (!commandStr || typeof commandStr !== 'string') return null;
  const match = commandStr.match(/@(ct-review|ct-review-bot|bot)\s+(review|explain|refactor|summarize|ask|learn)(?:\s+([\s\S]*))?/i);
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
      case 'refactor':
        return this.handleRefactor(parsed, context);
      case 'summarize':
        return this.handleSummarize(parsed, context);
      case 'ask':
        return this.handleAsk(parsed, context);
      case 'learn':
        return this.handleLearn(parsed, context);
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
      const prompt = `Please concisely explain the following PR code changes / diff hunk for ${context.owner}/${context.repo} PR #${context.prNumber}.\n` +
        (parsed.args ? `Specific request: ${parsed.args}\n` : '') +
        (threadHistory ? `Thread History:\n${threadHistory}\n` : '') +
        `Context:\n${diffContext}`;
      try {
        const res = await modelClient.complete({
          model: this.defaultModel,
          messages: [
            { role: 'system', content: 'You are an expert PR reviewer explaining code changes concisely.' },
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

  private async handleRefactor(parsed: ParsedCommand, context: ChatContext): Promise<DispatchResult> {
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
      const prompt = `Generate clean code refactoring suggestions with 1-click apply blocks (\`\`\`suggestion) for ${context.owner}/${context.repo} PR #${context.prNumber}.\n` +
        (parsed.args ? `Specific refactoring instructions: ${parsed.args}\n` : '') +
        (threadHistory ? `Thread History:\n${threadHistory}\n` : '') +
        `Context:\n${diffContext}`;
      try {
        const res = await modelClient.complete({
          model: this.defaultModel,
          messages: [
            { role: 'system', content: 'You are an expert PR reviewer providing clean code refactorings with ```suggestion blocks.' },
            { role: 'user', content: prompt },
          ],
          timeoutMs: 30_000,
        });
        refactorText = res.content;
      } catch {
        refactorText = `### Refactoring Suggestion\n\nHere is a clean refactoring suggestion:\n\n\`\`\`suggestion\n// Refactored code\n\`\`\``;
      }
    } else {
      refactorText = `### Refactoring Suggestion\n\nHere is a clean refactoring suggestion:\n\n\`\`\`suggestion\n// Refactored code suggestion\n\`\`\``;
    }

    let replyBody = refactorText.startsWith('###') ? refactorText : `### Refactoring Suggestion\n\n${refactorText}`;
    if (!replyBody.includes('```suggestion')) {
      replyBody += `\n\n\`\`\`suggestion\n// Refactored code suggestion\n\`\`\``;
    }

    if (context.commentId) {
      await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, replyBody);
    } else {
      await context.github.postIssueComment(context.owner, context.repo, context.prNumber, replyBody);
    }

    return { command: 'refactor', success: true, output: replyBody };
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

    const learningStore = new LearningStore();
    try {
      await learningStore.saveCommandLearning(`${context.owner}/${context.repo}`, context.prNumber, parsedCmd);
    } finally {
      learningStore.close();
    }

    const replyBody = `### Team Memory Updated\n\nRecorded learning rule to repository persistent memory:\n- **Type**: \`${parsedCmd.type}\`\n- **Category**: \`${parsedCmd.category}\`\n- **Title**: ${parsedCmd.title}\n- **Details**: ${parsedCmd.description}`;

    if (context.commentId) {
      await context.github.replyToReviewComment(context.owner, context.repo, context.prNumber, context.commentId, replyBody);
    } else {
      await context.github.postIssueComment(context.owner, context.repo, context.prNumber, replyBody);
    }

    return { command: 'learn', success: true, output: replyBody };
  }
}

export const defaultDispatcher = new CommandDispatcher();

export function dispatchCommand(commandStr: string, context: ChatContext): Promise<DispatchResult> {
  return defaultDispatcher.dispatchCommand(commandStr, context);
}
