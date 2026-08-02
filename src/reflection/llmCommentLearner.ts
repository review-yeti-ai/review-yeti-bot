import { OpenRouterClient, ReviewModelClient } from '../gateway/openRouterClient';
import { PRMemoryStore } from '../memory/prMemoryStore';
import { PlatformMemoryStore } from '../memory/platformMemoryStore';
import { logger } from '../utils/logger';

export type LLMCommentCategory = 'FALSE_POSITIVE_CORRECTION' | 'NEW_CONVENTION' | 'CLARIFICATION_DEFENSE' | 'REJECTED_SUGGESTION' | 'REFUTATION' | 'GENERAL_COMMENT';
export type CommentFeedbackType = LLMCommentCategory;

export interface CommentJudgmentResult {
  intent: LLMCommentCategory;
  learnedRule?: {
    category: 'security' | 'architecture' | 'performance' | 'convention' | 'quality';
    pattern: string;
    rule: string;
    suppressMatchingNits: boolean;
  };
  githubReaction?: '+1' | '-1' | 'rocket' | 'eyes' | 'confused' | 'laugh' | 'heart';
  suggestedReply?: string;
}

export interface CommentInputContext {
  owner: string;
  repo: string;
  prNumber: number;
  commentBody: string;
  sender: string;
  filePath?: string;
  lineNumber?: number;
  diffHunk?: string;
  originalFindingBody?: string;
  diffSnippet?: string;
  codeSemantics?: string;
}

export class LLMCommentLearner {
  private client: ReviewModelClient;
  private prMemoryStore: PRMemoryStore;
  private platformMemoryStore: PlatformMemoryStore;

  constructor(client?: ReviewModelClient, prStore?: PRMemoryStore, platformStore?: PlatformMemoryStore) {
    this.client = client || new OpenRouterClient();
    this.prMemoryStore = prStore || new PRMemoryStore();
    this.platformMemoryStore = platformStore || new PlatformMemoryStore();
  }

