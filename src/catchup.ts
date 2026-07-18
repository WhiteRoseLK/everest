import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  listBlockers,
  listHarnessPullRequests,
  listIssuesOpenedSince,
  listRecentlyClosedIssues,
  type Blocker,
  type ClosedIssueSummary,
  type HarnessPullRequestSummary,
  type OpenedIssueSummary,
} from './github.js';

/**
 * Where the "last time `everest catchup` was shown" timestamp is persisted (gitignored, see
 * `.harness/` in `.gitignore`). Mirrors `STATE_PATH` in `src/state.ts` but tracks a different
 * concern - "when did the user last check in", not "which issue is in progress".
 */
const LAST_SEEN_PATH = '.harness/catchup-last-seen.json';

/**
 * Lookback window used only the very first time `everest catchup` runs, before any last-seen
 * timestamp has been persisted - there is nothing to anchor "since you last checked" to yet, so
 * this picks a reasonable default instead of dumping the repo's entire history.
 */
export const DEFAULT_CATCHUP_WINDOW_HOURS = 24;

/** Reads the timestamp `everest catchup` was last shown, or null if it has never run before. */
export function loadLastCatchupAt(cwd: string): string | null {
  const path = `${cwd}/${LAST_SEEN_PATH}`;
  if (!existsSync(path)) return null;
  const { timestamp } = JSON.parse(readFileSync(path, 'utf-8')) as { timestamp: string };
  return timestamp;
}

/** Persists `timestamp` as the new last-seen marker, so the next `everest catchup` starts from here. */
export function saveLastCatchupAt(timestamp: string, cwd: string): void {
  const path = `${cwd}/${LAST_SEEN_PATH}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ timestamp }, null, 2));
}

export interface CatchupSummary {
  /** ISO timestamp the summary covers activity since. */
  since: string;
  closedIssues: ClosedIssueSummary[];
  openedIssues: OpenedIssueSummary[];
  /** Harness PRs currently mid review-cycle (labeled `needs-fixup`). */
  inProgress: HarnessPullRequestSummary[];
  /** PRs labeled `needs-human` - the explicit "needs you" signal. */
  blockers: Blocker[];
}

/**
 * Builds a "what did I miss" summary covering everything since the last time `everest catchup`
 * was shown, rather than a fixed lookback window - the persisted timestamp (`loadLastCatchupAt`/
 * `saveLastCatchupAt`) means the summary always covers exactly the gap since the user last
 * checked in, per issue #37. Falls back to {@link DEFAULT_CATCHUP_WINDOW_HOURS} the first time
 * this ever runs. Reuses the same building blocks as `everest status`/`everest blockers`
 * (`listRecentlyClosedIssues`, `listHarnessPullRequests`, `listBlockers`) rather than inventing
 * new `gh` queries for those.
 *
 * Persists a fresh last-seen timestamp as a side effect once the summary is built (unless
 * `persist: false` is passed, e.g. for tests that want to inspect the summary without advancing
 * the marker) - calling this twice in a row would otherwise yield an empty second summary.
 */
export async function buildCatchupSummary(
  repo: string,
  cwd: string,
  { persist = true }: { persist?: boolean } = {},
): Promise<CatchupSummary> {
  const previous = loadLastCatchupAt(cwd);
  const since =
    previous ?? new Date(Date.now() - DEFAULT_CATCHUP_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const hoursSinceCutoff = Math.max(0, (Date.now() - new Date(since).getTime()) / (60 * 60 * 1000));

  const [closedIssues, openedIssues, pullRequests, blockers] = await Promise.all([
    listRecentlyClosedIssues(repo, hoursSinceCutoff),
    listIssuesOpenedSince(repo, since),
    listHarnessPullRequests(repo),
    listBlockers(repo),
  ]);

  if (persist) saveLastCatchupAt(new Date().toISOString(), cwd);

  return {
    since,
    closedIssues,
    openedIssues,
    inProgress: pullRequests.filter((pr) => pr.status === 'needs-fixup'),
    blockers,
  };
}
