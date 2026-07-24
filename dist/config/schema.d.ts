import { z } from 'zod';
export declare const PersonaEnum: z.ZodEnum<["security", "architecture", "performance", "quality"]>;
export type Persona = z.infer<typeof PersonaEnum>;
export declare const EffortLevelEnum: z.ZodEnum<["low", "medium", "high", "reasoning"]>;
export type EffortLevel = z.infer<typeof EffortLevelEnum>;
export declare const TicketProviderEnum: z.ZodEnum<["linear", "jira", "github"]>;
export type TicketProvider = z.infer<typeof TicketProviderEnum>;
export declare const ctReviewConfigSchema: z.ZodObject<{
    version: z.ZodDefault<z.ZodString>;
    quorum: z.ZodDefault<z.ZodObject<{
        minApprovals: z.ZodDefault<z.ZodNumber>;
        personas: z.ZodDefault<z.ZodArray<z.ZodEnum<["security", "architecture", "performance", "quality"]>, "many">>;
        effortLevel: z.ZodDefault<z.ZodEnum<["low", "medium", "high", "reasoning"]>>;
    }, "strip", z.ZodTypeAny, {
        minApprovals: number;
        personas: ("security" | "architecture" | "performance" | "quality")[];
        effortLevel: "low" | "medium" | "high" | "reasoning";
    }, {
        minApprovals?: number | undefined;
        personas?: ("security" | "architecture" | "performance" | "quality")[] | undefined;
        effortLevel?: "low" | "medium" | "high" | "reasoning" | undefined;
    }>>;
    ticketEnforcement: z.ZodDefault<z.ZodObject<{
        required: z.ZodDefault<z.ZodBoolean>;
        providers: z.ZodDefault<z.ZodArray<z.ZodEnum<["linear", "jira", "github"]>, "many">>;
        patterns: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        required: boolean;
        providers: ("linear" | "jira" | "github")[];
        patterns: string[];
    }, {
        required?: boolean | undefined;
        providers?: ("linear" | "jira" | "github")[] | undefined;
        patterns?: string[] | undefined;
    }>>;
    constitution: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        path: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        path: string;
        enabled: boolean;
    }, {
        path?: string | undefined;
        enabled?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    version: string;
    quorum: {
        minApprovals: number;
        personas: ("security" | "architecture" | "performance" | "quality")[];
        effortLevel: "low" | "medium" | "high" | "reasoning";
    };
    ticketEnforcement: {
        required: boolean;
        providers: ("linear" | "jira" | "github")[];
        patterns: string[];
    };
    constitution: {
        path: string;
        enabled: boolean;
    };
}, {
    version?: string | undefined;
    quorum?: {
        minApprovals?: number | undefined;
        personas?: ("security" | "architecture" | "performance" | "quality")[] | undefined;
        effortLevel?: "low" | "medium" | "high" | "reasoning" | undefined;
    } | undefined;
    ticketEnforcement?: {
        required?: boolean | undefined;
        providers?: ("linear" | "jira" | "github")[] | undefined;
        patterns?: string[] | undefined;
    } | undefined;
    constitution?: {
        path?: string | undefined;
        enabled?: boolean | undefined;
    } | undefined;
}>;
export type CtReviewConfig = z.infer<typeof ctReviewConfigSchema>;
export declare const codeRabbitConfigSchema: z.ZodObject<{
    language: z.ZodOptional<z.ZodString>;
    early_access: z.ZodOptional<z.ZodBoolean>;
    reviews: z.ZodOptional<z.ZodObject<{
        profile: z.ZodOptional<z.ZodString>;
        request_tools: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        high_level_summary: z.ZodOptional<z.ZodBoolean>;
        auto_review: z.ZodOptional<z.ZodObject<{
            enabled: z.ZodOptional<z.ZodBoolean>;
            drafts: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            enabled?: boolean | undefined;
            drafts?: boolean | undefined;
        }, {
            enabled?: boolean | undefined;
            drafts?: boolean | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        profile?: string | undefined;
        request_tools?: string[] | undefined;
        high_level_summary?: boolean | undefined;
        auto_review?: {
            enabled?: boolean | undefined;
            drafts?: boolean | undefined;
        } | undefined;
    }, {
        profile?: string | undefined;
        request_tools?: string[] | undefined;
        high_level_summary?: boolean | undefined;
        auto_review?: {
            enabled?: boolean | undefined;
            drafts?: boolean | undefined;
        } | undefined;
    }>>;
    chat: z.ZodOptional<z.ZodObject<{
        auto_reply: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        auto_reply?: boolean | undefined;
    }, {
        auto_reply?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    language?: string | undefined;
    early_access?: boolean | undefined;
    reviews?: {
        profile?: string | undefined;
        request_tools?: string[] | undefined;
        high_level_summary?: boolean | undefined;
        auto_review?: {
            enabled?: boolean | undefined;
            drafts?: boolean | undefined;
        } | undefined;
    } | undefined;
    chat?: {
        auto_reply?: boolean | undefined;
    } | undefined;
}, {
    language?: string | undefined;
    early_access?: boolean | undefined;
    reviews?: {
        profile?: string | undefined;
        request_tools?: string[] | undefined;
        high_level_summary?: boolean | undefined;
        auto_review?: {
            enabled?: boolean | undefined;
            drafts?: boolean | undefined;
        } | undefined;
    } | undefined;
    chat?: {
        auto_reply?: boolean | undefined;
    } | undefined;
}>;
export type CodeRabbitConfig = z.infer<typeof codeRabbitConfigSchema>;
