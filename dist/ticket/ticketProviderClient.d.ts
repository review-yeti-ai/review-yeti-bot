export interface LinearTicketResponse {
    data: {
        issue: {
            id: string;
            title: string;
            state: {
                name: string;
            };
        };
    };
}
export interface JiraTicketResponse {
    key: string;
    fields: {
        summary: string;
        status: {
            name: string;
        };
    };
}
export interface GithubIssueResponse {
    number: number;
    title: string;
    state?: string;
}
export declare function queryLinearTicket(baseUrl: string, ticketId: string): Promise<LinearTicketResponse>;
export declare function queryJiraTicket(baseUrl: string, key: string): Promise<JiraTicketResponse>;
export declare function queryGithubIssue(baseUrl: string, owner: string, repo: string, issueNum: number | string): Promise<GithubIssueResponse>;
export declare class TicketProviderClient {
    private baseUrl;
    constructor(baseUrl: string);
    queryLinear(ticketId: string): Promise<LinearTicketResponse>;
    queryJira(key: string): Promise<JiraTicketResponse>;
    queryGithub(owner: string, repo: string, issueNum: number | string): Promise<GithubIssueResponse>;
}
