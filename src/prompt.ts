import type { Issue } from './github.js';

export function buildPrompt(issue: Issue): string {
  return `Traite l'issue GitHub #${issue.number} : "${issue.title}"`;
}
