# Memory

Mémoire persistante inter-sessions, versionnée avec le reste du repo. Chaque invocation
d'`issue-worker` ou de `code-reviewer` est une session fraîche sans contexte des runs précédents
(voir `.claude/CLAUDE.md`) : ce fichier comble ce manque avec de la mémoire fichier native plutôt
qu'un service externe comme mem0 — décision prise dans l'issue #12 après évaluation, faute de
besoin concret non couvert par cette approche.

Ce fichier est injecté automatiquement dans le prompt de chaque agent (`memorySection()` dans
`src/prompt.ts`) : un agent n'a pas besoin de le lire explicitement, mais peut aussi le consulter
directement (`Read MEMORY.md`) s'il veut plus de contexte.

## Comment contribuer une entrée

Quand un agent (`issue-worker` ou `code-reviewer`) rencontre un piège récurrent, un pattern utile,
ou prend une décision qui mériterait d'être connue des runs futurs, il ajoute une entrée courte
sous "Entrées", au format :

- `AAAA-MM-JJ` (issue #N) : description concise de la leçon ou de la décision.

Garder ce fichier court et à jour : consolider ou retirer les entrées obsolètes plutôt que de
laisser la liste grossir indéfiniment (l'injection dans le prompt est tronquée au-delà de
4000 caractères, voir `MAX_MEMORY_CHARS` dans `src/prompt.ts`). Une décision d'architecture
durable doit migrer vers `.claude/CLAUDE.md` plutôt que de rester ici indéfiniment.

## Entrées

- 2026-07-16 (issue #14) : `pickNextIssue` (src/loop.ts) supporte désormais 4 tiers
  `priority:critical/high/medium/low` (le plus urgent en premier, FIFO au sein d'un tier). Une
  issue sans label de priorité est traitée comme `priority:medium` (compat avec le comportement
  précédent). Les labels `type:bug/type:feature/type:tech-debt` sont volontairement ignorés par
  le tri — purement informatifs, pas de scoring RICE/WSJF pour l'instant (sur-ingénierie évitée
  explicitement dans l'issue).

- 2026-07-17 (PR #22) : les commits du harnais lui-même (ex: `commitWorkInProgress`, checkpoint
  WIP) ne passent par aucun hook Claude Code (`PreToolUse` ne se déclenche que pour les tool calls
  d'un agent, pas pour `execFileAsync('git', ['commit', ...])` appelé directement par le TS du
  harnais) — mais `git push` déclenche quand même le vrai hook Husky `pre-push` du repo
  (lint+test), quel que soit l'appelant. Un push de code volontairement incomplet/non vérifié doit
  utiliser `--no-verify` explicitement (voir `pushBranch(..., { noVerify: true })`), sinon le push
  échoue et — si l'échec n'est pas géré — peut faire boucler indéfiniment sans jamais avancer
  `retryCount`.
