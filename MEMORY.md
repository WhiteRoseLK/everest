# Memory

Mémoire persistante inter-sessions, versionnée avec le reste du repo : chaque invocation
d'`issue-worker`/`code-reviewer` est une session fraîche sans contexte des runs précédents (voir
`.claude/CLAUDE.md`), mémoire fichier native plutôt qu'un service externe comme mem0 (décision
issue #12). Injecté automatiquement dans le prompt de chaque agent (`memorySection()` dans
`src/prompt.ts`) ; consultable directement (`Read MEMORY.md`) pour plus de contexte.

## Comment contribuer une entrée

Un agent qui rencontre un piège récurrent, un pattern utile, ou prend une décision utile aux runs
futurs ajoute une entrée courte sous "Entrées" : `- AAAA-MM-JJ (issue #N) : description concise.`

Garder ce fichier court : consolider/retirer les entrées obsolètes plutôt que de laisser la liste
grossir (injection tronquée au-delà de `MAX_MEMORY_CHARS` = 4000 dans `src/prompt.ts`). Une
décision d'architecture durable migre vers `.claude/CLAUDE.md`, pas ici.

## Entrées

- 2026-07-18 (issue #37) : pas de moyen fiable de savoir, via `gh`, _qui_ a ouvert une issue (même
  compte `GH_TOKEN`). Pattern réutilisable pour "depuis la dernière fois" : `.harness/<nom>.json`
  (gitignored), écrit après lecture, jamais une fenêtre glissante codée en dur.

- 2026-07-18 (issue #38) : en démarrant sur une branche `harness/issue-<n>-...`, vérifier
  `git status`/`git diff --cached` d'abord — un sprint précédent a pu laisser du travail déjà
  `git add`é mais jamais committé. Si complet (relire diff, `npm test`/`npm run lint`), le committer
  directement plutôt que de le refaire.

- 2026-07-18/19 (issues #54, #57, #55, #59, #61, #83) : dans `handleIssue`/`runReviewLoop`
  (`src/loop.ts`), **tout** chemin d'échec de sprint/fixup doit passer par le retry borné
  (`retryFreshSprintOrGiveUp`, ou `continue` sur `maxReviewCycles`) — jamais un
  `commentOnIssue`+`clearState`/`return` direct, sinon le compteur ne progresse jamais. Exceptions :
  scope OAuth `workflow` manquant → escalade immédiate ; push transitoire → retenté directement ;
  commit local déjà en avance sur `origin` → on retente juste le push.

- 2026-07-20 (issue #86) : un test e2e qui a besoin d'exercer le chargement de `.env` ne doit
  jamais écrire dans le vrai `.env` racine du projet si un autre fichier de test peut faire pareil
  en même temps — vitest parallélise les fichiers par défaut, ce qui fait courir une race sur
  lecture/écriture (repéré via un CI rouge intermittent sur `config-invalid-number.e2e.test.ts` vs
  `config.e2e.test.ts`, tous deux mutant `.env`). `process.env` gagne toujours sur `.env` (défaut
  dotenv), donc passer les valeurs directement via `env:` de `spawnSync` suffit et évite la
  mutation du fichier partagé.

- 2026-07-20 (issue #94) : pour toute condition "permanente et détectable au boot" (comme l'EACCES
  du bind mount, #84), préférer un **preflight avant la boucle** (fail-fast, exit non-zéro) plutôt
  que de laisser le try/catch par itération de `runLoop` la ré-échouer en boucle silencieuse.
  Modèle : `checkGitWritable`/`checkHarnessWritable` (`src/diagnostics.ts`) +
  `runStartupWritabilityPreflight` (`src/loop.ts`).

- 2026-07-20 (issue #98) : avant d'implémenter, vérifier si l'issue n'est pas déjà résolue par un
  merge postérieur à sa création. Si le code couvre déjà le comportement désiré (tests e2e inclus),
  fermer comme doublon avec un commentaire vers le commit/PR concerné.

- 2026-07-20 (issue #85) : `block-secrets.sh` scanne aussi `Write`/`Edit`, pas seulement `Bash` —
  une fixture de test avec un faux secret littéral (token API/AWS) se fait bloquer à l'écriture.
  Construire ces valeurs par concaténation de sous-chaînes plutôt que comme littéral complet.

- 2026-07-20 (issue #86) : toute fonction de parsing d'env var numérique (`numberEnv`,
  `src/config.ts`) doit rejeter `NaN` explicitement (`Number.isNaN`) plutôt que de laisser
  `Number(value)` invalide se propager silencieusement dans des comparaisons/délais downstream.
