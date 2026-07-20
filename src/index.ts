import { loadConfig } from './config.js';
import { runLoop } from './loop.js';
import { startDashboardServer } from './dashboard.js';

const config = loadConfig();
const cwd = process.cwd();

// Starts alongside the main loop rather than as a separate command an operator has to remember
// to run - a "live" status view is only useful if it's always up whenever the harness itself is
// (see issue #65). Read-only and additive: a failure here must never take the loop down with it.
try {
  startDashboardServer(config.githubRepo, cwd, config.dashboardPort);
  console.log(`Dashboard listening on port ${config.dashboardPort}`);
} catch (error) {
  console.error('Failed to start the dashboard server (loop continues without it):', error);
}

runLoop(config, cwd).catch((error) => {
  console.error(error);
  process.exit(1);
});
