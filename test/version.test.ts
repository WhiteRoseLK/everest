import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION_PATH = path.join(__dirname, '..', 'VERSION');

describe('fichier VERSION', () => {
  it('existe à la racine du projet et contient 0.1.0', () => {
    const content = readFileSync(VERSION_PATH, 'utf-8').trim();
    expect(content).toBe('0.1.0');
  });
});
