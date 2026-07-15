import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HarnessState {
  issueNumber: number;
  branch: string;
  startedAt: string;
  retryCount: number;
}

const STATE_PATH = '.harness/state.json';

export function saveState(state: HarnessState, cwd: string): void {
  const path = `${cwd}/${STATE_PATH}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function loadState(cwd: string): HarnessState | null {
  const path = `${cwd}/${STATE_PATH}`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as HarnessState;
}

export function clearState(cwd: string): void {
  const path = `${cwd}/${STATE_PATH}`;
  if (existsSync(path)) unlinkSync(path);
}
