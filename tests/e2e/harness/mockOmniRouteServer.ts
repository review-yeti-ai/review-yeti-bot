import express, { Request, Response, Express } from 'express';
import { Server } from 'http';

export interface LLMRequestPayload {
  prompt?: string;
  systemPrompt?: string;
  persona?: 'security' | 'architecture' | 'performance' | 'quality';
  effortLevel?: 'low' | 'medium' | 'high' | 'reasoning';
  provider?: string;
  model?: string;
  temperature?: number;
}

export interface LLMResponsePayload {
  content: string;
  providerUsed: string;
  modelUsed: string;
  tokensUsed: {
    prompt: number;
    completion: number;
    total: number;
  };
  reasoningTrace?: string;
}

export interface RecordedRequest {
  timestamp: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export interface ConfigureOmniRouteOptions {
  tokenExpired?: boolean;
  failProvider?: {
    provider: string;
    status?: number;
    message?: string;
    failCount?: number;
  };
  resetFailures?: boolean;
}

export class MockOmniRouteServer {
  private app: Express;
  private server: Server | null = null;
  public port: number;

  private validTokens: Set<string> = new Set(['valid-access-token-123']);
  private refreshTokens: Map<string, string> = new Map([['valid-refresh-token', 'new-access-token-456']]);
  private tokenExpired = false;
  private providerFailures: Map<string, { status: number; message: string; remainingFails: number }> = new Map();
  private recordedRequests: RecordedRequest[] = [];

  constructor(port = 9090) {
    this.port = port;
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Request recording middleware
    this.app.use((req: Request, _res: Response, next) => {
      if (!req.path.startsWith('/__admin')) {
        this.recordedRequests.push({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: req.path,
          headers: req.headers,
          body: req.body,
        });
      }
      next();
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', service: 'mockOmniRouteServer' });
    });

    // Admin Control Endpoints
    this.app.post('/__admin/configure', (req: Request, res: Response) => {
      this.configure(req.body);
      res.status(200).json({ status: 'configured', currentFailures: Array.from(this.providerFailures.entries()) });
    });

    this.app.get('/__admin/requests', (_req: Request, res: Response) => {
      res.status(200).json(this.recordedRequests);
    });

    this.app.post('/__admin/reset', (_req: Request, res: Response) => {
      this.resetState();
      res.status(200).json({ status: 'reset' });
    });

    // OAuth 2.0 Token Refresh Endpoint
    this.app.post('/v1/oauth/token', (req: Request, res: Response) => {
      const { grant_type, refresh_token } = req.body || {};

      if (grant_type === 'refresh_token') {
        if (this.refreshTokens.has(refresh_token)) {
          const newToken = this.refreshTokens.get(refresh_token)!;
          this.validTokens.add(newToken);
          this.tokenExpired = false; // Reset expired state after refresh
          return res.status(200).json({
            access_token: newToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refresh_token,
          });
        }
        return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
      }

      // Default client credentials issuing
      const defaultToken = `token-${Date.now()}`;
      this.validTokens.add(defaultToken);
      return res.status(200).json({
        access_token: defaultToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    });

    // OmniRoute Chat Completion & Routing Endpoint
    this.app.post('/v1/chat/completions', (req: Request, res: Response) => {
      // 1. Auth check
      const authHeader = req.headers.authorization;
      const token = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null;

      if (this.tokenExpired || !token || !this.validTokens.has(token)) {
        return res.status(401).json({
          error: {
            message: 'Access token expired or invalid',
            type: 'invalid_request_error',
            code: 'token_expired',
          },
        });
      }

      const payload: LLMRequestPayload = req.body || {};
      const requestedProvider = payload.provider || 'openai';

      // 2. Check for injected provider failures (for failover testing)
      if (this.providerFailures.has(requestedProvider)) {
        const failConfig = this.providerFailures.get(requestedProvider)!;
        if (failConfig.remainingFails > 0) {
          failConfig.remainingFails--;
          if (failConfig.remainingFails === 0) {
            this.providerFailures.delete(requestedProvider);
          }
          return res.status(failConfig.status).json({
            error: {
              message: failConfig.message,
              provider: requestedProvider,
              code: 'provider_error',
            },
          });
        }
      }

      // 3. Generate Effort Level & Persona Response
      const response = this.generateResponse(payload, requestedProvider);
      return res.status(200).json(response);
    });
  }

  private generateResponse(payload: LLMRequestPayload, provider: string): LLMResponsePayload {
    const persona = payload.persona || 'quality';
    const effort = payload.effortLevel || 'medium';

    let promptTokens = 150;
    let completionTokens = 100;
    let reasoningTrace: string | undefined;

    if (effort === 'low') {
      promptTokens = 80;
      completionTokens = 40;
    } else if (effort === 'high') {
      promptTokens = 300;
      completionTokens = 250;
    } else if (effort === 'reasoning') {
      promptTokens = 400;
      completionTokens = 500;
      reasoningTrace = `<thinking>Analyzing ${persona} constraints for requested diff hunk...</thinking>`;
    }

    const promptText = (payload.prompt || '').toLowerCase();
    const hasCriticalVulnerability = promptText.includes('eval') || promptText.includes('vulnerability') || promptText.includes('critical');
    const severity = persona === 'security' && hasCriticalVulnerability ? 'critical' : 'minor';

    const content = JSON.stringify({
      findings: [
        {
          persona,
          severity,
          filePath: 'src/index.ts',
          lineNumber: 42,
          comment: `[MockOmniRoute:${effort}] Identified ${persona} concern in provided diff.`,
          suggestion: 'Refactor code to follow standard guidelines.',
        },
      ],
      summary: `Automated ${persona} review complete (${effort} effort).`,
    });

    return {
      content,
      providerUsed: provider,
      modelUsed: provider === 'anthropic' ? 'claude-3-5-sonnet' : 'gpt-4o',
      tokensUsed: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
      ...(reasoningTrace ? { reasoningTrace } : {}),
    };
  }

  public configure(options: ConfigureOmniRouteOptions): void {
    if (typeof options.tokenExpired === 'boolean') {
      this.tokenExpired = options.tokenExpired;
    }
    if (options.failProvider) {
      const { provider, status = 503, message = 'Provider Unavailable', failCount = 1 } = options.failProvider;
      this.providerFailures.set(provider, { status, message, remainingFails: failCount });
    }
    if (options.resetFailures) {
      this.providerFailures.clear();
    }
  }

  public resetState(): void {
    this.validTokens = new Set(['valid-access-token-123']);
    this.refreshTokens = new Map([['valid-refresh-token', 'new-access-token-456']]);
    this.tokenExpired = false;
    this.providerFailures.clear();
    this.recordedRequests = [];
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

  public getRecordedRequests(): RecordedRequest[] {
    return [...this.recordedRequests];
  }
}
