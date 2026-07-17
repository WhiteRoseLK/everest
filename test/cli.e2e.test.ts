import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, runWatch } from '../src/cli.js';

const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

describe('everest CLI end-to-end', () => {
  let tmpRoot: string;
  let originalPath: string | undefined;
  let originalRepo: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-cli-e2e-'));
    originalPath = process.env.PATH;
    originalRepo = process.env.GITHUB_REPO;
    process.env.PATH = `${FAKE_BIN}:${originalPath}`;
    process.env.GITHUB_REPO = 'fake/repo';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = originalRepo;
    delete process.env.FAKE_GH_ISSUE_CREATE_MARKER;
    delete process.env.FAKE_GH_PR_LIST;
    delete process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN;
    delete process.env.FAKE_GH_ISSUE_LIST_CLOSED;
    delete process.env.FAKE_GH_PR_LIST_FAIL_ONCE;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('ask creates an issue with a priority label', async () => {
    const marker = join(tmpRoot, 'issue-create.marker');
    process.env.FAKE_GH_ISSUE_CREATE_MARKER = marker;

    await main(['ask', 'add', 'dark', 'mode', '--priority', 'high']);

    expect(existsSync(marker)).toBe(true);
    const args = readFileSync(marker, 'utf-8');
    expect(args).toContain('add dark mode');
    expect(args).toContain('priority:high');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Issue created'));
  });

  it('status lists open harness PRs with their derived state and recently closed issues', async () => {
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      { number: 5, headRefName: 'harness/issue-3-foo', labels: [{ name: 'needs-fixup' }] },
      { number: 6, headRefName: 'harness/issue-4-bar', labels: [] },
      { number: 7, headRefName: 'some-other-branch', labels: [] },
    ]);
    process.env.FAKE_GH_ISSUE_LIST_CLOSED = JSON.stringify([
      { number: 1, title: 'Old fix', closedAt: new Date().toISOString() },
      { number: 2, title: 'Ancient fix', closedAt: '2000-01-01T00:00:00Z' },
    ]);

    await main(['status']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('#5 issue #3 [harness/issue-3-foo] - needs-fixup');
    expect(output).toContain('#6 issue #4 [harness/issue-4-bar] - open');
    expect(output).not.toContain('some-other-branch');
    expect(output).toContain('Old fix');
    expect(output).not.toContain('Ancient fix');
  });

  it('blockers lists PRs needing human intervention with their last comment', async () => {
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      {
        number: 9,
        title: 'Fix flaky thing',
        headRefName: 'harness/issue-9-fix-flaky-thing',
        comments: [{ body: 'first' }, { body: 'review budget exhausted, please help' }],
      },
    ]);

    await main(['blockers']);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('#9 Fix flaky thing [harness/issue-9-fix-flaky-thing]');
    expect(output).toContain('review budget exhausted, please help');
  });

  it('blockers reports no blockers when nothing is labeled needs-human', async () => {
    process.env.FAKE_GH_PR_LIST = JSON.stringify([]);

    await main(['blockers']);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No blockers'));
  });

  it('watch polls repeatedly and reports both needs-human blockers and needs-fixup PRs', async () => {
    // listHarnessPullRequests (all open PRs, unfiltered) - drives the needs-fixup section.
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      {
        number: 9,
        title: 'Fix flaky thing',
        headRefName: 'harness/issue-9-fix-flaky-thing',
        labels: [{ name: 'needs-human' }],
      },
      {
        number: 5,
        title: 'Add widget',
        headRefName: 'harness/issue-3-add-widget',
        labels: [{ name: 'needs-fixup' }],
      },
    ]);
    // listBlockers (server-side filtered to needs-human) - drives the "needs human" section.
    process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN = JSON.stringify([
      {
        number: 9,
        title: 'Fix flaky thing',
        headRefName: 'harness/issue-9-fix-flaky-thing',
        comments: [{ body: 'review budget exhausted, please help' }],
      },
    ]);

    await runWatch('fake/repo', 1, 2);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('#9 Fix flaky thing [harness/issue-9-fix-flaky-thing]');
    expect(output).toContain('review budget exhausted, please help');
    expect(output).toContain('#5 issue #3 [harness/issue-3-add-widget]');
    // Two iterations means two full snapshots were rendered, not just one.
    const snapshotCount = logSpy.mock.calls.filter((call) =>
      String(call[0]).startsWith('everest watch -'),
    ).length;
    expect(snapshotCount).toBe(2);
  });

  it('watch reports no blockers/fixups when nothing needs attention', async () => {
    process.env.FAKE_GH_PR_LIST = JSON.stringify([]);

    await runWatch('fake/repo', 1, 1);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Needs human (blocking):\n  (none)'.split('\n')[0]);
    const noneCount = logSpy.mock.calls.filter((call) => call[0] === '  (none)').length;
    expect(noneCount).toBe(2);
  });

  it('watch survives a transient gh failure on one iteration and still renders the next', async () => {
    const failMarker = join(tmpRoot, 'pr-list-fail-once.marker');
    writeFileSync(failMarker, '');
    process.env.FAKE_GH_PR_LIST_FAIL_ONCE = failMarker;
    process.env.FAKE_GH_PR_LIST = JSON.stringify([]);

    // Iteration 1's `gh pr list` call fails once (simulated transient error); a poll loop meant
    // to run unattended must not die on that - it should log the error and keep polling.
    await runWatch('fake/repo', 1, 2);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch watch snapshot'),
    );
    const snapshotCount = logSpy.mock.calls.filter((call) =>
      String(call[0]).startsWith('everest watch -'),
    ).length;
    // Iteration 1 fails before it can render a snapshot; iteration 2 succeeds and renders one.
    expect(snapshotCount).toBe(1);
  });
});
