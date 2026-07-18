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

- 2026-07-17 (issue #24) : `eslint.config.js` n'active les globals Node que pour `**/*.ts` — un
  `.js` ajouté ailleurs (ex: `bin/everest.js`) se fait flaguer `'process' is not defined`. Rester
  en `.ts`, ou ajouter un bloc `languageOptions.globals` dédié.

- 2026-07-17 (issue #33) : pour tester un wrapper qui invoque une commande via un niveau
  d'indirection (ex: `spawnSync('docker', ['compose', 'exec', ..., 'claude', ...])`), le fake
  binaire peut strip les args jusqu'au token de la commande finale puis `exec`-déléguer au fake
  déjà sur le `PATH`, plutôt que dupliquer sa logique de simulation (voir
  `test/fixtures/fake-bin/docker`).

- 2026-07-18 (issue #37) : pas de moyen fiable de savoir, via `gh`, _qui_ a ouvert une issue —
  `issue-worker` et `everest ask` créent tous deux des issues sous le même compte `GH_TOKEN`.
  Pattern réutilisable pour tout futur "depuis la dernière fois" : `.harness/<nom>.json`
  (gitignored), écrit après lecture, jamais une fenêtre glissante codée en dur (voir
  `listIssuesOpenedSince`/`src/catchup.ts`).

- 2026-07-18 (issue #39) : ne jamais combiner un pathspec de négation (`:!chemin`) avec un chemin
  déjà couvert par `.gitignore` — git le traite comme une référence explicite et échoue ("paths
  are ignored..."). `commitWorkInProgress` (`src/github.ts`) fait `git add -A -- .` puis
  `git reset -- .harness` en filet de sécurité.

- 2026-07-18 (issue #38) : en démarrant sur une branche `harness/issue-<n>-...`, vérifier `git
status`/`git diff --cached` avant d'écrire quoi que ce soit — un sprint précédent peut avoir
  laissé du travail déjà `git add`é mais jamais committé. Si c'est correct et complet (relire le
  diff, `npm test`/`npm run lint` dessus), le committer directement plutôt que de le refaire.

- 2026-07-18 (issue #43) : ESM n'importe un module qu'une fois par process — `git pull` seul ne
  change rien au comportement en mémoire de `npm start`. Fix : `runLoop` capture le SHA
  d'`origin/main` au démarrage et le revérifie à chaque itération (`restartIfMainAdvanced`,
  `src/loop.ts`) ; dès qu'il a avancé, `exitProcess(0)` (injectable, `process.exit` par défaut) et
  `restart: unless-stopped` (`docker-compose.yml`) relance `npm start` avec le code neuf. Rien
  n'est perdu : l'état d'issue vit dans `.harness/state.json`. Piège repéré en review : si la
  capture initiale échoue (`.catch(() => null)` avalé silencieusement), le garde
  `if (startupMainCommit && ...)` désactivait la détection pour toute la durée de vie du process.
  Fix : logger l'échec (`console.error`) et réessayer la capture à chaque itération tant qu'elle
  est `null` (`tryCaptureMainCommit`), au lieu d'abandonner définitivement.
