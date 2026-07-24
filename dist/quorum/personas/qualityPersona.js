"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.qualityPersona = exports.QualityPersonaRunner = void 0;
const parseHelper_1 = require("./parseHelper");
class QualityPersonaRunner {
    persona = 'quality';
    getSystemPrompt() {
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
    buildUserPrompt(context) {
        const filesSummary = context.diffFiles
            .map((f) => `--- File: ${f.filePath} ---\n${f.patch || f.content || 'No diff patch available'}`)
            .join('\n\n');
        return `Review Pull Request #${context.prNumber} in ${context.repoOwner}/${context.repoName} for Code Quality & Readability.
PR Title: ${context.prTitle}
PR Description: ${context.prBody}

Diff Hunks:
${filesSummary}`;
    }
    parseResponse(rawContent, context) {
        return (0, parseHelper_1.extractAndParseJSONFindings)(rawContent, this.persona, context);
    }
}
exports.QualityPersonaRunner = QualityPersonaRunner;
exports.qualityPersona = new QualityPersonaRunner();
//# sourceMappingURL=qualityPersona.js.map