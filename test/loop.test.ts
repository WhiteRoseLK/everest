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
});
