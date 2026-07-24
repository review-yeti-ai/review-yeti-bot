"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TicketProviderClient = void 0;
exports.queryLinearTicket = queryLinearTicket;
exports.queryJiraTicket = queryJiraTicket;
exports.queryGithubIssue = queryGithubIssue;
async function queryLinearTicket(baseUrl, ticketId) {
    const url = `${baseUrl.replace(/\/+$/, '')}/linear/graphql`;
    const sanitizedId = ticketId.replace(/["\\\n\r]/g, '');
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: 'query($id: String!) { issue(id: $id) { id title state { name } } }',
            variables: { id: sanitizedId },
        }),
    });
    if (!res.ok) {
        throw new Error(`Linear API query failed with status ${res.status}`);
    }
    return res.json();
}
async function queryJiraTicket(baseUrl, key) {
    const url = `${baseUrl.replace(/\/+$/, '')}/jira/rest/api/3/issue/${encodeURIComponent(key)}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Jira API query failed with status ${res.status}`);
    }
    return res.json();
}
async function queryGithubIssue(baseUrl, owner, repo, issueNum) {
    const url = `${baseUrl.replace(/\/+$/, '')}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(issueNum))}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`GitHub Issue API query failed with status ${res.status}`);
    }
    return res.json();
}
class TicketProviderClient {
    baseUrl;
    constructor(baseUrl) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }
    async queryLinear(ticketId) {
        return queryLinearTicket(this.baseUrl, ticketId);
    }
    async queryJira(key) {
        return queryJiraTicket(this.baseUrl, key);
    }
    async queryGithub(owner, repo, issueNum) {
        return queryGithubIssue(this.baseUrl, owner, repo, issueNum);
    }
}
exports.TicketProviderClient = TicketProviderClient;
//# sourceMappingURL=ticketProviderClient.js.map