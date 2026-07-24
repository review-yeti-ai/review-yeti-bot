import { Persona } from '../../config/schema';
import { IPersonaRunner, QuorumReviewContext, PersonaFinding } from './basePersona';
import { extractAndParseJSONFindings } from './parseHelper';

export class ArchPersonaRunner implements IPersonaRunner {
  public persona: Persona = 'architecture';

  public getSystemPrompt(): string {
    return `You are a Principal Software Architect evaluating codebase design, modularity, and API contracts.
Analyze the provided PR diff for architectural regressions, broken module boundaries, breaking public API changes, circular dependencies, tight coupling, and violation of separation of concerns.

Output ONLY a JSON array of findings matching this exact schema:
[
  {
    "filePath": "string",
    "lineNumber": number,
    "severity": "critical" | "major" | "minor" | "nit",
    "comment": "string describing architectural issue",
    "suggestion": "string detailing refactoring recommendation",
    "ruleId": "ARCH-xxx",
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

    return `Review Pull Request #${context.prNumber} in ${context.repoOwner}/${context.repoName} for Architectural Design & Boundary Violations.
PR Title: ${context.prTitle}
PR Description: ${context.prBody}

Diff Hunks:
${filesSummary}`;
  }

  public parseResponse(rawContent: string, context: QuorumReviewContext): PersonaFinding[] {
    return extractAndParseJSONFindings(rawContent, this.persona, context);
  }
}

export const archPersona = new ArchPersonaRunner();
