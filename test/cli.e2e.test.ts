import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, runWatch, runChat, runCatchup } from '../src/cli.js';

const CHAT_MARKER = '/tmp/fake-chat-invoked.marker';
const DOCKER_COMPOSE_UP_MARKER = '/tmp/fake-docker-compose-up.marker';

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
    delete process.env.FAKE_GH_COMMENT_MARKER;
    delete process.env.FAKE_GH_PR_LIST;
    delete process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN;
    delete process.env.FAKE_GH_ISSUE_LIST_CLOSED;
    delete process.env.FAKE_GH_ISSUE_LIST_OPENED_SINCE;
    delete process.env.FAKE_GH_PR_LIST_FAIL_ONCE;
    delete process.env.FAKE_CLAUDE_CHAT_EXIT_CODE;
    delete process.env.FAKE_DOCKER_COMPOSE_UP_EXIT_CODE;
    rmSync(CHAT_MARKER, { force: true });
    rmSync(DOCKER_COMPOSE_UP_MARKER, { force: true });
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

  it('ask infers a type label (bug/enhancement/documentation/question) automatically', async () => {
    const marker = join(tmpRoot, 'issue-create.marker');
    process.env.FAKE_GH_ISSUE_CREATE_MARKER = marker;

    await main(['ask', 'The', 'app', 'crashes', 'on', 'submit']);

    const args = readFileSync(marker, 'utf-8');
    expect(args).toContain('--label bug');
  });

  it('ask splits a bulleted multi-topic message into several issues', async () => {
    const marker = join(tmpRoot, 'issue-create.marker');
    process.env.FAKE_GH_ISSUE_CREATE_MARKER = marker;
    process.env.FAKE_GH_COMMENT_MARKER = join(tmpRoot, 'comment.marker');

    await main(['ask', '- add dark mode\n- fix the flaky login test']);

    const createCalls = readFileSync(marker, 'utf-8')
      .split('---FAKE_GH_ISSUE_CREATE_END---')
      .map((call) => call.trim())
      .filter((call) => call.length > 0);
    expect(createCalls).toHaveLength(2);
    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Split into 2 issues');
  });

  it('ask derives a short title instead of passing the full message as --title', async () => {
    const marker = join(tmpRoot, 'issue-create.marker');
    process.env.FAKE_GH_ISSUE_CREATE_MARKER = marker;

    const longMessage = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');

    await main(['ask', ...longMessage.split(' ')]);

    const args = readFileSync(marker, 'utf-8');
    const titleMatch = /--title\s+(\S+(?:\s\S+)*?)\s+--body/.exec(args);
    expect(titleMatch).not.toBeNull();
    const title = titleMatch?.[1] ?? '';
    expect(title.length).toBeLessThanOrEqual(81);
    expect(args).toContain(longMessage);
  });

  it('chat starts/reuses the harness Docker container and runs claude inside it', () => {
    const status = runChat('fake/repo');

    expect(status).toBe(0);
    // The harness container was started (or reused) before the interactive session ran.
    expect(existsSync(DOCKER_COMPOSE_UP_MARKER)).toBe(true);
    expect(readFileSync(DOCKER_COMPOSE_UP_MARKER, 'utf-8')).toContain('compose up -d harness');
    // The `claude` invocation itself happened inside the container (`docker compose exec -it
    // harness claude ...`), with bypassPermissions now safe to use since it's sandboxed there.
    expect(existsSync(CHAT_MARKER)).toBe(true);
    const args = readFileSync(CHAT_MARKER, 'utf-8');
    expect(args).toContain('--agent chat');
    expect(args).toContain('--permission-mode bypassPermissions');
    expect(args).toContain('fake/repo');
  });

  it('chat propagates the exit code of the underlying claude process', () => {
    process.env.FAKE_CLAUDE_CHAT_EXIT_CODE = '3';

    const status = runChat('fake/repo');

    expect(status).toBe(3);
  });

  it('chat fails fast if the harness container fails to start', () => {
    process.env.FAKE_DOCKER_COMPOSE_UP_EXIT_CODE = '1';

    expect(() => runChat('fake/repo')).toThrow(/Failed to start the harness Docker container/);
    // Since the container never came up, claude inside it must never have been invoked.
    expect(existsSync(CHAT_MARKER)).toBe(false);
  });

  it('bare `everest` (no subcommand) opens chat the same as `everest chat`', async () => {
    await main([]);

    expect(existsSync(CHAT_MARKER)).toBe(true);
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

  it('catchup summarizes closed/opened issues, in-progress PRs, and calls out needs-human blockers', async () => {
    process.env.FAKE_GH_ISSUE_LIST_CLOSED = JSON.stringify([
      { number: 12, title: 'Add dark mode', closedAt: new Date().toISOString() },
    ]);
    process.env.FAKE_GH_ISSUE_LIST_OPENED_SINCE = JSON.stringify([
      { number: 17, title: 'Follow-up: tighten X', createdAt: new Date().toISOString() },
    ]);
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      { number: 25, headRefName: 'harness/issue-15-something', labels: [{ name: 'needs-fixup' }] },
      { number: 22, headRefName: 'harness/issue-9-other', labels: [{ name: 'needs-human' }] },
    ]);
    process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN = JSON.stringify([
      {
        number: 22,
        title: 'Fix flaky test',
        headRefName: 'harness/issue-9-other',
        comments: [{ body: 'reviewer could not resolve X after 3 cycles' }],
      },
    ]);

    await runCatchup('fake/repo', tmpRoot);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Since you last checked');
    expect(output).toContain('Closed: issue #12 "Add dark mode"');
    expect(output).toContain('Opened: issue #17 "Follow-up: tighten X"');
    expect(output).toContain('In progress: PR #25 (issue #15)');
    expect(output).toContain('⚠️');
    expect(output).toContain('Needs you');
    expect(output).toContain('PR #22 "Fix flaky test"');
    expect(output).toContain('reviewer could not resolve X after 3 cycles');
  });

  it('catchup reports nothing needs you when there are no needs-human blockers', async () => {
    process.env.FAKE_GH_PR_LIST = JSON.stringify([]);

    await runCatchup('fake/repo', tmpRoot);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Nothing needs you right now.');
    expect(output).toContain('(nothing happened)');
  });

  it('catchup persists a last-seen timestamp so a second call covers a fresh window', async () => {
    process.env.FAKE_GH_ISSUE_LIST_CLOSED = JSON.stringify([
      { number: 12, title: 'Add dark mode', closedAt: new Date().toISOString() },
    ]);

    await runCatchup('fake/repo', tmpRoot);
    logSpy.mockClear();
    delete process.env.FAKE_GH_ISSUE_LIST_CLOSED;

    await runCatchup('fake/repo', tmpRoot);

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).not.toContain('Add dark mode');
    expect(output).toContain('(nothing happened)');
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
