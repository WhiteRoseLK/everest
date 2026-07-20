import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildDashboardData, startDashboardServer } from '../src/dashboard.js';

const FAKE_BIN = join(import.meta.dirname, 'fixtures/fake-bin');

/** Minimal fetch helper so tests don't depend on the global fetch implementation's defaults. */
async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  return response.json();
}

describe('dashboard (issue #65)', () => {
  let tmpRoot: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'everest-dashboard-e2e-'));
    originalPath = process.env.PATH;
    process.env.PATH = `${FAKE_BIN}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_GH_PR_LIST;
    delete process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN;
    delete process.env.FAKE_GH_ISSUE_LIST_CLOSED;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('buildDashboardData reports the in-progress sprint from .harness/state.json', async () => {
    mkdirSync(join(tmpRoot, '.harness'), { recursive: true });
    writeFileSync(
      join(tmpRoot, '.harness/state.json'),
      JSON.stringify({
        issueNumber: 7,
        branch: 'harness/issue-7-x',
        startedAt: '2026-07-19T00:00:00Z',
        retryCount: 1,
      }),
    );
    process.env.FAKE_GH_PR_LIST = JSON.stringify([]);

    const data = await buildDashboardData('fake/repo', tmpRoot);

    expect(data.currentSprint).toEqual({
      issueNumber: 7,
      branch: 'harness/issue-7-x',
      startedAt: '2026-07-19T00:00:00Z',
      retryCount: 1,
    });
  });

  it('buildDashboardData reports null current sprint when the harness is idle', async () => {
    process.env.FAKE_GH_PR_LIST = JSON.stringify([]);

    const data = await buildDashboardData('fake/repo', tmpRoot);

    expect(data.currentSprint).toBeNull();
  });

  it('buildDashboardData mirrors everest status/blockers: open PRs, closed issues, blockers', async () => {
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      { number: 5, headRefName: 'harness/issue-3-foo', labels: [{ name: 'needs-fixup' }] },
    ]);
    process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN = JSON.stringify([
      {
        number: 9,
        title: 'Fix flaky thing',
        headRefName: 'harness/issue-9-fix-flaky-thing',
        comments: [{ body: 'review budget exhausted, please help' }],
      },
    ]);
    process.env.FAKE_GH_ISSUE_LIST_CLOSED = JSON.stringify([
      { number: 1, title: 'Old fix', closedAt: new Date().toISOString() },
    ]);

    const data = await buildDashboardData('fake/repo', tmpRoot);

    expect(data.pullRequests).toEqual([
      { number: 5, branch: 'harness/issue-3-foo', issueNumber: 3, status: 'needs-fixup' },
    ]);
    expect(data.recentlyClosedIssues).toEqual([
      expect.objectContaining({ number: 1, title: 'Old fix' }),
    ]);
    expect(data.blockers).toEqual([
      expect.objectContaining({
        number: 9,
        title: 'Fix flaky thing',
        lastComment: 'review budget exhausted, please help',
      }),
    ]);
    expect(data.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('the HTTP server serves the HTML shell at / and live JSON at /api/status', async () => {
    process.env.FAKE_GH_PR_LIST = JSON.stringify([
      { number: 5, headRefName: 'harness/issue-3-foo', labels: [] },
    ]);
    process.env.FAKE_GH_PR_LIST_NEEDS_HUMAN = '[]';

    const server = startDashboardServer('fake/repo', tmpRoot, 0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;

      const htmlResponse = await fetch(`http://127.0.0.1:${port}/`);
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get('content-type')).toContain('text/html');
      const html = await htmlResponse.text();
      expect(html).toContain('everest dashboard');
      expect(html).toContain("fetch('/api/status')");

      const data = (await getJson(`http://127.0.0.1:${port}/api/status`)) as {
        pullRequests: Array<{ number: number }>;
      };
      expect(data.pullRequests).toEqual([
        { number: 5, branch: 'harness/issue-3-foo', issueNumber: 3, status: 'open' },
      ]);
    } finally {
      server.close();
    }
  });

  it('the /api/status endpoint returns an error payload instead of crashing when gh fails', async () => {
    process.env.PATH = originalPath; // gh no longer resolvable -> execFile rejects

    const server = startDashboardServer('fake/repo', tmpRoot, 0);
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as AddressInfo).port;

      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBeTruthy();
    } finally {
      server.close();
    }
  });
});
