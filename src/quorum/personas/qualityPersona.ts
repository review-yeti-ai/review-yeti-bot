import { Persona } from '../../config/schema';
import { IPersonaRunner, QuorumReviewContext, PersonaFinding } from './basePersona';
import { extractAndParseJSONFindings } from './parseHelper';

export class QualityPersonaRunner implements IPersonaRunner {
  public persona: Persona = 'quality';

  public getSystemPrompt(): string {
    return `You are a Senior Code Quality Lead focusing on code readability, maintainability, error handling, and style.
Analyze the provided PR diff for unhandled exceptions, dead code, poor variable naming, lack of test assertions, non-idiomatic style, and minor nitpicks.

Output ONLY a JSON array of findings matching this exact schema:
[
  {
    "filePath": "string",
    "lineNumber": number,
    "severity": "critical" | "major" | "minor" | "nit",
    "comment": "string describing code quality issue",
    "suggestion": "string detailing quality improvement",
    "ruleId": "QUAL-xxx",
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

    return `Review Pull Request #${context.prNumber} in ${context.repoOwner}/${context.repoName} for Code Quality & Readability.
PR Title: ${context.prTitle}
PR Description: ${context.prBody}

Diff Hunks:
${filesSummary}`;
  }

  public parseResponse(rawContent: string, context: QuorumReviewContext): PersonaFinding[] {
    return extractAndParseJSONFindings(rawContent, this.persona, context);
  }
}

export const qualityPersona = new QualityPersonaRunner();
