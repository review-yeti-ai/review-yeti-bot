"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffHashUtil = void 0;
exports.normalizeSnippet = normalizeSnippet;
exports.normalizeComment = normalizeComment;
exports.computeHunkHash = computeHunkHash;
exports.computeFindingHash = computeFindingHash;
const crypto_1 = __importDefault(require("crypto"));
function normalizeSnippet(snippet) {
    if (!snippet)
        return '';
    return snippet
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .join('\n');
}
function normalizeComment(comment) {
    if (!comment)
        return '';
    return comment
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
function computeHunkHash(input) {
    const normalizedContent = (input.hunkContent || '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n');
    const rawString = `${input.filePath}\n${normalizedContent}`;
    return crypto_1.default.createHash('sha256').update(rawString, 'utf8').digest('hex');
}
function computeFindingHash(input) {
    const normalizedCode = normalizeSnippet(input.codeSnippet);
    const keyId = input.findingId || input.ruleId;
    const normalizedSummary = keyId
        ? normalizeComment(keyId)
        : normalizeComment(input.comment);
    const rawString = `${input.filePath}|${input.persona.toLowerCase()}|${normalizedCode}|${normalizedSummary}`;
    return crypto_1.default.createHash('sha256').update(rawString, 'utf8').digest('hex');
}
exports.diffHashUtil = {
    computeHunkHash,
    computeFindingHash,
    normalizeSnippet,
    normalizeComment
};
//# sourceMappingURL=diffHash.js.map