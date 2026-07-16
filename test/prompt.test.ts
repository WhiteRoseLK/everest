import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPrompt, buildFixupPrompt, readMemory, memorySection } from '../src/prompt.js';
import type { Issue } from '../src/github.js';

describe('memory injection (issue #12)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'everest-memory-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('returns an empty string when MEMORY.md does not exist', () => {
    expect(readMemory(cwd)).toBe('');
    expect(memorySection(cwd)).toBe('');
  });

  it('reads and trims MEMORY.md content when present', () => {
    writeFileSync(join(cwd, 'MEMORY.md'), '\n# Memory\n\n- a past lesson\n\n');

    expect(readMemory(cwd)).toBe('# Memory\n\n- a past lesson');
  });

  it('truncates MEMORY.md content past the size cap', () => {
    writeFileSync(join(cwd, 'MEMORY.md'), 'x'.repeat(10_000));

    const memory = readMemory(cwd);

    expect(memory.length).toBeLessThan(10_000);
    expect(memory).toContain('tronqué');
  });

  it('injects MEMORY.md content into buildPrompt for an issue', () => {
    writeFileSync(join(cwd, 'MEMORY.md'), '- 2026-07-16 (issue #7): watch out for X');
    const issue: Issue = { number: 42, title: 'Do the thing', labels: [], createdAt: '2024-01-01' };

    const prompt = buildPrompt(issue, cwd);

    expect(prompt).toContain("Traite l'issue GitHub #42");
    expect(prompt).toContain('Mémoire inter-sessions');
    expect(prompt).toContain('watch out for X');
  });

  it('omits the memory section from buildPrompt when MEMORY.md is absent', () => {
    const issue: Issue = { number: 42, title: 'Do the thing', labels: [], createdAt: '2024-01-01' };

    const prompt = buildPrompt(issue, cwd);

    expect(prompt).not.toContain('Mémoire inter-sessions');
  });

  it('injects MEMORY.md content into buildFixupPrompt', () => {
    writeFileSync(join(cwd, 'MEMORY.md'), '- past lesson for fixups');

    const prompt = buildFixupPrompt('harness/issue-7-fix', cwd);

    expect(prompt).toContain('harness/issue-7-fix');
    expect(prompt).toContain('past lesson for fixups');
  });
});
