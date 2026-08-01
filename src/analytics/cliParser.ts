import fs from 'fs';
import path from 'path';
import { SessionFilterOptions, FormatterOptions } from './types';
import { SessionRepository } from './sessionRepository';
import { calculateKPIs } from './kpiCalculator';
import { formatOutput } from './formatters';

export interface ParsedCLIArgs {
  command: 'list' | 'stats' | 'inspect' | 'search' | 'help';
  targetId?: string;
  options: SessionFilterOptions;
  formatterOptions: FormatterOptions;
  baseDir?: string;
  helpRequested?: boolean;
}

export function parseCLIArgs(rawArgs: string[]): ParsedCLIArgs {
  const args = [...rawArgs];

  let command: 'list' | 'stats' | 'inspect' | 'search' | 'help' = 'list';
  let targetId: string | undefined = undefined;

  const filterOptions: SessionFilterOptions = {};
  const formatterOptions: FormatterOptions = {
    format: 'table',
  };
  let baseDir: string | undefined = undefined;
  let helpRequested = false;

  // Check positional command
  if (args.length > 0 && !args[0].startsWith('-')) {
    const cmdInput = args[0].toLowerCase();
    if (['list', 'stats', 'inspect', 'search', 'help'].includes(cmdInput)) {
      command = cmdInput as any;
      args.shift();

      if ((command === 'inspect' || command === 'search') && args.length > 0 && !args[0].startsWith('-')) {
        targetId = args.shift();
      }
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      helpRequested = true;
      command = 'help';
    } else if (arg === '--dir') {
      baseDir = args[++i];
    } else if (arg === '--owner') {
      filterOptions.owner = args[++i];
    } else if (arg === '--repo') {
      filterOptions.repo = args[++i];
    } else if (arg === '--pr') {
      const val = args[++i];
      filterOptions.prNumber = isNaN(Number(val)) ? val : Number(val);
    } else if (arg === '--verdict') {
      filterOptions.verdict = args[++i];
    } else if (arg === '--min-turns') {
      filterOptions.minTurns = parseInt(args[++i], 10);
    } else if (arg === '--max-turns') {
      filterOptions.maxTurns = parseInt(args[++i], 10);
    } else if (arg === '--query' || arg === '-q') {
      filterOptions.query = args[++i];
    } else if (arg === '--format' || arg === '-f') {
      const fmt = (args[++i] || 'table').toLowerCase();
      if (['okf', 'json', 'markdown', 'table'].includes(fmt)) {
        formatterOptions.format = fmt as any;
      }
    } else if (arg === '--out' || arg === '-o') {
      formatterOptions.out = args[++i];
    } else if (!arg.startsWith('-') && !targetId) {
      targetId = arg;
    }
  }

  if (command === 'search' && targetId && !filterOptions.query) {
    filterOptions.query = targetId;
  }

  return {
    command,
    targetId,
    options: filterOptions,
    formatterOptions,
    baseDir,
    helpRequested,
  };
}

export function generateHelpText(): string {
  return `
Session Analytics CLI Tool (ct-review-bot)

USAGE:
  session-analytics [COMMAND] [OPTIONS]

COMMANDS:
  list                 List sessions matching filters (default command)
  stats                Display aggregate KPI metrics across sessions
  inspect <session_id> Display detailed turn history and findings for a session
  search <query>       Search sessions by query string in title or branch
  help                 Display this help menu

OPTIONS:
  --dir <path>         Base directory for session ledger (default: sessions/)
  --owner <name>       Filter by repository owner
  --repo <name>        Filter by repository name
  --pr <number>        Filter by Pull Request number
  --verdict <verdict>  Filter by last verdict (SHIP, NACK, COMMENT, FIX_FIRST)
  --min-turns <n>      Filter sessions with at least <n> turns
  --max-turns <n>      Filter sessions with at most <n> turns
  -q, --query <text>   Filter sessions matching search query text
  -f, --format <fmt>   Output format: okf, json, markdown, table (default: table)
  -o, --out <file>     Write formatted output to specified file
  -h, --help           Display help documentation

EXAMPLES:
  session-analytics stats --format json
  session-analytics list --owner cisco-cdr --verdict SHIP
  session-analytics inspect cisco-cdr/ct-review-bot#42 --format markdown
  session-analytics search "refactor" --format okf -o report.okf
`;
}

export function runCLI(rawArgs: string[]): { output: string; outPath?: string; exitCode: number } {
  const parsed = parseCLIArgs(rawArgs);

  if (parsed.helpRequested || parsed.command === 'help') {
    return { output: generateHelpText(), exitCode: 0 };
  }

  const repo = new SessionRepository(parsed.baseDir);
  let output = '';

  switch (parsed.command) {
    case 'stats': {
      const sessions = repo.getSessions(parsed.options);
      const kpis = calculateKPIs(sessions);
      output = formatOutput({ kpis }, parsed.formatterOptions);
      break;
    }
    case 'inspect': {
      if (!parsed.targetId) {
        return { output: 'Error: Session ID required for inspect command.', exitCode: 1 };
      }
      const detail = repo.getSessionById(parsed.targetId);
      if (!detail) {
        return { output: `Error: Session not found for ID: ${parsed.targetId}`, exitCode: 1 };
      }
      output = formatOutput({ sessionDetail: detail }, parsed.formatterOptions);
      break;
    }
    case 'search': {
      const sessions = repo.getSessions(parsed.options);
      output = formatOutput({ sessions }, parsed.formatterOptions);
      break;
    }
    case 'list':
    default: {
      const sessions = repo.getSessions(parsed.options);
      output = formatOutput({ sessions }, parsed.formatterOptions);
      break;
    }
  }

  if (parsed.formatterOptions.out) {
    const outPath = path.resolve(process.cwd(), parsed.formatterOptions.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, 'utf-8');
    return { output, outPath, exitCode: 0 };
  }

  return { output, exitCode: 0 };
}
