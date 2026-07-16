import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCost, loadCostLog, totalRecordedCostUsd } from '../src/cost.js';

describe('cost log', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'everest-cost-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns an empty log when no entry has been recorded yet', () => {
    expect(loadCostLog(cwd)).toEqual([]);
    expect(totalRecordedCostUsd(cwd)).toBe(0);
  });

  it('creates the log directory/file on the first recorded entry', () => {
    expect(existsSync(join(cwd, '.harness/cost-log.jsonl'))).toBe(false);

    recordCost(
      {
        timestamp: '2026-07-16T00:00:00Z',
        agent: 'issue-worker',
        label: 'issue-#1',
        totalCostUsd: 0.01,
      },
      cwd,
    );

    expect(existsSync(join(cwd, '.harness/cost-log.jsonl'))).toBe(true);
  });

  it('appends entries across multiple calls and reads them back in order', () => {
    recordCost(
      {
        timestamp: '2026-07-16T00:00:00Z',
        agent: 'issue-worker',
        label: 'issue-#1',
        totalCostUsd: 0.01,
      },
      cwd,
    );
    recordCost(
      {
        timestamp: '2026-07-16T00:01:00Z',
        agent: 'code-reviewer',
        label: 'code-reviewer:branch',
        totalCostUsd: 0.02,
      },
      cwd,
    );

    const log = loadCostLog(cwd);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({
      timestamp: '2026-07-16T00:00:00Z',
      agent: 'issue-worker',
      label: 'issue-#1',
      totalCostUsd: 0.01,
    });
    expect(log[1].agent).toBe('code-reviewer');
  });

  it('sums totalCostUsd across all recorded entries', () => {
    recordCost(
      {
        timestamp: '2026-07-16T00:00:00Z',
        agent: 'issue-worker',
        label: 'issue-#1',
        totalCostUsd: 0.01,
      },
      cwd,
    );
    recordCost(
      {
        timestamp: '2026-07-16T00:01:00Z',
        agent: 'code-reviewer',
        label: 'code-reviewer:branch',
        totalCostUsd: 0.02,
      },
      cwd,
    );

    expect(totalRecordedCostUsd(cwd)).toBeCloseTo(0.03);
  });
});
