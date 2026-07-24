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

export async function queryLinearTicket(baseUrl: string, ticketId: string): Promise<LinearTicketResponse> {
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
  return res.json() as Promise<LinearTicketResponse>;
}

export async function queryJiraTicket(baseUrl: string, key: string): Promise<JiraTicketResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/jira/rest/api/3/issue/${encodeURIComponent(key)}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Jira API query failed with status ${res.status}`);
  }
  return res.json() as Promise<JiraTicketResponse>;
}

export async function queryGithubIssue(
  baseUrl: string,
  owner: string,
  repo: string,
  issueNum: number | string
): Promise<GithubIssueResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(issueNum))}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`GitHub Issue API query failed with status ${res.status}`);
  }
  return res.json() as Promise<GithubIssueResponse>;
}

export class TicketProviderClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  public async queryLinear(ticketId: string): Promise<LinearTicketResponse> {
    return queryLinearTicket(this.baseUrl, ticketId);
  }

  public async queryJira(key: string): Promise<JiraTicketResponse> {
    return queryJiraTicket(this.baseUrl, key);
  }

  public async queryGithub(owner: string, repo: string, issueNum: number | string): Promise<GithubIssueResponse> {
    return queryGithubIssue(this.baseUrl, owner, repo, issueNum);
  }
}
