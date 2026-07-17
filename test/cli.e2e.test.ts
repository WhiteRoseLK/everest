import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

describe('everest CLI end-to-end', () => {
  let tmpRoot: string;
  let originalPath: string | undefined;
  let originalRepo: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-cli-e2e-'));
    originalPath = process.env.PATH;
    originalRepo = process.env.GITHUB_REPO;
    process.env.PATH = `${FAKE_BIN}:${originalPath}`;
    process.env.GITHUB_REPO = 'fake/repo';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = originalRepo;
    delete process.env.FAKE_GH_ISSUE_CREATE_MARKER;
    delete process.env.FAKE_GH_PR_LIST;
    delete process.env.FAKE_GH_ISSUE_LIST_CLOSED;
    logSpy.mockRestore();
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
});
