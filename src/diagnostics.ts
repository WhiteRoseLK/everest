import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Where iteration errors are persisted (JSON Lines, gitignored under `.harness/` like the rest of
 * the harness's runtime state). Mirrors `STATE_PATH`/`COST_LOG_PATH` but tracks a different
 * concern: "what went wrong on a loop iteration" - so a silent stall (the loop is alive but never
 * makes progress, see issue #82) becomes diagnosable from `everest doctor`/`everest chat` without
 * needing access to the container's stdout, which isn't reachable once the process is pid 1.
 */
const ERROR_LOG_PATH = '.harness/errors.jsonl';

/** Default number of most-recent errors {@link loadIterationErrors} returns. */
const DEFAULT_ERROR_LIMIT = 20;

/** One persisted loop-iteration error: when it happened and what was thrown. */
export interface IterationError {
  timestamp: string;
  message: string;
  stack?: string;
}

/** Serializes an unknown thrown value into a persistable {@link IterationError} record. */
function toIterationError(error: unknown): IterationError {
  const timestamp = new Date().toISOString();
  if (error instanceof Error) {
    return { timestamp, message: error.message, stack: error.stack };
  }
  return { timestamp, message: String(error) };
}

/**
 * Best-effort append of a loop-iteration error to `.harness/errors.jsonl`, so a silently caught
 * failure in {@link runLoop}'s per-iteration try/catch leaves a durable trace instead of vanishing
 * into the container's unreachable stdout (issue #82). Never throws: if even this write fails - the
 * very condition (`.harness/` not writable, e.g. the EACCES of issue #75) that most often causes
 * the loop to stall in the first place - it surfaces that loudly on stderr rather than masking the
 * original error with a secondary one.
 */
export function recordIterationError(error: unknown, cwd: string): void {
  const path = join(cwd, ERROR_LOG_PATH);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(toIterationError(error))}\n`);
  } catch (writeError) {
    console.error(
      `Failed to persist an iteration error to ${ERROR_LOG_PATH} (is .harness/ writable? see issue #75):`,
      writeError,
    );
  }
}

/**
 * Reads the most recent persisted iteration errors (newest last), or an empty array if none exist
 * yet. Skips malformed lines rather than throwing, so a single truncated/corrupt record (e.g. a
 * crash mid-append) never makes the whole diagnostic unreadable.
 */
export function loadIterationErrors(cwd: string, limit = DEFAULT_ERROR_LIMIT): IterationError[] {
  const path = join(cwd, ERROR_LOG_PATH);
  if (!existsSync(path)) return [];
  const entries: IterationError[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as IterationError);
    } catch {
      // Ignore a corrupt/truncated line rather than failing the whole read.
    }
  }
  return entries.slice(-limit);
}

/** Result of the {@link checkHarnessWritable} preflight probe. */
export interface HarnessWritableCheck {
  writable: boolean;
  error?: string;
}

/**
 * Probes whether `.harness/` is actually writable *right now* by creating and deleting a witness
 * file, rather than inferring it from the mere presence/absence of state files. This is what turns
 * the EACCES class of failure (issue #75: `.harness/` owned by root when the bind mount isn't uid
 * 1000) into an explicit, diagnosable signal from `everest doctor` - otherwise an unwritable
 * `.harness/` looks identical to "no errors recorded yet" (the log itself can't be written), which
 * is exactly the ambiguity that made issue #82 invisible from `everest chat`.
 */
export function checkHarnessWritable(cwd: string): HarnessWritableCheck {
  const witness = join(cwd, '.harness', `.write-probe-${process.pid}`);
  try {
    mkdirSync(dirname(witness), { recursive: true });
    writeFileSync(witness, '');
    rmSync(witness, { force: true });
    return { writable: true };
  } catch (error) {
    return { writable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Probes whether `.git` is actually writable *right now*, the same way {@link checkHarnessWritable}
 * probes `.harness/`. This exists because `runIteration`'s very first move on every cycle is a git
 * operation (`checkoutMain`), so an unwritable `.git` (the bind-mount ownership issue of issue #84)
 * fails identically on every single poll - without a dedicated probe this looks, from the outside,
 * exactly like any other transient per-iteration error swallowed by `runLoop`'s try/catch, instead
 * of the permanent, actionable condition it actually is (issue #94). Unlike `.harness/`, `.git` is
 * expected to already exist (this *is* the harness's own repo checkout), so a missing `.git` is
 * reported as not-writable too rather than silently treated as fine.
 */
export function checkGitWritable(cwd: string): HarnessWritableCheck {
  const gitDir = join(cwd, '.git');
  if (!existsSync(gitDir)) {
    return { writable: false, error: `${gitDir} does not exist` };
  }
  const witness = join(gitDir, `.write-probe-${process.pid}`);
  try {
    writeFileSync(witness, '');
    rmSync(witness, { force: true });
    return { writable: true };
  } catch (error) {
    return { writable: false, error: error instanceof Error ? error.message : String(error) };
  }
}
