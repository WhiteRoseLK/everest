import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  listHarnessPullRequests,
  listRecentlyClosedIssues,
  listBlockers,
  type HarnessPullRequestSummary,
  type ClosedIssueSummary,
  type Blocker,
} from './github.js';
import { loadState, type HarnessState } from './state.js';

/**
 * Lookback window for "recently closed issues" shown on the dashboard, matching
 * `RECENT_ISSUES_WINDOW_HOURS` used by `everest status` (see `src/cli.ts`) so the two views agree.
 */
const RECENT_ISSUES_WINDOW_HOURS = 24;

/** Everything the dashboard's `/api/status` endpoint reports in one snapshot. */
export interface DashboardData {
  /** The sprint currently in progress (from `.harness/state.json`), or `null` if idle. */
  currentSprint: HarnessState | null;
  pullRequests: HarnessPullRequestSummary[];
  recentlyClosedIssues: ClosedIssueSummary[];
  blockers: Blocker[];
  /** ISO timestamp this snapshot was built at, so the UI can show "as of ..." freshness. */
  generatedAt: string;
}

/**
 * Aggregates a single read-only snapshot of harness activity for the web dashboard (issue #65):
 * the in-progress sprint (issue/branch/since-when/attempt — read straight off `.harness/state.json`
 * via {@link loadState}, the same source `everest doctor` uses, since nothing else persists it),
 * open harness PRs with review status (mirrors `everest status`), recently closed issues (mirrors
 * `everest status`), and `needs-human` blockers with their last comment (mirrors `everest
 * blockers`). Deliberately reuses the exact same `src/github.ts` building blocks as those existing
 * CLI commands rather than inventing new `gh` queries, so the dashboard can never drift out of
 * sync with what `everest status`/`everest blockers` report.
 */
