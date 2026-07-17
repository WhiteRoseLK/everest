import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Issue } from './github.js';

const MEMORY_FILE = 'MEMORY.md';

/**
 * Caps how much of `MEMORY.md` gets injected into a prompt, so a memory file that grows too
 * large can't silently balloon the cost/size of every agent invocation. Agents are instructed
 * (see `.claude/agents/`) to keep the file pruned well under this, but this is a hard backstop.
 */
const MAX_MEMORY_CHARS = 4000;

/**
 * Reads the repo's versioned cross-session memory file (`MEMORY.md`), if present. This is the
 * native-file-memory alternative to an external service like mem0 (see issue #12): lessons,
 * recurring patterns, and decisions from past runs, committed to the repo like any other file.
 * Returns an empty string when the file is missing or empty, so callers can concatenate the
 * result unconditionally.
 */
export function readMemory(cwd: string): string {
  const path = join(cwd, MEMORY_FILE);
  if (!existsSync(path)) return '';
  const content = readFileSync(path, 'utf-8').trim();
  if (content.length <= MAX_MEMORY_CHARS) return content;
  return `${content.slice(0, MAX_MEMORY_CHARS)}\n[...tronqué, ${MEMORY_FILE} dépasse ${MAX_MEMORY_CHARS} caractères - pensez à l'élaguer...]`;
}

/**
 * Builds the prompt section carrying prior cross-session memory (if any), for appending to an
 * agent prompt so past lessons/decisions are available even though each invocation is otherwise
 * a fresh session with no accumulated context.
 */
export function memorySection(cwd: string): string {
  const memory = readMemory(cwd);
  if (!memory) return '';
  return `\n\nMémoire inter-sessions (${MEMORY_FILE}) - leçons et décisions des runs précédents à prendre en compte :\n${memory}`;
}

/** Builds the user prompt sent to the issue-worker subagent for a given issue. */
export function buildPrompt(issue: Issue, cwd: string): string {
  return `Traite l'issue GitHub #${issue.number} : "${issue.title}"${memorySection(cwd)}`;
}

/** Builds the follow-up prompt sent to issue-worker when code-reviewer requested changes. */
export function buildFixupPrompt(branch: string, cwd: string): string {
  return `The code reviewer requested changes on your PR for branch "${branch}". Read the review with \`gh pr view ${branch} --json reviews\`, address the feedback, and commit again.${memorySection(cwd)}`;
}
