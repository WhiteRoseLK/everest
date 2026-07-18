import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The kinds of harness activity worth surfacing to a human unprompted (issue #42). Kept to the
 * events the loop can observe directly, not every internal state transition:
 * - `completed`: an issue's PR was merged (the issue is done).
 * - `needs-fixup`: code-reviewer requested changes, issue-worker is being re-invoked.
 * - `needs-human`: the harness gave up on something automatically - review cycles exhausted,
 *   a retry cap hit, or any other path that escalates to a human.
 */
export type HarnessEventKind = 'completed' | 'needs-fixup' | 'needs-human';

/**
 * One recorded harness event, appended as-it-happens by `src/loop.ts` to a persisted log so
 * `everest chat`/`everest events` can present "what happened while you were away" without
 * re-querying GitHub for a summary (unlike `src/catchup.ts`, which recomputes on demand).
 */
export interface HarnessEvent {
  timestamp: string;
  kind: HarnessEventKind;
  issueNumber: number;
  title: string;
  description: string;
}

/**
 * Where the append-only event log lives (gitignored, alongside `.harness/state.json` and
 * `.harness/cost-log.jsonl` - same JSON Lines convention as {@link recordCost} in `src/cost.ts`).
 */
const EVENT_LOG_PATH = '.harness/event-log.jsonl';

/**
 * Where the "how many events have already been drained/shown" marker is persisted. A plain
 * count of already-log lines rather than a timestamp (unlike `catchup-last-seen.json` in
 * `src/catchup.ts`): the event log only ever grows by appending, so an offset into it is simpler
 * and avoids any clock-skew/tie-breaking edge cases a timestamp comparison would need.
 */
const DRAINED_MARKER_PATH = '.harness/event-log-drained.json';

/**
 * Appends one event to the harness's event log (JSON Lines), creating the containing directory
 * if needed. Called by `src/loop.ts` whenever something notable happens (a PR merges, a review
 * cycle requests changes, the harness escalates to a human) so it can be surfaced later without
 * re-deriving it from GitHub state.
 */
export function appendEvent(event: HarnessEvent, cwd: string): void {
  const path = `${cwd}/${EVENT_LOG_PATH}`;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

/** Reads and parses every event recorded so far, or an empty array if none exist yet. */
export function loadEventLog(cwd: string): HarnessEvent[] {
  const path = `${cwd}/${EVENT_LOG_PATH}`;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as HarnessEvent);
}

/** Reads how many events have already been drained, or 0 if the marker has never been written. */
function loadDrainedCount(cwd: string): number {
  const path = `${cwd}/${DRAINED_MARKER_PATH}`;
  if (!existsSync(path)) return 0;
  const { count } = JSON.parse(readFileSync(path, 'utf-8')) as { count: number };
  return count;
}

/** Persists `count` as the new drained marker. */
function saveDrainedCount(count: number, cwd: string): void {
  const path = `${cwd}/${DRAINED_MARKER_PATH}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ count }, null, 2));
}

/**
 * Returns events appended since the marker was last advanced, without advancing it - a
 * non-destructive peek. Currently unused directly (see {@link drainEvents}), kept as the
 * building block a future "peek without consuming" caller could use without duplicating the
 * offset math.
 */
export function peekUndrainedEvents(cwd: string): HarnessEvent[] {
  return loadEventLog(cwd).slice(loadDrainedCount(cwd));
}

/**
 * Returns events appended since the marker was last advanced, and advances it so a subsequent
 * call only returns events appended after this one - "drain" as in emptying a queue. This is the
 * single primitive both draining points from issue #42 are built on: `everest chat`'s session
 * start (`runChat`, `src/cli.ts`) calls it directly so unread events are the very first thing
 * shown, and `everest events` (also `src/cli.ts`) exposes the same call for the `chat` agent to
 * run at the start of every turn (`.claude/agents/chat.md`) as a pragmatic, best-effort
 * approximation of live notification - see issue #42's discussion of why true async push into an
 * already-open turn-based session isn't achievable without a bigger architecture change.
 */
export function drainEvents(cwd: string): HarnessEvent[] {
  const all = loadEventLog(cwd);
  const drained = loadDrainedCount(cwd);
  const pending = all.slice(drained);
  if (pending.length > 0) saveDrainedCount(all.length, cwd);
  return pending;
}

/**
 * Renders drained/peeked events as short, terminal-friendly lines - one per event, prefixed with
 * an icon by kind so a `needs-human` escalation visually stands out from routine completions.
 * Shared by `everest events` and the drain-on-open path in `runChat` so the two call sites never
 * drift into inconsistent formatting.
 */
export function formatEvents(events: HarnessEvent[]): string[] {
  if (events.length === 0) return [];
  const icon: Record<HarnessEventKind, string> = {
    completed: '✅',
    'needs-fixup': '🔁',
    'needs-human': '⚠️ ',
  };
  return [
    'While you were away:',
    ...events.map(
      (event) =>
        `  ${icon[event.kind]} issue #${event.issueNumber} "${event.title}" - ${event.description}`,
    ),
  ];
}
