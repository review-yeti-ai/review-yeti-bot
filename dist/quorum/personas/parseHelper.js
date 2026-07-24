"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractAndParseJSONFindings = extractAndParseJSONFindings;
function extractAndParseJSONFindings(rawContent, persona, context) {
    if (!rawContent || typeof rawContent !== 'string') {
        return [];
    }
    let jsonText = rawContent.trim();
    // Try extracting markdown json code block
    const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
    }
    else {
        // Attempt finding first '[' and last ']'
        const firstBracket = jsonText.indexOf('[');
        const lastBracket = jsonText.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket > firstBracket) {
            jsonText = jsonText.substring(firstBracket, lastBracket + 1);
        }
    }
    let parsedArray = [];
    try {
        const rawParsed = JSON.parse(jsonText);
        if (Array.isArray(rawParsed)) {
            parsedArray = rawParsed;
        }
        else if (rawParsed && typeof rawParsed === 'object') {
            if (Array.isArray(rawParsed.findings)) {
                parsedArray = rawParsed.findings;
            }
            else if (Array.isArray(rawParsed.items)) {
                parsedArray = rawParsed.items;
            }
            else if (Array.isArray(rawParsed.results)) {
                parsedArray = rawParsed.results;
            }
        }
    }
    catch (err) {
        // JSON parse failed; return empty findings cleanly without crashing
        return [];
    }
    const defaultFilePath = context?.diffFiles[0]?.filePath || 'src/index.ts';
    return parsedArray
        .map((item) => {
        if (!item || typeof item !== 'object')
            return null;
        const rawSev = String(item.severity || '').toLowerCase();
        const severity = [
            'critical',
            'major',
            'minor',
            'nit',
        ].includes(rawSev)
            ? rawSev
            : 'minor';
        const filePath = item.filePath ? String(item.filePath).trim() : defaultFilePath;
        const lineNumber = typeof item.lineNumber === 'number' && item.lineNumber >= 1
            ? item.lineNumber
            : typeof item.startLine === 'number' && item.startLine >= 1
                ? item.startLine
                : 1;
        const endLineNumber = typeof item.endLineNumber === 'number' && item.endLineNumber >= lineNumber
            ? item.endLineNumber
            : typeof item.endLine === 'number' && item.endLine >= lineNumber
                ? item.endLine
                : lineNumber;
        const comment = String(item.comment || item.description || item.message || '').trim();
        if (!comment)
            return null;
        const suggestion = item.suggestion ? String(item.suggestion).trim() : undefined;
        const ruleId = item.ruleId ? String(item.ruleId).trim() : undefined;
        const codeSnippet = item.codeSnippet
            ? String(item.codeSnippet).trim()
            : suggestion || '';
        return {
            persona: (item.persona && ['security', 'architecture', 'performance', 'quality'].includes(item.persona.toLowerCase()))
                ? item.persona.toLowerCase()
                : persona,
            severity,
            filePath,
            lineNumber,
            endLineNumber,
            comment,
            suggestion,
            ruleId,
            codeSnippet,
        };
    })
        .filter((f) => f !== null);
}
//# sourceMappingURL=parseHelper.js.map