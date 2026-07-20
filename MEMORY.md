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

- 2026-07-18 (issue #44) : `deriveIssueTitle` (`src/github.ts`) reste une heuristique (pas de
  shell-out `claude -p`) ; les appelants qui ont un vrai LLM dans la boucle (agent `chat`) passent
  `--title` pour la court-circuiter plutôt que de forcer tout le monde à payer un appel LLM.

- 2026-07-18/19 (issues #54, #57, #55, #59, #61, #83) : dans `handleIssue`/`runReviewLoop`
  (`src/loop.ts`), **tout** chemin d'échec de sprint/fixup doit passer par le mécanisme de retry
  borné (`retryFreshSprintOrGiveUp`, ou le budget `maxReviewCycles` de `runReviewLoop` via
  `continue` plutôt que `return` sur un échec sans commit) — jamais un `commentOnIssue` +
  `clearState`/`return` direct, sinon le compteur ne progresse jamais et le harnais boucle sans fin
  ni escalade `needs-human`. Nuances qui court-circuitent ce retry plutôt que de le consommer : scope
  OAuth `workflow` manquant → escalade immédiate (`isMissingWorkflowScopeError`, échoue
  identiquement à chaque essai) ; push transitoire → retenté directement sans nouveau sprint
  (`pushBranchWithRetries`) ; commit local déjà en avance sur `origin` → on retente juste le push
  (`hasUnpushedCommit`) plutôt que de relancer l'agent pour rien.

- 2026-07-19 (issue #60) : dans `test/fixtures/fake-bin/gh` (bash), ne jamais mettre une valeur
  par défaut contenant des `}` littéraux directement dans `${VAR:-...}` — bash termine la
  substitution au premier `}` non échappé rencontré, tronquant silencieusement du JSON contenant
  des objets. Assigner le défaut à une variable intermédiaire d'abord (`default=...; echo
"${VAR:-$default}"`) plutôt que de l'inliner.

- 2026-07-20 (issue #94) : pour toute condition "permanente et détectable au boot" (comme l'EACCES
  du bind mount, #84), préférer un **preflight avant la boucle** (fail-fast, exit non-zéro, message
  explicite) plutôt que de laisser le per-iteration try/catch de `runLoop` la ré-échouer en boucle
  silencieuse chaque `pollIntervalMs`. `checkGitWritable`/`checkHarnessWritable`
  (`src/diagnostics.ts`) + `runStartupWritabilityPreflight` (`src/loop.ts`) en sont le modèle
  réutilisable.
