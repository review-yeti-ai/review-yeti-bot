import { PRMemoryStore, type ResolvedNitPattern, type ReviewerLearning } from './prMemoryStore';

export type ImplicitFeedbackKind = 'suppress_nit' | 'learn_convention' | 'none';

export interface ImplicitFeedbackClassification {
  kind: ImplicitFeedbackKind;
  confidence: number;
  reason: string;
}

export interface ImplicitFeedbackInput {
  repo: string;
  prNumber: number;
  commentBody?: string;
  reaction?: string;
  rootCommentBody?: string;
  filePath?: string;
  headSha?: string;
  ruleId?: string;
  memoryStore?: PRMemoryStore;
}

export interface ImplicitFeedbackResult {
  recorded: boolean;
  kind: ImplicitFeedbackKind;
  pattern?: string;
  learning?: ReviewerLearning;
  suppressedNit?: ResolvedNitPattern;
}

const CONVENTION_PATTERNS = [
  /\b(?:this\s+is\s+)?intentional\b/i,
  /\bby\s+design\b/i,
  /\bwe\s+(?:always|intentionally|deliberately)\b/i,
  /\bour\s+convention\b/i,
  /\bexpected\s+behavior\b/i,
];

const SUPPRESSION_PATTERNS = [
  /\bfalse\s+positive\b/i,
  /\bwon'?t\s*fix\b/i,
  /\bignore\s+this\b/i,
  /\bnot\s+a\s+bug\b/i,
  /\bnot\s+applicable\b/i,
];

export function extractFindingPatternFromComment(rawBody?: string): string {
  if (!rawBody || typeof rawBody !== 'string') {
    return 'Dismissed review finding';
  }
  const firstLine = rawBody
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('<!--'));
  if (!firstLine) return 'Dismissed review finding';

  return (
    firstLine
      .replace(/^[#*`\s>-]+/g, '')
      .replace(/[#*`\s]+$/g, '')
      .replace(/^\[?(?:P[0-3]|critical|high|medium|low|major|minor|nit)\]?:?\s*/i, '')
      .trim()
      .slice(0, 140) || 'Dismissed review finding'
  );
}

/**
 * Classifies whether a developer's inline reply or reaction on a PR comment
 * represents an implicit nit suppression or team convention learning.
 */
export function classifyImplicitPRFeedback(
  commentBody?: string,
  reaction?: string
): ImplicitFeedbackClassification {
  const normalizedReaction = (reaction || '').trim().toLowerCase();
  if (normalizedReaction === '-1' || normalizedReaction === '👎' || normalizedReaction === 'thumbs_down') {
    return {
      kind: 'suppress_nit',
      confidence: 0.9,
      reason: 'Developer reacted with thumbs-down (-1) on review comment',
    };
  }

  const text = (commentBody || '').trim();
  if (!text) {
    return { kind: 'none', confidence: 0, reason: 'Empty feedback' };
  }

  for (const regex of CONVENTION_PATTERNS) {
    if (regex.test(text)) {
      return {
        kind: 'learn_convention',
        confidence: 0.92,
        reason: text.slice(0, 240),
      };
    }
  }

  for (const regex of SUPPRESSION_PATTERNS) {
    if (regex.test(text)) {
      return {
        kind: 'suppress_nit',
        confidence: 0.88,
        reason: text.slice(0, 240),
      };
    }
  }

  return { kind: 'none', confidence: 0, reason: 'No implicit dismissal or convention signal detected' };
}

/**
 * Records implicit developer feedback from PR comment replies or reactions into PRMemoryStore.
 */
export async function recordImplicitPRFeedback(
  input: ImplicitFeedbackInput
): Promise<ImplicitFeedbackResult> {
  const classification = classifyImplicitPRFeedback(input.commentBody, input.reaction);
  if (classification.kind === 'none') {
    return { recorded: false, kind: 'none' };
  }

  const pattern = extractFindingPatternFromComment(input.rootCommentBody);
  const filePath = input.filePath || '**';
  const store = input.memoryStore || new PRMemoryStore();

  try {
    const suppressedNit = await store.recordResolvedNit(input.repo, input.prNumber, {
      pattern,
      filePath,
      reason: classification.reason,
      ruleId: input.ruleId,
      headSha: input.headSha,
    });

    let learning: ReviewerLearning | undefined;
    if (classification.kind === 'learn_convention') {
      learning = await store.recordLearning(input.repo, input.prNumber, {
        category: 'convention',
        title: `Implicit PR Convention: ${pattern}`,
        description: classification.reason,
        filePath,
        confidence: classification.confidence,
      });
    }

    return {
      recorded: true,
      kind: classification.kind,
      pattern,
      learning,
      suppressedNit,
    };
  } finally {
    if (!input.memoryStore) {
      store.close();
    }
  }
}
