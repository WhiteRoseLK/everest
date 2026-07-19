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

- 2026-07-18 (issue #37) : pas de moyen fiable de savoir, via `gh`, _qui_ a ouvert une issue —
  `issue-worker` et `everest ask` créent tous deux des issues sous le même compte `GH_TOKEN`.
  Pattern réutilisable pour tout futur "depuis la dernière fois" : `.harness/<nom>.json`
  (gitignored), écrit après lecture, jamais une fenêtre glissante codée en dur (voir
  `listIssuesOpenedSince`/`src/catchup.ts`).

- 2026-07-18 (issue #39) : ne jamais combiner un pathspec de négation (`:!chemin`) avec un chemin
  déjà couvert par `.gitignore` — git le traite comme une référence explicite et échoue ("paths
  are ignored..."). `commitWorkInProgress` (`src/github.ts`) fait `git add -A -- .` puis
  `git reset -- .harness` en filet de sécurité.

- 2026-07-18 (issue #38) : en démarrant sur une branche `harness/issue-<n>-...`, vérifier
  `git status`/`git diff --cached` avant d'écrire quoi que ce soit — un sprint précédent a pu
  laisser du travail déjà `git add`é mais jamais committé. Si c'est correct/complet (relire le
  diff, `npm test`/`npm run lint`), le committer directement plutôt que de le refaire.

- 2026-07-18 (issue #44) : pour un choix "heuristique déterministe vs. vrai jugement LLM" quand
  l'appelant n'a pas toujours un LLM dans la boucle (`deriveIssueTitle`, `src/github.ts`) : donner
  aux appelants qui _ont_ du jugement (l'agent `chat`, session LLM live) un paramètre explicite
  pour court-circuiter l'heuristique (`--title` sur `everest ask` → `createIssuesFromMessage`),
  plutôt que de forcer un shell-out `claude -p` coûteux pour le seul chemin CLI non-interactif, qui
  garde l'heuristique (améliorée : filler-stripping) comme fallback raisonnable.

- 2026-07-18/19 (issues #54, #57, #55, #59) : dans `handleIssue`/`runReviewLoop` (`src/loop.ts`),
  **tout** chemin d'échec de sprint doit passer par `retryFreshSprintOrGiveUp` (jamais
  `commentOnIssue` + `clearState` directement) — sinon `retryCount` repart à 0 et le harnais boucle
  indéfiniment sans jamais atteindre `maxRetryCount` ni poser `needs-human` (#54 : `pushBranch` non
  protégé par `try/catch` ; #57 : "no new commit produced" traité hors du mécanisme borné). Deux
  nuances court-circuitent ce retry borné plutôt que de le consommer : (1) un push rejeté pour scope
  OAuth `workflow` manquant échoue identiquement à chaque essai — `isMissingWorkflowScopeError`
  (`src/github.ts`) le détecte et escalade en `needs-human` dès le premier échec (#55) ; (2) un échec
  de push potentiellement transitoire est d'abord retenté directement, sans nouveau sprint
  (`pushBranchWithRetries`, `config.pushRetryCount`/`pushRetryDelayMs`, #59) — un push qui aurait
  réussi au 2e essai gaspillait sinon un sprint entier à ne rien trouver à committer. Le push d'un
  fixup de review (PR déjà ouverte) suit la même logique mais escalade directement (pas de nouveau
  sprint) une fois `pushBranchWithRetries` épuisé.

- 2026-07-19 (issue #60) : dans `test/fixtures/fake-bin/gh` (bash), ne jamais mettre une valeur
  par défaut contenant des `}` littéraux directement dans `${VAR:-...}` — bash termine la
  substitution au premier `}` non échappé rencontré, tronquant silencieusement du JSON contenant
  des objets. Assigner le défaut à une variable intermédiaire d'abord (`default=...; echo
"${VAR:-$default}"`) plutôt que de l'inliner.
