import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCatchupSummary,
  loadLastCatchupAt,
  saveLastCatchupAt,
  DEFAULT_CATCHUP_WINDOW_HOURS,
} from '../src/catchup.js';

const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

describe('buildCatchupSummary', () => {
  let tmpRoot: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-catchup-e2e-'));
    originalPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_GH_ISSUE_LIST_CLOSED;
    delete process.env.FAKE_GH_ISSUE_LIST_OPENED_SINCE;
    delete process.env.FAKE_GH_PR_LIST;
    delete process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('falls back to the default window and persists a last-seen timestamp on first run', async () => {
    expect(loadLastCatchupAt(tmpRoot)).toBeNull();

    const before = Date.now();
    const summary = await buildCatchupSummary('fake/repo', tmpRoot);
    const after = Date.now();

    const sinceMs = new Date(summary.since).getTime();
    const expectedSinceMs = before - DEFAULT_CATCHUP_WINDOW_HOURS * 60 * 60 * 1000;
    // Allow a small tolerance for wall-clock drift between `before` and the call itself.
    expect(Math.abs(sinceMs - expectedSinceMs)).toBeLessThan(5000);

    expect(existsSync(join(tmpRoot, '.harness/catchup-last-seen.json'))).toBe(true);
    const persisted = loadLastCatchupAt(tmpRoot);
    expect(persisted).not.toBeNull();
    expect(new Date(persisted!).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(persisted!).getTime()).toBeLessThanOrEqual(after);
  });

  it('uses the persisted last-seen timestamp on subsequent runs instead of the default window', async () => {
    const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    saveLastCatchupAt(earlier, tmpRoot);

    const summary = await buildCatchupSummary('fake/repo', tmpRoot);

    expect(summary.since).toBe(earlier);
  });

  it('advances the persisted marker so a second call in a row covers a fresh (empty) window', async () => {
    await buildCatchupSummary('fake/repo', tmpRoot);
    const firstMarker = loadLastCatchupAt(tmpRoot);

    const second = await buildCatchupSummary('fake/repo', tmpRoot);

    expect(second.since).toBe(firstMarker);
  });

  it('does not advance the marker when persist is false', async () => {
    saveLastCatchupAt(new Date(Date.now() - 60 * 60 * 1000).toISOString(), tmpRoot);
    const before = loadLastCatchupAt(tmpRoot);

    await buildCatchupSummary('fake/repo', tmpRoot, { persist: false });

    expect(loadLastCatchupAt(tmpRoot)).toBe(before);
  });

  it('aggregates closed issues, opened issues, in-progress PRs and needs-human blockers', async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    saveLastCatchupAt(since, tmpRoot);

    process.env.FAKE_GH_ISSUE_LIST_CLOSED = JSON.stringify([
      { number: 12, title: 'Add dark mode', closedAt: new Date().toISOString() },
      { number: 1, title: 'Ancient fix', closedAt: '2000-01-01T00:00:00Z' },
    ]);
    process.env.FAKE_GH_ISSUE_LIST_OPENED_SINCE = JSON.stringify([
      { number: 17, title: 'Follow-up: tighten X', createdAt: new Date().toISOString() },
      { number: 2, title: 'Old backlog item', createdAt: '2000-01-01T00:00:00Z' },
    ]);
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      {
        number: 25,
        headRefName: 'harness/issue-15-something',
        labels: [{ name: 'needs-fixup' }],
      },
      {
        number: 22,
        headRefName: 'harness/issue-9-other',
        labels: [{ name: 'needs-human' }],
      },
    ]);
    process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN = JSON.stringify([
      {
        number: 22,
        title: 'Fix flaky test',
        headRefName: 'harness/issue-9-other',
        comments: [{ body: 'reviewer could not resolve X after 3 cycles' }],
      },
    ]);

    const summary = await buildCatchupSummary('fake/repo', tmpRoot);

    expect(summary.closedIssues).toEqual([
      { number: 12, title: 'Add dark mode', closedAt: expect.any(String) },
    ]);
    expect(summary.openedIssues).toEqual([
      { number: 17, title: 'Follow-up: tighten X', createdAt: expect.any(String) },
    ]);
    expect(summary.inProgress).toEqual([
      { number: 25, branch: 'harness/issue-15-something', issueNumber: 15, status: 'needs-fixup' },
    ]);
    expect(summary.blockers).toHaveLength(1);
    expect(summary.blockers[0]).toMatchObject({
      number: 22,
      title: 'Fix flaky test',
      lastComment: 'reviewer could not resolve X after 3 cycles',
    });
  });
});