export async function buildDashboardData(repo: string, cwd: string): Promise<DashboardData> {
  const [pullRequests, recentlyClosedIssues, blockers] = await Promise.all([
    listHarnessPullRequests(repo),
    listRecentlyClosedIssues(repo, RECENT_ISSUES_WINDOW_HOURS),
    listBlockers(repo),
  ]);

  return {
    currentSprint: loadState(cwd),
    pullRequests,
    recentlyClosedIssues,
    blockers,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Static HTML/CSS/JS shell for the dashboard: it renders nothing server-side and instead polls
 * `/api/status` on a fixed interval, re-rendering the DOM from the JSON response. Kept as a single
 * dependency-free page (no bundler, no framework) - the entire feature is read-only and small
 * enough that hand-written `fetch` + `setInterval` polling is simpler than pulling in a UI stack,
 * matching the project's near-zero-dependency style (see `package.json`).
 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>everest dashboard</title>
<style>
  :root { color-scheme: dark light; }
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 900px; }
  h1 { margin-bottom: 0.25rem; }
  #generated-at { color: #888; font-size: 0.85rem; margin-bottom: 1.5rem; }
  section { margin-bottom: 2rem; }
  h2 { border-bottom: 1px solid #8884; padding-bottom: 0.25rem; }
  .empty { color: #888; font-style: italic; }
  .card { border: 1px solid #8884; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
  .status-open { color: #2a8; }
  .status-needs-fixup { color: #d90; }
  .status-needs-human { color: #d33; font-weight: bold; }
  .comment { color: #888; margin: 0.25rem 0 0; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>everest dashboard</h1>
<div id="generated-at">loading…</div>

<section>
  <h2>Current sprint</h2>
  <div id="current-sprint"></div>
</section>

<section>
  <h2>Open pull requests</h2>
  <div id="pull-requests"></div>
</section>

<section>
  <h2>Recently closed issues</h2>
  <div id="closed-issues"></div>
</section>

<section>
  <h2>Blockers (needs-human)</h2>
  <div id="blockers"></div>
</section>

<script>
const POLL_INTERVAL_MS = 5000;

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function formatSince(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return minutes + 'm ago';
  return Math.round(minutes / 60) + 'h ago';
}

function renderCurrentSprint(sprint) {
  const container = document.getElementById('current-sprint');
  container.innerHTML = '';
  if (!sprint) {
    container.append(el('p', { className: 'empty' }, 'No sprint in progress right now.'));
    return;
  }
  container.append(
    el(
      'div',
      { className: 'card' },
      el('div', {}, 'Issue #' + sprint.issueNumber + ' on ' + sprint.branch),
      el('div', {}, 'Started ' + formatSince(sprint.startedAt) + ', attempt ' + (sprint.retryCount + 1)),
    ),
  );
}

function renderPullRequests(pullRequests) {
  const container = document.getElementById('pull-requests');
  container.innerHTML = '';
  if (pullRequests.length === 0) {
    container.append(el('p', { className: 'empty' }, 'No open harness pull requests.'));
    return;
  }
  for (const pr of pullRequests) {
    container.append(
      el(
        'div',
        { className: 'card' },
        el(
          'div',
          {},
          '#' + pr.number + ' issue #' + pr.issueNumber + ' [' + pr.branch + '] - ',
          el('span', { className: 'status-' + pr.status, textContent: pr.status }),
        ),
      ),
    );
  }
}

function renderClosedIssues(issues) {
  const container = document.getElementById('closed-issues');
  container.innerHTML = '';
  if (issues.length === 0) {
    container.append(el('p', { className: 'empty' }, 'No issues closed recently.'));
    return;
  }
  for (const issue of issues) {
    container.append(
      el('div', { className: 'card' }, '#' + issue.number + ' ' + issue.title + ' (closed ' + issue.closedAt + ')'),
    );
  }
}

function renderBlockers(blockers) {
  const container = document.getElementById('blockers');
  container.innerHTML = '';
  if (blockers.length === 0) {
    container.append(el('p', { className: 'empty' }, 'Nothing needs human intervention.'));
    return;
  }
  for (const blocker of blockers) {
    const card = el('div', { className: 'card' }, '#' + blocker.number + ' ' + blocker.title + ' [' + blocker.branch + ']');
    card.append(el('p', { className: 'comment' }, blocker.lastComment ?? '(no comment)'));
    container.append(card);
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error('status ' + response.status);
    const data = await response.json();
    document.getElementById('generated-at').textContent = 'Last updated: ' + new Date(data.generatedAt).toLocaleTimeString();
    renderCurrentSprint(data.currentSprint);
    renderPullRequests(data.pullRequests);
    renderClosedIssues(data.recentlyClosedIssues);
    renderBlockers(data.blockers);
  } catch (error) {
    document.getElementById('generated-at').textContent = 'Failed to refresh: ' + error;
  }
}

refresh();
setInterval(refresh, POLL_INTERVAL_MS);
</script>
</body>
</html>
`;

/**
 * Handles a single HTTP request for the dashboard: `GET /api/status` returns a fresh
 * {@link DashboardData} snapshot as JSON (what the page polls), anything else serves the static
 * HTML shell. Exported separately from {@link startDashboardServer} so tests can drive it directly
 * without binding a real socket.
 */
export async function handleDashboardRequest(
  repo: string,
  cwd: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.url === '/api/status') {
    try {
      const data = await buildDashboardData(repo, cwd);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(DASHBOARD_HTML);
}

/**
 * Starts the read-only dashboard's HTTP server on `port`, listening on all interfaces so it's
 * reachable from the host once the container publishes that port (see `docker-compose.yml`).
 * Deliberately built on Node's built-in `http` module rather than adding a web framework
 * dependency - the surface is two routes (`GET /api/status`, `GET /` for everything else), well
 * within what `createServer` handles directly.
 */
export function startDashboardServer(repo: string, cwd: string, port: number): Server {
  const server = createServer((req, res) => {
    handleDashboardRequest(repo, cwd, req, res).catch((error) => {
      console.error('Dashboard request failed:', error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.listen(port);
  return server;
}
