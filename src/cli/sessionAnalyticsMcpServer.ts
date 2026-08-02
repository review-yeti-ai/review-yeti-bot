import {
  buildModelMatrix,
  ModelMatrixSortField,
  BenchmarkType,
} from '../analytics/modelMatrix';
import { Modality } from '../services/openRouterModelService';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface McpContentText {
  type: 'text';
  text: string;
}

export interface McpCallToolResult {
  content: McpContentText[];
  isError?: boolean;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: 'query_openrouter_models',
    description:
      'Query and filter OpenRouter models based on SWE-bench score, cost, context, modality, or search query.',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: {
          type: 'string',
          enum: ['swe-score', 'cost', 'context', 'efficiency', 'name'],
          description: 'Field to sort models by',
        },
        maxCostPer1M: {
          type: 'number',
          description: 'Maximum blended cost per 1M tokens in USD ($)',
        },
        minScore: {
          type: 'number',
          description: 'Minimum SWE-bench score percentage',
        },
        modality: {
          type: 'string',
          description: 'Supported modality filter (e.g. text, image, audio)',
        },
        query: {
          type: 'string',
          description: 'Search text matching model ID, display name, or provider',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of model entries to return',
        },
      },
    },
  },
  {
    name: 'get_model_benchmark_matrix',
    description:
      'Retrieve the full SWE-bench performance capability matrix JSON with summary statistics.',
    inputSchema: {
      type: 'object',
      properties: {
        benchmarkType: {
          type: 'string',
          enum: ['verified', 'lite'],
          description: 'SWE-bench evaluation dataset variant (verified or lite)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of entries in the returned matrix',
        },
        forceRefresh: {
          type: 'boolean',
          description: 'Bypass cache and force refresh model specifications from OpenRouter',
        },
      },
    },
  },
];

export async function handleCallTool(
  toolName: string,
  args: Record<string, any> = {}
): Promise<McpCallToolResult> {
  try {
    switch (toolName) {
      case 'query_openrouter_models': {
        const sortBy =
          typeof args.sortBy === 'string' ? (args.sortBy as ModelMatrixSortField) : undefined;

        const maxCostPer1M =
          typeof args.maxCostPer1M === 'number'
            ? args.maxCostPer1M
            : typeof args.maxCostPer1M === 'string'
            ? parseFloat(args.maxCostPer1M)
            : undefined;

        const minScore =
          typeof args.minScore === 'number'
            ? args.minScore
            : typeof args.minScore === 'string'
            ? parseFloat(args.minScore)
            : undefined;

        const modality =
          typeof args.modality === 'string' ? (args.modality as Modality) : undefined;

        const query = typeof args.query === 'string' ? args.query : undefined;

        const limit =
          typeof args.limit === 'number'
            ? args.limit
            : typeof args.limit === 'string'
            ? parseInt(args.limit, 10)
            : undefined;

        const matrix = await buildModelMatrix({
          sortBy,
          maxCostPer1M,
          minScore,
          modality,
          query,
          limit,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(matrix, null, 2),
            },
          ],
        };
      }

      case 'get_model_benchmark_matrix': {
        const benchmarkType = args.benchmarkType === 'lite' ? 'lite' : 'verified';

        const limit =
          typeof args.limit === 'number'
            ? args.limit
            : typeof args.limit === 'string'
            ? parseInt(args.limit, 10)
            : undefined;

        const forceRefresh = Boolean(args.forceRefresh);

        const matrix = await buildModelMatrix({
          benchmarkType,
          limit,
          forceRefresh,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(matrix, null, 2),
            },
          ],
        };
      }

      default:
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: `Unknown MCP tool: ${toolName}` }),
            },
          ],
        };
    }
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: err.message || String(err) }),
        },
      ],
    };
  }
}

export class SessionAnalyticsMcpServer {
  public getTools(): McpToolDefinition[] {
    return MCP_TOOLS;
  }

  public async callTool(
    name: string,
    args: Record<string, any> = {}
  ): Promise<McpCallToolResult> {
    return handleCallTool(name, args);
  }
}

export const sessionAnalyticsMcpServer = new SessionAnalyticsMcpServer();

// Standalone CLI runner when executed directly via node / ts-node
if (require.main === module) {
  const input = process.argv.slice(2);
  const toolName = input[0] || 'get_model_benchmark_matrix';
  let parsedArgs = {};
  if (input[1]) {
    try {
      parsedArgs = JSON.parse(input[1]);
    } catch (_) {}
  }
  handleCallTool(toolName, parsedArgs).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  });
}
