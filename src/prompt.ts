import type { Issue } from './github.js';

/** Builds the user prompt sent to the issue-worker subagent for a given issue. */
export function buildPrompt(issue: Issue): string {
  return `Traite l'issue GitHub #${issue.number} : "${issue.title}"`;
}

/** Builds the follow-up prompt sent to issue-worker when code-reviewer requested changes. */
export function buildFixupPrompt(branch: string): string {
  return `The code reviewer requested changes on your PR for branch "${branch}". Read the review with \`gh pr view ${branch} --json reviews\`, address the feedback, and commit again.`;
}
