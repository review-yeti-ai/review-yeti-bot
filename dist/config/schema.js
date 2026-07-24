"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.codeRabbitConfigSchema = exports.ctReviewConfigSchema = exports.TicketProviderEnum = exports.EffortLevelEnum = exports.PersonaEnum = void 0;
const zod_1 = require("zod");
exports.PersonaEnum = zod_1.z.enum(['security', 'architecture', 'performance', 'quality']);
exports.EffortLevelEnum = zod_1.z.enum(['low', 'medium', 'high', 'reasoning']);
exports.TicketProviderEnum = zod_1.z.enum(['linear', 'jira', 'github']);
exports.ctReviewConfigSchema = zod_1.z.object({
    version: zod_1.z.string().default('1.0'),
    quorum: zod_1.z.object({
        minApprovals: zod_1.z.number().int().min(1, 'minApprovals must be at least 1').default(2),
        personas: zod_1.z.array(exports.PersonaEnum).min(1, 'At least one persona is required').default([
            'security',
            'architecture',
            'performance',
            'quality',
        ]),
        effortLevel: exports.EffortLevelEnum.default('medium'),
    }).default({}),
    ticketEnforcement: zod_1.z.object({
        required: zod_1.z.boolean().default(true),
        providers: zod_1.z.array(exports.TicketProviderEnum).min(1, 'At least one ticket provider must be specified when ticket enforcement is enabled').default(['linear', 'jira', 'github']),
        patterns: zod_1.z.array(zod_1.z.string()).default([]),
    }).default({}),
    constitution: zod_1.z.object({
        enabled: zod_1.z.boolean().default(true),
        path: zod_1.z.string().default('.github/constitution.md'),
    }).default({}),
});
exports.codeRabbitConfigSchema = zod_1.z.object({
    language: zod_1.z.string().optional(),
    early_access: zod_1.z.boolean().optional(),
    reviews: zod_1.z.object({
        profile: zod_1.z.string().optional(),
        request_tools: zod_1.z.array(zod_1.z.string()).optional(),
        high_level_summary: zod_1.z.boolean().optional(),
        auto_review: zod_1.z.object({
            enabled: zod_1.z.boolean().optional(),
            drafts: zod_1.z.boolean().optional(),
        }).optional(),
    }).optional(),
    chat: zod_1.z.object({
        auto_reply: zod_1.z.boolean().optional(),
    }).optional(),
});
//# sourceMappingURL=schema.js.map