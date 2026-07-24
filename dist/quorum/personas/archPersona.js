"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.archPersona = exports.ArchPersonaRunner = void 0;
const parseHelper_1 = require("./parseHelper");
class ArchPersonaRunner {
    persona = 'architecture';
    getSystemPrompt() {
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
    buildUserPrompt(context) {
        const filesSummary = context.diffFiles
            .map((f) => `--- File: ${f.filePath} ---\n${f.patch || f.content || 'No diff patch available'}`)
            .join('\n\n');
        return `Review Pull Request #${context.prNumber} in ${context.repoOwner}/${context.repoName} for Architectural Design & Boundary Violations.
PR Title: ${context.prTitle}
PR Description: ${context.prBody}

Diff Hunks:
${filesSummary}`;
    }
    parseResponse(rawContent, context) {
        return (0, parseHelper_1.extractAndParseJSONFindings)(rawContent, this.persona, context);
    }
}
exports.ArchPersonaRunner = ArchPersonaRunner;
exports.archPersona = new ArchPersonaRunner();
//# sourceMappingURL=archPersona.js.map