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

- 2026-07-17 (PR #22) : les commits du harnais (`commitWorkInProgress`) ne passent par aucun hook
  Claude Code, mais `git push` déclenche quand même le hook Husky `pre-push` (lint+test) quel que
  soit l'appelant. Un push volontairement incomplet doit utiliser `--no-verify` explicitement
  (`pushBranch(..., { noVerify: true })`), sinon l'échec non géré peut boucler indéfiniment sans
  avancer `retryCount`.

- 2026-07-17 (issue #24) : `eslint.config.js` n'active le handling globals Node que pour
  `**/*.ts` (`tseslint.configs.recommended`) — un `.js` ajouté ailleurs (ex: `bin/everest.js`)
  tombe sous `js.configs.recommended` nu et se fait flaguer `'process' is not defined`. Rester en
  `.ts`, ou ajouter un bloc `languageOptions.globals` dédié (voir `files: ['bin/**/*.js']`).

- 2026-07-17 (issue #33) : pour tester un `spawnSync('docker', ['compose', 'exec', ...])` sans
  Docker réel, le fake binaire `test/fixtures/fake-bin/docker` strippe les args jusqu'au token
  `claude` puis `exec`-délègue au fake `claude` déjà sur le `PATH` - évite de dupliquer toute la
  logique de simulation (markers, `FAKE_CLAUDE_CHAT_EXIT_CODE`, etc.) déjà écrite dans le fake
  `claude`. Pattern réutilisable pour tout futur wrapper qui invoque une commande via un niveau
  d'indirection supplémentaire (ici `docker compose exec` autour de `claude`).

- 2026-07-17 (issue #26 / PR #28) : tout poll loop de longue durée destiné à tourner sans
  supervision (`runLoop` dans `src/loop.ts`, `runWatch` dans `src/cli.ts`) doit isoler chaque
  itération dans son propre try/catch (log + continue) plutôt que laisser une erreur `gh`
  transitoire (réseau, rate limit, auth) remonter et tuer tout le process. Deuxième occurrence de
  ce même bug (repéré une première fois sur `runLoop`, voir entrée PR #22 ci-dessus) : à
  généraliser par défaut sur toute future commande de polling.

- 2026-07-18 (issue #37) : pas de moyen fiable de savoir, via `gh`, _qui_ a ouvert une issue —
  `issue-worker` (self-improvement) et `everest ask` créent tous deux des issues sous le même
  compte `GH_TOKEN` (voir "Agent Identities" dans CLAUDE.md). `listIssuesOpenedSince`
  (`src/github.ts`, utilisé par `everest catchup` / `src/catchup.ts`) liste donc tout ce qui a été
  ouvert dans la fenêtre sans prétendre attribuer l'auteur. Pattern d'état persistant réutilisable
  pour tout futur "depuis la dernière fois" : `.harness/<nom>.json` (gitignored), écrit après
  lecture, jamais une fenêtre glissante fixe codée en dur.

- 2026-07-18 (issue #39) : `git add -A -- . ':!.harness'` échoue avec "paths are ignored by one
  of your .gitignore files" dès que `.harness/` est effectivement listé dans `.gitignore` — git
  traite un pathspec de négation (`:!chemin`) comme une référence explicite au chemin dès que ce
  chemin est ignoré, même si l'intention est de l'exclure, pas de l'ajouter. Ça avait cassé
  `commitWorkInProgress` en prod (checkpoint WIP après `budgetExceeded`) une fois `.harness`
  effectivement ajouté à `.gitignore`. Fix : `git add -A -- .` (laisse `.gitignore` faire son
  travail normalement) puis `git reset -- .harness` en filet de sécurité si `.gitignore` est
  absent/mal configuré (`git reset` n'échoue pas sur un chemin jamais indexé). Généraliser : ne
  jamais combiner un pathspec de négation avec un chemin déjà couvert par `.gitignore`.
