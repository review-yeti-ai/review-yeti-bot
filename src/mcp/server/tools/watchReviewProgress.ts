import {
  type ToolDefinition,
  type ToolResult,
  type McpExecutionContext,
  buildToolResultJson,
} from '../mcpTypes';
import {
  WatchReviewProgressInputSchema,
  type WatchReviewProgressInput,
  type WatchReviewProgressOutput,
  type ProgressEvent,
} from './schemas';

export const watchReviewProgressDefinition: ToolDefinition = {
  name: 'watch_review_progress',
  description: 'Live streaming of reviewer exploration turns and consensus backed by JetStream.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner/organization.' },
      repo: { type: 'string', description: 'GitHub repository name.' },
      pull_number: { type: 'number', description: 'Pull request number.' },
      head_sha: { type: 'string', description: 'Optional commit SHA filter.' },
      timeout_seconds: { type: 'number', minimum: 1, maximum: 900, default: 300, description: 'Streaming deadline.' },
      cursor: { type: 'string', description: 'Optional JetStream sequence cursor.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    additionalProperties: false,
  },
};

export interface JetStreamProgressEvent {
  schema?: string;
  event_id?: string;
  event_kind?: string;
  occurred_at?: string;
  repository_id?: number;
  pr_number?: number;
  head_sha?: string;
  data?: {
    persona?: string;
    turn_index?: number;
    status?: string;
    tool_name?: string;
    target?: string;
    duration_ms?: number;
    verdict?: string;
    summary?: string;
    findings_count?: number;
  };
}

export interface WatchReviewProgressDependencies {
  subscribeProgress?: (
    subject: string,
    options: {
      cursor?: string;
      onEvent: (event: JetStreamProgressEvent, seq: number) => void;
      onError: (err: Error) => void;
    }
  ) => Promise<{ unsubscribe(): Promise<void> }>;
  resolveRepositoryId?: (owner: string, repo: string) => Promise<number>;
  now?: () => number;
}

export function createWatchReviewProgressTool(deps: WatchReviewProgressDependencies = {}) {
  const nowFn = deps.now || Date.now;

  return {
    definition: watchReviewProgressDefinition,
    schema: WatchReviewProgressInputSchema,
    execute: async (
      rawArgs: Record<string, unknown>,
      context?: McpExecutionContext
    ): Promise<ToolResult> => {
      const parsed = WatchReviewProgressInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pull_number, head_sha, timeout_seconds = 300, cursor } = parsed.data;

      const headShaFilter = head_sha ? head_sha.toLowerCase() : undefined;

      // JetStream progress subscription service is strictly required
      if (!deps.subscribeProgress) {
        throw new Error(
          'JetStream subscription service unavailable: subscribeProgress dependency is required to watch review progress'
        );
      }

      const repoId = deps.resolveRepositoryId
        ? await deps.resolveRepositoryId(owner, repo)
        : 1001;
      const subject = `ct.review.progress.v1.repo-${repoId}.pr-${pull_number}`;
      const events: ProgressEvent[] = [];
      let lastCursor: string | undefined = cursor;

      let subscription: { unsubscribe(): Promise<void> } | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;

      const outcome = await new Promise<WatchReviewProgressOutput>((resolve, reject) => {
        let isComplete = false;

        const cleanup = async () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
          if (subscription) {
            await subscription.unsubscribe().catch(() => undefined);
            subscription = undefined;
          }
        };

        // Timeout Deadline
        timeoutHandle = setTimeout(async () => {
          if (isComplete) return;
          isComplete = true;
          await cleanup();
          resolve({
            streaming: true,
            events,
            last_cursor: lastCursor,
            timed_out: true,
          });
        }, timeout_seconds * 1000);

        void (async () => {
          try {
            subscription = await deps.subscribeProgress!(subject, {
              cursor,
              onEvent: (jsEvent, seq) => {
                if (isComplete) return;

                if (headShaFilter && jsEvent.head_sha && jsEvent.head_sha.toLowerCase() !== headShaFilter) {
                  return;
                }

                lastCursor = String(seq);
                const data = jsEvent.data || {};
                const occurredAt = jsEvent.occurred_at || new Date(nowFn()).toISOString();

                const isTool = jsEvent.event_kind ? jsEvent.event_kind.includes('tool') : Boolean(data.tool_name);
                const isVerdict = jsEvent.event_kind ? jsEvent.event_kind.includes('verdict') : Boolean(data.verdict);
                const isPersona = jsEvent.event_kind ? jsEvent.event_kind.includes('persona') : Boolean(data.status || data.turn_index || data.persona);

                if (isTool) {
                  const ev: ProgressEvent = {
                    event: 'tool_invocation',
                    persona: data.persona || 'reviewer',
                    tool_name: data.tool_name || 'zoekt_search',
                    target: data.target,
                    duration_ms: data.duration_ms || 0,
                    timestamp: occurredAt,
                  };
                  events.push(ev);
                  if (context?.emitProgress) {
                    context.emitProgress(events.length, 100, `Tool ${ev.tool_name} executed`);
                  }
                } else if (isVerdict) {
                  const ev: ProgressEvent = {
                    event: 'verdict_declared',
                    verdict: (data.verdict as any) || 'SHIP',
                    summary: data.summary || 'Arbitration completed.',
                    timestamp: occurredAt,
                  };
                  events.push(ev);

                  isComplete = true;
                  void cleanup().then(() => {
                    resolve({
                      streaming: true,
                      events,
                      last_cursor: lastCursor,
                    });
                  });
                } else if (isPersona) {
                  const ev: ProgressEvent = {
                    event: 'persona_progress',
                    persona: data.persona || 'reviewer',
                    turn_index: data.turn_index || 1,
                    status: (data.status as any) || 'in_progress',
                    timestamp: occurredAt,
                    findings_count: data.findings_count,
                  };
                  events.push(ev);
                  if (context?.emitProgress) {
                    context.emitProgress(events.length, 100, `Persona ${ev.persona}: ${ev.status}`);
                  }
                }
              },
              onError: (err) => {
                if (!isComplete) {
                  isComplete = true;
                  void cleanup().then(() => reject(err));
                }
              },
            });
          } catch (err) {
            isComplete = true;
            void cleanup().then(() => reject(err));
          }
        })();
      });

      return buildToolResultJson(outcome);
    },
  };
}
