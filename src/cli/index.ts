import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  runPreCommit,
  installGitHook,
  PreCommitOptions,
  PreCommitResult,
  InstallHookOptions,
  InstallHookResult,
} from './preCommit';
import {
  runInitWizard,
  InitWizardOptions,
  InitWizardResult,
} from './initWizard';

export * from './preCommit';
export * from './initWizard';

const VERSION = '1.28.6';

export function printHelp(): void {
  console.log(`
Review Yeti CLI — AI-powered code review and pre-commit security guardian

USAGE:
  review-yeti <command> [options]
  git yeti <command> [options]
  npx review-yeti <command> [options]

COMMANDS:
  init                 Run 30-second GitHub App onboarding setup wizard
  pre-commit           Evaluate staged git changes (git diff --cached) for P0/P1 issues
  install-hook         Install Review Yeti as a git pre-commit hook
  --version, -v        Show CLI version
  --help, -h           Show this help message

OPTIONS (init):
  --port <number>      Port for local callback listener (default: 3333)
  --org <name>         GitHub organization to create the app under
  --name <name>        Name of the GitHub App (default: review-yeti)
  --no-browser         Print GitHub App creation URL instead of launching browser
  --env-file <path>    Path to .env file to update/create (default: .env)
  --gh-secrets         Automatically set repository secrets via GitHub CLI (gh secret set)
  --repo <owner/repo>  Target repository for gh secrets (e.g. owner/repo)
  --dry-run            Display manifest and creation URL without starting flow
  --json               Output machine-readable manifest JSON in dry-run mode
  --quiet, -q          Suppress non-essential console logs

OPTIONS (pre-commit):
  --strict             Block commit on P1 issues in addition to P0 blocking issues
  --no-color           Disable ANSI color codes (also honors NO_COLOR env var)
  --json               Output machine-readable JSON evaluation report
  --diff <file>        Evaluate diff from a specific patch file instead of staged git diff
  --model <model>      Use specific flash model (e.g. deepseek/deepseek-chat, gemini-flash)
  --quiet, -q          Suppress non-essential console logs

OPTIONS (install-hook):
  --husky              Install hook into .husky/pre-commit instead of .git/hooks/
  --dir <path>         Target repository root directory

EXAMPLES:
  $ npx review-yeti init
  $ npx review-yeti init --org my-org --no-browser
  $ npx review-yeti init --dry-run --json
  $ npx review-yeti pre-commit
  $ git yeti pre-commit --strict
  $ npx review-yeti pre-commit --json > review-result.json
  $ review-yeti install-hook
`);
}

export function printVersion(): void {
  console.log(`review-yeti v${VERSION}`);
}

/**
 * Main CLI dispatcher. Parses arguments and executes the requested command.
 * Returns the process exit code (0 for clean/success, non-zero for failure/blocking issues).
 */
export async function runCli(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args.length === 0) {
    printHelp();
    return 0;
  }

  const command = args[0];
  const flags = args.slice(1);

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    printVersion();
    return 0;
  }

  if (command === 'init') {
    const getFlagValue = (flagName: string): string | undefined => {
      const idx = flags.indexOf(flagName);
      if (idx !== -1 && flags[idx + 1] && !flags[idx + 1].startsWith('-')) {
        return flags[idx + 1];
      }
      return undefined;
    };

    const portVal = getFlagValue('--port');
    const port = portVal ? parseInt(portVal, 10) : undefined;

    const options: InitWizardOptions = {
      port: Number.isNaN(port) ? undefined : port,
      org: getFlagValue('--org'),
      name: getFlagValue('--name'),
      url: getFlagValue('--url'),
      webhookUrl: getFlagValue('--webhook-url'),
      webhookSecret: getFlagValue('--webhook-secret'),
      noBrowser: flags.includes('--no-browser'),
      envFile: getFlagValue('--env-file'),
      writePem: flags.includes('--write-pem'),
      pemPath: getFlagValue('--pem') || getFlagValue('--pem-path'),
      syncSecrets: flags.includes('--gh-secrets'),
      repo: getFlagValue('--repo'),
      dryRun: flags.includes('--dry-run'),
      json: flags.includes('--json'),
      quiet: flags.includes('--quiet') || flags.includes('-q'),
    };

    try {
      const result = await runInitWizard(options);
      return result.success ? 0 : 1;
    } catch (err: any) {
      console.error(`\n❌ Error running setup wizard: ${err.message || err}`);
      return 1;
    }
  }

  if (command === 'pre-commit') {
    const options: PreCommitOptions = {
      strict: flags.includes('--strict'),
      noColor: flags.includes('--no-color'),
      json: flags.includes('--json'),
      quiet: flags.includes('--quiet') || flags.includes('-q'),
    };

    const diffIndex = flags.indexOf('--diff');
    if (diffIndex !== -1 && flags[diffIndex + 1]) {
      const diffFilePath = path.resolve(process.cwd(), flags[diffIndex + 1]);
      if (fs.existsSync(diffFilePath)) {
        options.diff = fs.readFileSync(diffFilePath, 'utf-8');
      } else {
        console.error(`Error: Diff file not found: ${diffFilePath}`);
        return 1;
      }
    }

    const modelIndex = flags.indexOf('--model');
    if (modelIndex !== -1 && flags[modelIndex + 1]) {
      options.model = flags[modelIndex + 1];
    }

    const result = await runPreCommit(options);
    return result.exitCode;
  }

  if (command === 'install-hook') {
    const hookOptions: InstallHookOptions = {
      husky: flags.includes('--husky'),
    };

    const dirIndex = flags.indexOf('--dir');
    if (dirIndex !== -1 && flags[dirIndex + 1]) {
      hookOptions.repoRoot = path.resolve(process.cwd(), flags[dirIndex + 1]);
    }

    const result = installGitHook(hookOptions);
    if (result.success) {
      console.log(`✅ ${result.message}`);
      return 0;
    } else {
      console.error(`❌ ${result.message}`);
      return 1;
    }
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run "review-yeti --help" for available commands.');
  return 1;
}

// If directly executed via node/ts-node
if (require.main === module) {
  runCli().then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });
}
