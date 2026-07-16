import { describe, it, expect } from 'vitest';
import { pickNextIssue } from '../src/loop.js';
import type { Issue } from '../src/github.js';

function makeIssue(number: number, createdAt: string, labels: string[] = []): Issue {
  return { number, title: `Issue ${number}`, labels, createdAt };
}

describe('pickNextIssue', () => {
  it('picks the oldest issue when no priority labels are present (FIFO)', () => {
    const older = makeIssue(1, '2026-01-01T00:00:00Z');
    const newer = makeIssue(2, '2026-01-02T00:00:00Z');

    expect(pickNextIssue([newer, older])).toBe(older);
  });

  it('picks a priority:high issue over older non-prioritized issues', () => {
    const older = makeIssue(1, '2026-01-01T00:00:00Z');
    const newerHighPriority = makeIssue(2, '2026-01-02T00:00:00Z', ['priority:high']);

    expect(pickNextIssue([older, newerHighPriority])).toBe(newerHighPriority);
  });

  it('keeps FIFO order among multiple priority:high issues', () => {
    const olderHigh = makeIssue(1, '2026-01-01T00:00:00Z', ['priority:high']);
    const newerHigh = makeIssue(2, '2026-01-02T00:00:00Z', ['priority:high']);

    expect(pickNextIssue([newerHigh, olderHigh])).toBe(olderHigh);
  });

  it('returns null for an empty issue list', () => {
    expect(pickNextIssue([])).toBeNull();
  });

  it('picks priority:critical over priority:high', () => {
    const high = makeIssue(1, '2026-01-01T00:00:00Z', ['priority:high']);
    const critical = makeIssue(2, '2026-01-02T00:00:00Z', ['priority:critical']);

    expect(pickNextIssue([high, critical])).toBe(critical);
  });

  it('orders all four priority tiers from critical to low', () => {
    const low = makeIssue(1, '2026-01-01T00:00:00Z', ['priority:low']);
    const medium = makeIssue(2, '2026-01-02T00:00:00Z', ['priority:medium']);
    const high = makeIssue(3, '2026-01-03T00:00:00Z', ['priority:high']);
    const critical = makeIssue(4, '2026-01-04T00:00:00Z', ['priority:critical']);
    const all = [low, medium, high, critical];

    expect(pickNextIssue(all)).toBe(critical);
    expect(pickNextIssue(all.filter((i) => i !== critical))).toBe(high);
    expect(pickNextIssue(all.filter((i) => i !== critical && i !== high))).toBe(medium);
  });

  it('treats unlabeled issues as priority:medium, below priority:high and above priority:low', () => {
    const unlabeled = makeIssue(1, '2026-01-01T00:00:00Z');
    const low = makeIssue(2, '2026-01-02T00:00:00Z', ['priority:low']);
    const high = makeIssue(3, '2026-01-03T00:00:00Z', ['priority:high']);

    expect(pickNextIssue([unlabeled, low])).toBe(unlabeled);
    expect(pickNextIssue([unlabeled, high])).toBe(high);
  });

  it('ignores type:* labels when ranking, using only priority tiers', () => {
    const bug = makeIssue(1, '2026-01-01T00:00:00Z', ['type:bug', 'priority:low']);
    const feature = makeIssue(2, '2026-01-02T00:00:00Z', ['type:feature', 'priority:high']);

    expect(pickNextIssue([bug, feature])).toBe(feature);
  });
});
