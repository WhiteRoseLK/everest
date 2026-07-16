import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * One recorded `claude -p` invocation's token cost, as reported by its `total_cost_usd` field.
 * `label` identifies what was being worked on (e.g. `issue-#42`, `code-reviewer:harness/...`)
 * so entries can be grouped/filtered later without re-parsing prompts.
 */
export interface CostEntry {
  timestamp: string;
  agent: string;
  label: string;
  totalCostUsd: number;
}

const COST_LOG_PATH = '.harness/cost-log.jsonl';

/**
 * Appends one cost entry to the harness's running cost log (JSON Lines), creating the
 * containing directory if needed. This is the measurement referenced by issue #13: integrating
 * a context-compression tool like Headroom was explicitly deferred until token cost is measured
 * to actually be a problem, rather than optimized prematurely - this log is what makes that
 * measurement possible.
 */
export function recordCost(entry: CostEntry, cwd: string): void {
  const path = `${cwd}/${COST_LOG_PATH}`;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/** Reads and parses every cost entry recorded so far, or an empty array if none exist yet. */
export function loadCostLog(cwd: string): CostEntry[] {
  const path = `${cwd}/${COST_LOG_PATH}`;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CostEntry);
}

/** Sums `totalCostUsd` across every recorded entry, e.g. to report cumulative spend so far. */
export function totalRecordedCostUsd(cwd: string): number {
  return loadCostLog(cwd).reduce((sum, entry) => sum + entry.totalCostUsd, 0);
}
