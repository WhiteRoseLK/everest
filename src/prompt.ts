import type { Issue } from './github.js';

/** Builds the user prompt sent to the issue-worker subagent for a given issue. */
export function buildPrompt(issue: Issue): string {
  return `Traite l'issue GitHub #${issue.number} : "${issue.title}"`;
}
