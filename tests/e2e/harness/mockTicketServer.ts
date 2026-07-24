import express, { Request, Response, Express } from 'express';
import { Server } from 'http';

export interface MockTicket {
  key: string; // e.g., 'PROJ-123', 'KEY-456', '789'
  provider: 'linear' | 'jira' | 'github';
  title: string;
  status: 'Open' | 'In Progress' | 'Closed' | 'Resolved';
  assignee?: string;
}

export interface TicketRecordedRequest {
  timestamp: string;
  method: string;
  path: string;
  body: any;
  query: any;
}

export class MockTicketServer {
  private app: Express;
  private server: Server | null = null;
  public port: number;

  private tickets: Map<string, MockTicket> = new Map();
  private errorInjections: Map<string, number> = new Map(); // provider or key -> HTTP status
  private recordedRequests: TicketRecordedRequest[] = [];

  constructor(port = 9091) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.seedDefaultTickets();
    this.setupRoutes();
  }

  private seedDefaultTickets(): void {
    this.tickets.set('PROJ-123', {
      key: 'PROJ-123',
      provider: 'linear',
      title: 'Fix authentication token leak',
      status: 'In Progress',
      assignee: 'Alice',
    });
    this.tickets.set('KEY-456', {
      key: 'KEY-456',
      provider: 'jira',
      title: 'Implement diff state persistence',
      status: 'Open',
      assignee: 'Bob',
    });
    this.tickets.set('789', {
      key: '789',
      provider: 'github',
      title: 'Update Kubernetes deployment manifests',
      status: 'Open',
    });
  }

  private setupRoutes(): void {
    // Recording Middleware
    this.app.use((req: Request, _res: Response, next) => {
      if (!req.path.startsWith('/__admin')) {
        this.recordedRequests.push({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: req.path,
          body: req.body,
          query: req.query,
        });
      }
      next();
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', service: 'mockTicketServer' });
    });

    // Admin Endpoints
    this.app.post('/__admin/tickets', (req: Request, res: Response) => {
      const ticketsInput: MockTicket[] = Array.isArray(req.body) ? req.body : [req.body];
      for (const t of ticketsInput) {
        this.tickets.set(t.key.toUpperCase(), t);
      }
      res.status(200).json({ status: 'added', totalTickets: this.tickets.size });
    });

    this.app.post('/__admin/inject-error', (req: Request, res: Response) => {
      const { target, status = 500 } = req.body || {};
      if (target) {
        this.errorInjections.set(target.toUpperCase(), status);
      }
      res.status(200).json({ status: 'injected', target, httpStatus: status });
    });

    this.app.get('/__admin/requests', (_req: Request, res: Response) => {
      res.status(200).json(this.recordedRequests);
    });

    this.app.post('/__admin/reset', (_req: Request, res: Response) => {
      this.resetState();
      res.status(200).json({ status: 'reset' });
    });

    // 1. Linear GraphQL API Mock
    this.app.post('/linear/graphql', (req: Request, res: Response) => {
      if (this.errorInjections.has('LINEAR')) {
        const status = this.errorInjections.get('LINEAR')!;
        return res.status(status).json({ error: 'Linear API Error Injected' });
      }

      const { query, variables } = req.body || {};
      const issueKey = variables?.id || (typeof query === 'string' ? query.match(/id:\s*"([^"]+)"/)?.[1] : null);

      if (issueKey && this.tickets.has(issueKey.toUpperCase())) {
        const ticket = this.tickets.get(issueKey.toUpperCase())!;
        return res.status(200).json({
          data: {
            issue: {
              id: ticket.key,
              identifier: ticket.key,
              title: ticket.title,
              state: { name: ticket.status },
              assignee: ticket.assignee ? { name: ticket.assignee } : null,
            },
          },
        });
      }

      return res.status(200).json({
        data: { issue: null },
        errors: [{ message: `Entity not found: ${issueKey}` }],
      });
    });

    // 2. Jira REST API v3 Mock
    this.app.get('/jira/rest/api/3/issue/:issueKey', (req: Request, res: Response) => {
      const key = req.params.issueKey.toUpperCase();

      if (this.errorInjections.has('JIRA') || this.errorInjections.has(key)) {
        const status = this.errorInjections.get('JIRA') || this.errorInjections.get(key)!;
        return res.status(status).json({ errorMessages: ['Jira Error Injected'] });
      }

      if (this.tickets.has(key)) {
        const ticket = this.tickets.get(key)!;
        return res.status(200).json({
          id: '10001',
          key: ticket.key,
          fields: {
            summary: ticket.title,
            status: { name: ticket.status },
            assignee: ticket.assignee ? { displayName: ticket.assignee } : null,
          },
        });
      }

      return res.status(404).json({
        errorMessages: [`Issue ${key} does not exist or you do not have permission to view it.`],
      });
    });

    // 3. GitHub Issues REST API v3 Mock
    this.app.get('/github/repos/:owner/:repo/issues/:issue_number', (req: Request, res: Response) => {
      const issueNumber = req.params.issue_number;

      if (this.errorInjections.has('GITHUB')) {
        const status = this.errorInjections.get('GITHUB')!;
        return res.status(status).json({ message: 'GitHub API Error Injected' });
      }

      if (this.tickets.has(issueNumber)) {
        const ticket = this.tickets.get(issueNumber)!;
        return res.status(200).json({
          number: parseInt(issueNumber, 10),
          title: ticket.title,
          state: ticket.status.toLowerCase() === 'closed' ? 'closed' : 'open',
          user: { login: ticket.assignee || 'octocat' },
        });
      }

      return res.status(404).json({
        message: 'Not Found',
        documentation_url: 'https://docs.github.com/rest/reference/issues#get-an-issue',
      });
    });
  }

  public addTicket(ticket: MockTicket): void {
    this.tickets.set(ticket.key.toUpperCase(), ticket);
  }

  public setTickets(tickets: MockTicket[]): void {
    for (const t of tickets) {
      this.addTicket(t);
    }
  }

  public injectError(target: string, status: number): void {
    this.errorInjections.set(target.toUpperCase(), status);
  }

  public resetState(): void {
    this.tickets.clear();
    this.errorInjections.clear();
    this.recordedRequests = [];
    this.seedDefaultTickets();
  }

  public reset(): void {
    this.resetState();
  }

  public start(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, '127.0.0.1', () => {
          const addr = this.server?.address();
          if (typeof addr === 'object' && addr !== null) {
            this.port = addr.port;
          }
          resolve(`http://127.0.0.1:${this.port}`);
        });
        this.server.on('error', (err) => reject(err));
      } catch (err) {
        reject(err);
      }
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  public getRecordedRequests(): TicketRecordedRequest[] {
    return [...this.recordedRequests];
  }
}
