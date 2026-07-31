import { describe, it, expect, vi } from 'vitest';
import { LLMCommentLearner } from '../../src/reflection/llmCommentLearner';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { PlatformMemoryStore } from '../../src/memory/platformMemoryStore';

describe('LLMCommentLearner — LLM Feedback & Behavioral Judgment Engine', () => {
  it('processes user false positive correction and records nit pattern', async () => {
    const mockOmniClient = {
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          intent: 'FALSE_POSITIVE_CORRECTION',
          learnedRule: {
            category: 'convention',
            pattern: 'avoid console.log',
            rule: 'console.log is allowed in debug logger module',
            suppressMatchingNits: true,
          },
          githubReaction: '+1',
          suggestedReply: 'Noted, console.log is permitted in debug logger module.',
        }),
      }),
    } as any;

    const prStore = new PRMemoryStore(':memory:');
    const platformStore = new PlatformMemoryStore(':memory:');

    const learner = new LLMCommentLearner(mockOmniClient, prStore, platformStore);

    const result = await learner.processCommentWithJudgment({
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      prNumber: 3056,
      commentBody: 'Please ignore console.log warnings in debug logger file',
      sender: 'jasonbarbee',
      filePath: 'src/utils/debugLogger.ts',
      lineNumber: 42,
      diffHunk: '@@ -40,5 +40,5 @@\n+ console.log("[DEBUG]", message);\n',
      originalFindingBody: 'P2 Finding: Avoid console.log statements in production code.',
      codeSemantics: 'export function logDebugMessage(message: string)',
    });

    expect(result.intent).toBe('FALSE_POSITIVE_CORRECTION');
    expect(result.githubReaction).toBe('+1');
    expect(result.learnedRule?.pattern).toBe('avoid console.log');

    const memory = await prStore.queryLearnings('calltelemetry/cisco-cdr');
    expect(memory.resolvedNits.length).toBeGreaterThanOrEqual(1);
    expect(memory.resolvedNits[0].pattern).toBe('avoid console.log');

    // Verify OmniClient received full 360° context in prompt
    const promptArg = mockOmniClient.complete.mock.calls[0][0].messages[1].content;
    expect(promptArg).toContain('File Path: src/utils/debugLogger.ts (Line 42)');
    expect(promptArg).toContain('Original Bot Review Concern / Finding:');
    expect(promptArg).toContain('Surrounding Code & Diff Hunk:');
    expect(promptArg).toContain('Code Semantics & AST Context:');

    prStore.close();
    platformStore.close();
  });
});
