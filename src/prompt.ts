import type { Issue } from './github.js';

export const QA_E2E_SYSTEM_PROMPT = `Toute fonctionnalité ajoutée ou tout bug corrigé doit être accompagné d'un test E2E dans le dossier test/, exécuté par "npm test". N'effectue aucun commit tant que "npm test" échoue.`;

export function buildPrompt(issue: Issue): string {
  return `Traite l'issue GitHub #${issue.number} : "${issue.title}"

Implémente les changements nécessaires, ajoute les tests E2E correspondants, vérifie que "npm test" passe, puis committe le résultat.`;
}
