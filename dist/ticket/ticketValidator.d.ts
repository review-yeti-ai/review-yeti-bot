import { CtReviewConfig } from '../config/schema';
export interface TicketValidationInput {
    title: string;
    body: string;
    config: CtReviewConfig['ticketEnforcement'];
}
export interface TicketValidationResult {
    valid: boolean;
    ticketsFound: string[];
    error?: string;
    mode: 'strict' | 'advisory';
}
export declare const TICKET_PATTERNS: {
    LINEAR: RegExp;
    JIRA: RegExp;
    GITHUB: RegExp;
};
export declare function validateTicketLinkage(input: TicketValidationInput): TicketValidationResult;
