import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  loadEventLog,
  peekUndrainedEvents,
  drainEvents,
  formatEvents,
  type HarnessEvent,
} from '../src/eventlog.js';

const completed: HarnessEvent = {
  timestamp: '2026-07-18T00:00:00Z',
  kind: 'completed',
  issueNumber: 1,
  title: 'Add dark mode',
  description: 'PR merged by code-reviewer',
};

const needsHuman: HarnessEvent = {
  timestamp: '2026-07-18T00:01:00Z',
  kind: 'needs-human',
  issueNumber: 2,
  title: 'Flaky test',
  description: 'review cycles exhausted (3) without approval',
};

describe('event log', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'everest-eventlog-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns an empty log and no undrained events when nothing has been recorded yet', () => {
    expect(loadEventLog(cwd)).toEqual([]);
    expect(peekUndrainedEvents(cwd)).toEqual([]);
    expect(drainEvents(cwd)).toEqual([]);
  });

  it('creates the log directory/file on the first appended event', () => {
    expect(existsSync(join(cwd, '.harness/event-log.jsonl'))).toBe(false);

    appendEvent(completed, cwd);

    expect(existsSync(join(cwd, '.harness/event-log.jsonl'))).toBe(true);
  });

  it('appends events across multiple calls and reads them back in order', () => {
    appendEvent(completed, cwd);
    appendEvent(needsHuman, cwd);

    const log = loadEventLog(cwd);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual(completed);
    expect(log[1]).toEqual(needsHuman);
  });

  it('drains only events appended since the last drain', () => {
    appendEvent(completed, cwd);

    const firstDrain = drainEvents(cwd);
    expect(firstDrain).toEqual([completed]);

    // Nothing new since the last drain - a second call must come back empty rather than
    // re-showing the same event.
    expect(drainEvents(cwd)).toEqual([]);

    appendEvent(needsHuman, cwd);
    expect(drainEvents(cwd)).toEqual([needsHuman]);
  });

  it('peeking does not advance the drained marker', () => {
    appendEvent(completed, cwd);

    expect(peekUndrainedEvents(cwd)).toEqual([completed]);
    // Peeking twice in a row still returns the same pending event - it's non-destructive.
    expect(peekUndrainedEvents(cwd)).toEqual([completed]);

    expect(drainEvents(cwd)).toEqual([completed]);
    expect(peekUndrainedEvents(cwd)).toEqual([]);
  });

  it('formats drained events into terminal-friendly lines, one per event', () => {
    const lines = formatEvents([completed, needsHuman]);

    expect(lines[0]).toBe('While you were away:');
    expect(lines).toContainEqual(expect.stringContaining('issue #1 "Add dark mode"'));
    expect(lines).toContainEqual(expect.stringContaining('issue #2 "Flaky test"'));
  });

  it('formats an empty event list as no lines at all', () => {
    expect(formatEvents([])).toEqual([]);
  });
});
