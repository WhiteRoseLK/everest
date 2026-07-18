import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from './config.js';
import {
  createIssue,
  listHarnessPullRequests,
  listRecentlyClosedIssues,
  listBlockers,
} from './github.js';
import { buildCatchupSummary, type CatchupSummary } from './catchup.js';

/** Lookback window used by `everest status` when reporting recently closed issues. */
const RECENT_ISSUES_WINDOW_HOURS = 24;

/**
 * Repository root (where `docker-compose.yml` lives), derived from this file's own location
 * rather than `process.cwd()` - `everest` can be invoked from any directory, but the Docker
 * Compose project it needs to start/reuse for `everest chat` (see `runChat`) is always this
 * checkout's, not whatever directory the operator happens to be standing in.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function printUsage(): void {
  console.log(
    [
      'Usage:',
      '  everest                                          (same as `everest chat`)',
      '  everest chat',
      '  everest ask "<message>" [--priority <critical|high|medium|low>]',
      '  everest status',
      '  everest blockers',
      '  everest catchup',
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
 * Formats a {@link CatchupSummary} into human-readable lines for `everest catchup`, always ending
 * with an explicit call-out of whether human intervention is needed right now - per issue #37,
 * that signal must never be left implicit for the user to infer from a bare list.
 */
function formatCatchupSummary(summary: CatchupSummary): string[] {
  const hoursAgo = Math.max(
    0,
    Math.round((Date.now() - new Date(summary.since).getTime()) / (60 * 60 * 1000)),
  );
  const whenLabel = hoursAgo === 0 ? 'less than an hour ago' : `${hoursAgo}h ago`;

  const lines: string[] = [`Since you last checked (${whenLabel}):`];

  const activity: string[] = [];
  for (const issue of summary.closedIssues) {
    activity.push(`  - Closed: issue #${issue.number} "${issue.title}"`);
  }
  for (const issue of summary.openedIssues) {
    activity.push(`  - Opened: issue #${issue.number} "${issue.title}"`);
  }
  for (const pr of summary.inProgress) {
    activity.push(
      `  - In progress: PR #${pr.number} (issue #${pr.issueNumber}) - needs-fixup, review cycle in progress`,
    );
  }
  lines.push(...(activity.length === 0 ? ['  (nothing happened)'] : activity));

  lines.push('');
  if (summary.blockers.length === 0) {
    lines.push('Nothing needs you right now.');
  } else {
    lines.push('⚠️  Needs you:');
    for (const blocker of summary.blockers) {
      lines.push(`  - PR #${blocker.number} "${blocker.title}" [${blocker.branch}] needs-human`);
      if (blocker.lastComment) lines.push(`    Last comment: ${blocker.lastComment}`);
    }
  }

  return lines;
}

/**
 * Handles `everest catchup`: a "what did I miss" summary covering everything since the user last
 * ran this command (see `buildCatchupSummary` in `src/catchup.ts` for the persisted last-seen
 * timestamp), ending with an explicit "needs you" call-out rather than a bare `gh` data dump.
 */
export async function runCatchup(repo: string, cwd: string = REPO_ROOT): Promise<void> {
  const summary = await buildCatchupSummary(repo, cwd);
  for (const line of formatCatchupSummary(summary)) console.log(line);
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
 *
 * Each iteration is isolated in its own try/catch, mirroring `runLoop` (`src/loop.ts`): a
 * transient `gh` failure (network blip, rate limit, auth hiccup) on one poll must not kill the
 * whole `watch` process, it should just be reported and retried on the next cycle.
 */
export async function runWatch(
  repo: string,
  intervalMs: number,
  iterations = Infinity,
): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    try {
      await renderWatchSnapshot(repo, intervalMs);
    } catch (error) {
      console.error('Failed to fetch watch snapshot, retrying next poll:');
      console.error(error);
    }
    if (i < iterations - 1) await sleep(intervalMs);
  }
}

/**
 * Starts (or reuses, if already running) the harness's Docker Compose service, so `runChat` has
 * a sandbox container to run `claude` inside instead of the bare host. `docker compose up -d` is
 * idempotent - a no-op against an already-running container - so this is safe to call on every
 * `everest chat` invocation, whether or not a harness loop (`npm start` inside that same
 * container) happens to already be using it.
 */
function ensureHarnessContainer(cwd: string): void {
  const result = spawnSync('docker', ['compose', 'up', '-d', 'harness'], {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Failed to start the harness Docker container (exit code ${result.status ?? 'unknown'}). ` +
        `Is Docker running and is docker-compose.yml present in ${cwd}?`,
    );
  }
}

/**
 * Handles `everest chat` (and bare `everest`): starts/reuses the harness's Docker Compose
 * container (`ensureHarnessContainer`) and opens an interactive `claude` session *inside* it
 * (`docker compose exec -it`) using the `chat` agent (`.claude/agents/chat.md`), so a human can
 * converse with everest in natural language instead of memorizing one-shot subcommands.
 *
 * Unlike the previous design, this now runs `--permission-mode bypassPermissions` (same as
 * `issue-worker`/`code-reviewer` - see `runAgent` in `src/claude.ts`): tool calls (mostly `gh`
 * commands) execute without a per-call approval prompt, which only became safe to do here once
 * the session was moved inside the Docker sandbox (see "Known Pitfalls" in CLAUDE.md - headless
 * mode plus blanket permission bypass is a package deal confined to the container, and `-it`
 * makes this an interactive TTY session rather than headless, but the confinement is what makes
 * bypassing approval prompts acceptable, not the human's presence at the keyboard).
 */
export function runChat(repo: string, cwd: string = REPO_ROOT): number {
  const systemPromptAppend =
    `You are "everest chat", the conversational interface for the everest harness in ` +
    `repository ${repo}. Use the gh CLI (already authenticated, scoped to --repo ${repo}) to ` +
    `answer questions about harness status (open PRs, review-loop state), blockers (PRs ` +
    `labeled needs-human), and to file new issues on the user's behalf when asked - mirroring ` +
    `'everest status', 'everest blockers' and 'everest ask'. When asked something like "what did ` +
    `I miss" or "what's the status", proactively run 'node bin/everest.js catchup' (from /app) ` +
    `instead of just answering literally - it gives a team-style summary since the user last ` +
    `checked in and always ends with an explicit "needs you" call-out. Keep answers short and ` +
    `terminal-friendly.`;

  ensureHarnessContainer(cwd);

  const result = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-it',
      'harness',
      'claude',
      '--agent',
      'chat',
      '--permission-mode',
      'bypassPermissions',
      '--append-system-prompt',
      systemPromptAppend,
    ],
    { cwd, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  return result.status ?? 0;
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
 * Entry point for the `everest` CLI: dispatches to the `chat`/`ask`/`status`/`blockers`/`watch`
 * subcommands so the harness can be operated directly instead of through hand-typed `gh`
 * commands. Bare `everest` (no subcommand) opens the interactive chat session too - the CLI's
 * default mode is conversational, one-shot subcommands are the shortcut, not the other way
 * around.
 */
export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  const config = loadConfig();

  switch (command) {
    case undefined:
    case 'chat':
      process.exitCode = runChat(config.githubRepo);
      break;
    case 'ask':
      await runAsk(rest, config.githubRepo);
      break;
    case 'status':
      await runStatus(config.githubRepo);
      break;
    case 'blockers':
      await runBlockers(config.githubRepo);
      break;
    case 'catchup':
      await runCatchup(config.githubRepo);
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
