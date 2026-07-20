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

- 2026-07-18/19 (issues #54, #57, #55, #59, #61) : dans `handleIssue`/`runReviewLoop`
  (`src/loop.ts`), **tout** chemin d'échec de sprint doit passer par `retryFreshSprintOrGiveUp`
  (jamais `commentOnIssue` + `clearState` directement) — sinon `retryCount` repart à 0 et le
  harnais boucle indéfiniment sans jamais atteindre `maxRetryCount` ni poser `needs-human` (#54 :
  `pushBranch` non protégé par `try/catch` ; #57 : "no new commit produced" traité hors du
  mécanisme borné). Plusieurs nuances court-circuitent ce retry borné plutôt que de le consommer :
  (1) un push rejeté pour scope OAuth `workflow` manquant échoue identiquement à chaque essai —
  `isMissingWorkflowScopeError` (`src/github.ts`) le détecte et escalade en `needs-human` dès le
  premier échec (#55) ; (2) un échec de push potentiellement transitoire est d'abord retenté
  directement, sans nouveau sprint (`pushBranchWithRetries`, `config.pushRetryCount`/
  `pushRetryDelayMs`, #59) ; (3) quand `pushBranchWithRetries` finit par s'épuiser malgré tout et
  qu'un nouveau sprint est lancé, `handleIssue` vérifie d'abord `hasUnpushedCommit` (`src/github.ts`)
  avant de rappeler `issue-worker` — s'il y a déjà un commit local en avance sur `origin` (un sprint
  précédent a réussi mais son push a échoué), on retente juste le push plutôt que de relancer
  l'agent, qui ne trouverait rien à faire et rapporterait à tort "no new commit produced" (#61).
  Le push d'un fixup de review (PR déjà ouverte) suit la même logique (2) mais escalade directement
  (pas de nouveau sprint) une fois `pushBranchWithRetries` épuisé. Nuance supplémentaire (#83) : un
  fixup qui échoue sans produire de commit faisait `return` directement dans `runReviewLoop`, sans
  jamais consommer le budget `maxReviewCycles` ni escalader — `resumePendingReview` re-relançait
  `code-reviewer` depuis `cycle=0` à chaque poll, indéfiniment. Corrigé en laissant l'échec continuer
  la boucle `for cycle` existante (`continue` au lieu de `return`) : le budget se consomme _au sein
  d'un seul appel_ à `runReviewLoop`, sans compteur persisté séparé — plus simple que d'ajouter un
  champ à `state.json` pour un cas qui n'a pas besoin de survivre à un redémarrage de process.

- 2026-07-19 (issue #60) : dans `test/fixtures/fake-bin/gh` (bash), ne jamais mettre une valeur
  par défaut contenant des `}` littéraux directement dans `${VAR:-...}` — bash termine la
  substitution au premier `}` non échappé rencontré, tronquant silencieusement du JSON contenant
  des objets. Assigner le défaut à une variable intermédiaire d'abord (`default=...; echo
"${VAR:-$default}"`) plutôt que de l'inliner.
