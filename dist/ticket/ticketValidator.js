"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TICKET_PATTERNS = void 0;
exports.validateTicketLinkage = validateTicketLinkage;
exports.TICKET_PATTERNS = {
    LINEAR: /\b([A-Za-z0-9_]{1,32}-\d+)\b|\[([A-Za-z0-9_]{1,32}-\d+)\]/gi,
    JIRA: /\b([A-Za-z0-9_]{1,32}-\d+)\b|\[([A-Za-z0-9_]{1,32}-\d+)\]/gi,
    GITHUB: /(?:^|[\s(\[:])(?:#(\d+)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)|GH-(\d+))\b/gi,
};
const FALSE_POSITIVE_PREFIXES = new Set([
    'UTF', 'SHA', 'ISO', 'COVID', 'LOG', 'HTTP', 'HTTPS', 'TLS', 'SSL',
    'RSA', 'AES', 'IPV4', 'IPV6', 'RFC', 'VERSION', 'VER', 'V',
]);
function validateTicketLinkage(input) {
    const { title, body, config } = input;
    const combinedText = `${title || ''}\n${body || ''}`;
    const ticketsSet = new Set();
    const mode = config.required ? 'strict' : 'advisory';
    for (const provider of config.providers) {
        if (provider === 'linear') {
            const matches = combinedText.matchAll(exports.TICKET_PATTERNS.LINEAR);
            for (const m of matches) {
                const ticket = m[1] || m[2];
                if (ticket) {
                    const upper = ticket.toUpperCase();
                    const prefix = upper.split('-')[0];
                    if (!FALSE_POSITIVE_PREFIXES.has(prefix)) {
                        ticketsSet.add(upper);
                    }
                }
            }
        }
        else if (provider === 'jira') {
            const matches = combinedText.matchAll(exports.TICKET_PATTERNS.JIRA);
            for (const m of matches) {
                const ticket = m[1] || m[2];
                if (ticket) {
                    const upper = ticket.toUpperCase();
                    const prefix = upper.split('-')[0];
                    if (!FALSE_POSITIVE_PREFIXES.has(prefix)) {
                        ticketsSet.add(upper);
                    }
                }
            }
        }
        else if (provider === 'github') {
            const matches = combinedText.matchAll(exports.TICKET_PATTERNS.GITHUB);
            for (const m of matches) {
                const rawTicket = m[0]?.trim();
                if (rawTicket) {
                    const ticket = rawTicket.replace(/^[\s(\[:]+/, '');
                    if (ticket)
                        ticketsSet.add(ticket);
                }
            }
        }
    }
    if (config.patterns && config.patterns.length > 0) {
        for (const patternStr of config.patterns) {
            try {
                const customRegex = new RegExp(patternStr, 'g');
                const matches = combinedText.matchAll(customRegex);
                for (const m of matches) {
                    if (m[0])
                        ticketsSet.add(m[0].trim());
                }
            }
            catch (err) {
                // Handle invalid regex gracefully
            }
        }
    }
    const ticketsFound = Array.from(ticketsSet);
    const hasTickets = ticketsFound.length > 0;
    if (mode === 'strict' && !hasTickets) {
        return {
            valid: false,
            ticketsFound: [],
            error: `No ticket linkage found in PR title or body. Configured required providers: [${config.providers.join(', ')}]. Example formats: [PROJ-123], KEY-456, or #789.`,
            mode: 'strict',
        };
    }
    return {
        valid: true,
        ticketsFound,
        mode,
    };
}
//# sourceMappingURL=ticketValidator.js.map