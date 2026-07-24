"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.securityPersona = exports.SecurityPersonaRunner = void 0;
const parseHelper_1 = require("./parseHelper");
class SecurityPersonaRunner {
    persona = 'security';
    getSystemPrompt() {
        return `You are a Senior Security Auditor specializing in enterprise code security analysis.
Analyze the provided PR diff for security vulnerabilities, OWASP Top 10 risks, hardcoded credentials, secret leaks, injection flaws (SQLi, Command, XSS), unsafe deserialization, authentication/authorization errors, and weak cryptography.

Output ONLY a JSON array of findings matching this exact schema:
[
  {
    "filePath": "string",
    "lineNumber": number,
    "severity": "critical" | "major" | "minor" | "nit",
    "comment": "string describing the security vulnerability",
    "suggestion": "string detailing remediation code or fix",
    "ruleId": "SEC-xxx",
    "codeSnippet": "string containing affected code snippet"
  }
]
Do not include any conversational preamble or markdown explanations outside the JSON array.`;
    }
    buildUserPrompt(context) {
        const filesSummary = context.diffFiles
            .map((f) => `--- File: ${f.filePath} ---\n${f.patch || f.content || 'No diff patch available'}`)
            .join('\n\n');
        return `Review Pull Request #${context.prNumber} in ${context.repoOwner}/${context.repoName} for Security Vulnerabilities.
PR Title: ${context.prTitle}
PR Description: ${context.prBody}

Diff Hunks:
${filesSummary}`;
    }
    parseResponse(rawContent, context) {
        return (0, parseHelper_1.extractAndParseJSONFindings)(rawContent, this.persona, context);
    }
}
exports.SecurityPersonaRunner = SecurityPersonaRunner;
exports.securityPersona = new SecurityPersonaRunner();
//# sourceMappingURL=securityPersona.js.map