  /**
   * Evaluates user PR comment/reply feedback using LLM judgment, extracts learned rules,
   * updates repository memory, and returns GitHub reaction/reply actions.
   */
  public async processCommentWithJudgment(context: CommentInputContext): Promise<CommentJudgmentResult> {
    const fullRepo = `${context.owner}/${context.repo}`;
    logger.info('Processing user comment with LLM Judgment Engine', { repo: fullRepo, prNumber: context.prNumber, sender: context.sender });

    const systemPrompt = `You are an AI code review feedback judgment engine for repo ${fullRepo}.
Your job is to analyze user feedback on PR code reviews and determine if the user is:
1. FALSE_POSITIVE_CORRECTION: Correcting a false positive or nitpicking bot behavior.
2. NEW_CONVENTION: Establishing or explaining a team code convention / architectural rule.
3. CLARIFICATION_DEFENSE: Explaining why code was written a specific way.
4. REJECTED_SUGGESTION: Rejecting a bot suggestion.
5. REFUTATION: Refuting a bot review finding.
6. GENERAL_COMMENT: General PR conversation.

Respond ONLY with valid JSON matching:
{
  "intent": "FALSE_POSITIVE_CORRECTION | NEW_CONVENTION | CLARIFICATION_DEFENSE | REJECTED_SUGGESTION | REFUTATION | GENERAL_COMMENT",
  "learnedRule": {
    "category": "security | architecture | performance | convention | quality",
    "pattern": "short pattern or keywords to match in future findings",
    "rule": "detailed description of what was learned",
    "suppressMatchingNits": true
  },
  "githubReaction": "+1 | -1 | rocket | eyes | confused | laugh | heart",
  "suggestedReply": "optional short polite acknowledgment reply or null"
}`;

    const userPrompt = `User Feedback Comment: "${context.commentBody}"
Sender: ${context.sender}
File Path: ${context.filePath || 'Unknown'} ${context.lineNumber ? `(Line ${context.lineNumber})` : ''}

${context.originalFindingBody ? `Original Bot Review Concern / Finding:\n"${context.originalFindingBody}"\n` : ''}
${context.diffHunk || context.diffSnippet ? `Surrounding Code & Diff Hunk:\n\`\`\`\n${context.diffHunk || context.diffSnippet}\n\`\`\`\n` : ''}
${context.codeSemantics ? `Code Semantics & AST Context:\n"${context.codeSemantics}"\n` : ''}`;

    let judgment: CommentJudgmentResult = {
      intent: 'GENERAL_COMMENT',
      githubReaction: '+1',
    };

    try {
      const response = await this.client.complete({
        model: 'openrouter/auto',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        timeoutMs: 15_000,
      });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsedJson = JSON.parse(jsonMatch[0]);
        const rawIntent = String(parsedJson.intent || 'GENERAL_COMMENT').toUpperCase();
        let intent: LLMCommentCategory = 'GENERAL_COMMENT';
        if (rawIntent.includes('REJECT')) {
          intent = 'REJECTED_SUGGESTION';
        } else if (rawIntent.includes('REFUT')) {
          intent = 'REFUTATION';
        } else if (rawIntent.includes('FALSE')) {
          intent = 'FALSE_POSITIVE_CORRECTION';
        } else if (rawIntent.includes('CONVENTION')) {
          intent = 'NEW_CONVENTION';
        } else if (rawIntent.includes('DEFENSE') || rawIntent.includes('CLARIF')) {
          intent = 'CLARIFICATION_DEFENSE';
        }
        const isRefusal = intent === 'FALSE_POSITIVE_CORRECTION' || intent === 'REJECTED_SUGGESTION' || intent === 'REFUTATION';
        judgment = {
          intent,
          learnedRule: parsedJson.learnedRule || (isRefusal ? {
            category: 'convention',
            pattern: context.commentBody.slice(0, 40),
            rule: context.commentBody,
            suppressMatchingNits: true,
          } : undefined),
          githubReaction: parsedJson.githubReaction || '+1',
          suggestedReply: parsedJson.suggestedReply || undefined,
        };
      }
    } catch (err: any) {
      logger.warn('LLM judgment parsing fallback to rule-based fallback', { error: err?.message });
      const bodyLower = context.commentBody.toLowerCase();
      if (bodyLower.includes('false positive') || bodyLower.includes('ignore') || bodyLower.includes('nit') || bodyLower.includes('refus') || bodyLower.includes('refutat') || bodyLower.includes('wrong') || bodyLower.includes('incorrect') || bodyLower.includes('not a bug') || bodyLower.includes('unnecessary')) {
        judgment = {
          intent: 'FALSE_POSITIVE_CORRECTION',
          learnedRule: {
            category: 'convention',
            pattern: context.commentBody.slice(0, 40),
            rule: context.commentBody,
            suppressMatchingNits: true,
          },
          githubReaction: '+1',
          suggestedReply: 'Understood, noted as false positive and updated repository memory.',
        };
      }
    }

    if (judgment.learnedRule || judgment.intent === 'FALSE_POSITIVE_CORRECTION' || judgment.intent === 'REJECTED_SUGGESTION' || judgment.intent === 'REFUTATION') {
      const { category, pattern, rule, suppressMatchingNits } = judgment.learnedRule || {
        category: 'convention',
        pattern: context.commentBody.slice(0, 40),
        rule: context.commentBody,
        suppressMatchingNits: true,
      };
      if (suppressMatchingNits !== false) {
        await this.prMemoryStore.recordResolvedNit(fullRepo, context.prNumber, {
          pattern: pattern || context.commentBody.slice(0, 30),
          filePath: '**',
          reason: rule || `Learned from user comment: ${context.commentBody}`,
        });
        logger.info('Persisted learned nit suppression pattern', { repo: fullRepo, pattern });
      }

      const mappedCategory: any = category === 'quality' ? 'convention' : (category || 'convention');
      await this.prMemoryStore.recordLearning(fullRepo, context.prNumber, {
        category: mappedCategory,
        title: pattern || 'Learned Team Rule',
        description: rule || context.commentBody,
      });

      await this.platformMemoryStore.recordPlatformPattern(
        category === 'convention' ? 'quality' : category,
        pattern || 'Learned Team Rule',
        rule || context.commentBody,
        fullRepo
      );
    }

    return judgment;
  }
}
