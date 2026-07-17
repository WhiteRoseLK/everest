import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import {
  createIssue,
  listHarnessPullRequests,
  listRecentlyClosedIssues,
  listBlockers,
} from './github.js';

/** Lookback window used by `everest status` when reporting recently closed issues. */
const RECENT_ISSUES_WINDOW_HOURS = 24;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  everest ask "<message>" [--priority <critical|high|medium|low>]',
      '  everest status',
      '  everest blockers',
      '  everest watch [--interval <ms>]',
    ].join('\n'),
  );
}

/**
 * Handles `everest ask`: files a new GitHub issue for the harness to pick up, optionally tagged
 * with a `priority:<level>` label consumed by `pickNextIssue` (see `src/loop.ts`).
 */
async function runAsk(args: string[], repo: string): Promise<void> {
  let priority: string | undefined;
  const messageParts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--priority') {
      priority = args[i + 1];
      i += 1;
    } else {
      messageParts.push(args[i]);
    }
  }
  const message = messageParts.join(' ').trim();
  if (!message) {
    throw new Error('everest ask requires a message, e.g. everest ask "add dark mode"');
  }

  const url = await createIssue(repo, message, priority);
  console.log(`Issue created: ${url}`);
}

/** Handles `everest status`: shows open harness PRs and their state, plus recently closed issues. */
async function runStatus(repo: string): Promise<void> {
  const pullRequests = await listHarnessPullRequests(repo);
  console.log('Open harness pull requests:');
  if (pullRequests.length === 0) {
    console.log('  (none)');
  } else {
    for (const pr of pullRequests) {
      console.log(`  #${pr.number} issue #${pr.issueNumber} [${pr.branch}] - ${pr.status}`);
    }
  }

  const closedIssues = await listRecentlyClosedIssues(repo, RECENT_ISSUES_WINDOW_HOURS);
  console.log(`\nIssues closed in the last ${RECENT_ISSUES_WINDOW_HOURS}h:`);
  if (closedIssues.length === 0) {
    console.log('  (none)');
  } else {
    for (const issue of closedIssues) {
      console.log(`  #${issue.number} ${issue.title} (closed ${issue.closedAt})`);
    }
  }
}

/** Handles `everest blockers`: lists PRs needing human intervention along with their last comment. */
async function runBlockers(repo: string): Promise<void> {
  const blockers = await listBlockers(repo);
  if (blockers.length === 0) {
    console.log('No blockers - nothing needs human intervention.');
    return;
  }
  for (const blocker of blockers) {
    console.log(`#${blocker.number} ${blocker.title} [${blocker.branch}]`);
    console.log(`  Last comment: ${blocker.lastComment ?? '(no comment)'}`);
  }
}

/**
 * Renders one `everest watch` snapshot: blockers (`needs-human`) plus PRs still going through the
 * `needs-fixup` review loop. Reuses `listBlockers`/`listHarnessPullRequests` (`src/github.ts`)
 * rather than a dedicated watch-specific GitHub query.
 */
async function renderWatchSnapshot(repo: string, intervalMs: number): Promise<void> {
  const [blockers, pullRequests] = await Promise.all([
    listBlockers(repo),
    listHarnessPullRequests(repo),
  ]);
  const needsFixup = pullRequests.filter((pr) => pr.status === 'needs-fixup');

  // Only clear an interactive terminal - in a non-TTY context (e.g. piped output, tests) a clear
  // would just inject raw ANSI escape codes into the stream for no benefit.
  if (process.stdout.isTTY) console.clear();

  console.log(
    `everest watch - ${new Date().toLocaleTimeString()} (polling every ${intervalMs}ms, Ctrl+C to stop)`,
  );
  console.log();
  console.log('Needs human (blocking):');
  if (blockers.length === 0) {
    console.log('  (none)');
  } else {
    for (const blocker of blockers) {
      console.log(`  #${blocker.number} ${blocker.title} [${blocker.branch}]`);
      console.log(`    Last comment: ${blocker.lastComment ?? '(no comment)'}`);
    }
  }
  console.log();
  console.log('Needs fixup (review loop in progress):');
  if (needsFixup.length === 0) {
    console.log('  (none)');
  } else {
    for (const pr of needsFixup) {
      console.log(`  #${pr.number} issue #${pr.issueNumber} [${pr.branch}]`);
    }
  }
}

/**
 * Handles `everest watch`: polls blockers/needs-fixup PRs every `intervalMs` and re-renders the
 * terminal, so an operator can leave it running instead of re-invoking `everest blockers`
 * manually. Runs for `iterations` cycles (default: forever) - the finite form exists so the
 * polling loop is testable without a real wall-clock wait.
 */
export async function runWatch(
  repo: string,
  intervalMs: number,
  iterations = Infinity,
): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await renderWatchSnapshot(repo, intervalMs);
    if (i < iterations - 1) await sleep(intervalMs);
  }
}

/** Parses the optional `--interval <ms>` flag shared by watch-like subcommands. */
function parseIntervalFlag(args: string[], fallback: number): number {
  const index = args.indexOf('--interval');
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('--interval must be a positive number of milliseconds');
  }
  return value;
}

/**
 * Entry point for the `everest` CLI: dispatches to the `ask`/`status`/`blockers`/`watch`
 * subcommands so the harness can be operated directly instead of through hand-typed `gh`
 * commands.
 */
export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  const config = loadConfig();

  switch (command) {
    case 'ask':
      await runAsk(rest, config.githubRepo);
      break;
    case 'status':
      await runStatus(config.githubRepo);
      break;
    case 'blockers':
      await runBlockers(config.githubRepo);
      break;
    case 'watch':
      await runWatch(config.githubRepo, parseIntervalFlag(rest, config.watchPollIntervalMs));
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
