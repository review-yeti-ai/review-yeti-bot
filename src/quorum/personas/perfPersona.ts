import { Persona } from '../../config/schema';
import { IPersonaRunner, QuorumReviewContext, PersonaFinding } from './basePersona';
import { extractAndParseJSONFindings } from './parseHelper';

export class PerfPersonaRunner implements IPersonaRunner {
  public persona: Persona = 'performance';

  public getSystemPrompt(): string {
    return `You are a Performance Optimization Engineer analyzing runtime speed, memory usage, and concurrency.
Analyze the provided PR diff for efficiency bottlenecks, N+1 query patterns, unthrottled inner loop allocations, memory leaks, blocking synchronous operations, and inefficient algorithmic complexity.

Output ONLY a JSON array of findings matching this exact schema:
[
  {
    "filePath": "string",
    "lineNumber": number,
    "severity": "critical" | "major" | "minor" | "nit",
    "comment": "string describing performance issue",
    "suggestion": "string detailing performance optimization fix",
    "ruleId": "PERF-xxx",
    "codeSnippet": "string containing affected code snippet"
  }
]
Do not include any conversational preamble or markdown explanations outside the JSON array.`;
  }

  public buildUserPrompt(context: QuorumReviewContext): string {
    const filesSummary = context.diffFiles
      .map(
        (f) =>
          `--- File: ${f.filePath} ---\n${
            f.patch || f.content || 'No diff patch available'
          }`
      )
      .join('\n\n');

    return `Review Pull Request #${context.prNumber} in ${context.repoOwner}/${context.repoName} for Performance & Runtime Efficiency Issues.
PR Title: ${context.prTitle}
PR Description: ${context.prBody}

Diff Hunks:
${filesSummary}`;
  }

  public parseResponse(rawContent: string, context: QuorumReviewContext): PersonaFinding[] {
    return extractAndParseJSONFindings(rawContent, this.persona, context);
  }
}

export const perfPersona = new PerfPersonaRunner();
