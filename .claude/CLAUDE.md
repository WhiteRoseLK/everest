# Project: everest

## Mission

Développer ce projet en continu, en s'auto-améliorant autant que possible. GitHub Issues est le mécanisme opérationnel (comment le travail est proposé et suivi), pas la mission elle-même — la mission n'est pas de "vider un backlog" mécaniquement.

## Architecture Overview

`src/loop.ts` lit les issues ouvertes (FIFO, `priority:high` en premier), crée une branche, invoque `claude -p --agent issue-worker` en mode `bypassPermissions` dans un sandbox Docker, vérifie qu'un commit a bien été produit, pousse la branche et ouvre la PR. Tout tourne en dehors d'une conversation longue : chaque issue = une invocation fraîche, pas de contexte accumulé entre issues. L'agent `issue-worker` (`.claude/agents/issue-worker.md`) peut lui-même ouvrir de nouvelles issues quand il repère des améliorations hors scope — c'est la boucle d'auto-amélioration.

## Review Loop

Une fois la PR ouverte, `code-reviewer` (`.claude/agents/code-reviewer.md`) est invoqué sur la branche : il checkout, lance lui-même `npm run lint`/`npm test` (ne fait pas confiance au diff seul), lit le diff, vérifie que le check CI `lint-and-test` est vert, puis décide.

`gh pr review --approve` **et** `gh pr review --request-changes` échouent tous les deux sur sa propre PR ("Can not approve/request changes on your own pull request" — PR et review partagent le même compte `GH_TOKEN`). Confirmé empiriquement le 17 juillet 2026 (le reviewer l'a découvert en essayant sur PR #22) : ce n'est pas seulement l'approbation qui est bloquée, contrairement à ce qu'on pensait initialement. Seuls les commentaires simples (`gh pr comment`) passent sur sa propre PR.

Conséquence : `reviewDecision` (champ natif GitHub) ne peut donc **jamais** devenir `CHANGES_REQUESTED` sur une review de sa propre PR — ce champ est inutilisable comme signal ici. À la place :

- Si le reviewer juge la PR prête : il **merge directement** (`gh pr merge --squash --delete-branch`).
- Si ce n'est pas prêt : il poste ses findings en commentaire (`gh pr comment`) puis pose le label `needs-fixup` (`markPullRequestNeedsFixup()` dans `src/github.ts`) — c'est ce label, pas `reviewDecision`, que `runReviewLoop`/`getPullRequestLabels()` vérifient pour déclencher le cycle de correction.

Si `needs-fixup` : le harnais rappelle `issue-worker` sur la même branche avec le retour du reviewer en contexte (`buildFixupPrompt`), repousse le commit, puis relance `code-reviewer`. Ce cycle se répète jusqu'au merge ou jusqu'à `MAX_REVIEW_CYCLES` (défaut 3, `runReviewLoop` dans `src/loop.ts`) — budget de lancement pour éviter une boucle infinie si l'agent et le reviewer n'arrivent jamais à s'accorder. Au-delà, un commentaire est posté sur l'issue et le PR est labellisé `needs-human` pour signaler qu'une intervention humaine est nécessaire. Le harnais détecte la fin du cycle via `getPullRequestState()` (état `MERGED`), vérifié avant le label à chaque itération.

Avant de créer une nouvelle branche pour l'issue suivante, le harnais fait `checkoutMain()` (checkout + `pull --ff-only`) plutôt que de partir de la branche précédente — sinon une branche mergée-et-supprimée côté remote laisserait le prochain `git checkout -b` partir d'un historique obsolète (bug auto-repéré par le harnais, issue #17).

## Budget Policy

**Décision explicite de l'utilisatrice (17 juillet 2026)** : pas de budget max sur une _issue_. `MAX_BUDGET_USD_PER_ISSUE` (défaut $2) est un garde-fou sur une _invocation_ de sous-agent (un "sprint"), pas une deadline qui abandonne la tâche. Le vrai plafond global d'une issue, c'est `MAX_REVIEW_CYCLES` (un nombre de rounds, pas des dollars) — cohérent avec "les garde-fous vont sur les sous-agents, pas sur la tâche elle-même".

Quand `issue-worker` épuise son budget sans finir (`ClaudeResult.budgetExceeded`, `src/claude.ts`) :

1. `commitWorkInProgress()` (`src/github.ts`) committe le travail en cours sous l'identité `everest-harness` si le working tree n'est pas propre — un commit WIP, pas gaté par les hooks qualité (c'est explicitement provisoire, pas une unité de travail finie). Exclut `.harness/` du commit via pathspec, pas seulement via `.gitignore` (sinon un `.gitignore` mal configuré ferait committer l'état runtime du harnais comme si c'était du travail d'agent).
2. S'il y a eu quelque chose à committer : push, ouverture/vérification de la PR, puis `runReviewLoop()` — le reviewer verra que c'est incomplet, postera ses observations et posera `needs-fixup`, ce qui rappelle `issue-worker` avec un budget frais. C'est le "reshuffle the cards, review, brainstorm" : on réutilise la boucle de review déjà construite pour "pas encore prêt" plutôt que d'inventer un nouveau mécanisme.
3. S'il n'y a rien eu à committer (l'agent a passé tout son budget à explorer sans produire de diff) : retry immédiat avec un sprint frais sur la même branche, plafonné par `MAX_RETRY_COUNT` (même mécanisme que les rate-limits) avant d'escalader en `needs-human`.

## CI

`.github/workflows/ci.yml` relance lint + test sur chaque PR, indépendamment des agents. Un check obligatoire (branch protection sur `main`, check `lint-and-test`, `enforce_admins: true`) empêche le merge si CI échoue, même en cliquant le bouton sur GitHub — le gate le plus robuste des trois (hook local Husky contournable avec `--no-verify`, review d'agent contournable en théorie, CI+branch protection non contournable par un contributeur standard).

Note : la branch protection classique et les rulesets GitHub ne sont pas disponibles sur un repo privé avec un compte gratuit (403 "Upgrade to GitHub Pro or make this repository public"). Le repo `everest` a été rendu **public** (décision explicite) pour débloquer cette fonctionnalité.

**Conséquence directe (`enforce_admins: true`) : plus aucun push direct sur `main`, y compris pour l'opérateur humain.** Tout changement — agent ou humain — passe par une branche + PR + CI verte + merge. Un `git push origin main` direct sera rejeté par GitHub (`protected branch hook declined`).

## Agent Identities

- Chaque subagent a sa propre identité git (`user.name`/`user.email`, configurée localement au repo avant chaque invocation, voir `AGENT_IDENTITIES` dans `src/claude.ts`) : `everest-issue-worker` pour le code, `everest-code-reviewer` pour la review — ça permet de savoir qui (quel agent) a committé quoi.
- Limite connue : l'auteur de la PR elle-même (`gh pr create`) et les reviews (`gh pr review`) restent attribués au compte GitHub propriétaire de `GH_TOKEN`, pas à une identité d'agent — GitHub n'offre aucun moyen de contourner ça sans un compte/token séparé par agent. Pas mis en place pour l'instant (décision explicite : rester sur un seul compte).
- Le squash-merge réattribue toujours le commit final à qui merge, même si les commits d'origine sur la branche ont la bonne identité — accepté comme limitation connue (décision explicite de garder squash).

## Development Workflow

- Une fonctionnalité ou un correctif = un commit sur une branche `harness/issue-<n>-<slug>`, jamais directement sur `main`.
- Messages de commit clairs, référençant le numéro d'issue (ex: `Add priority sort (closes #3)`).
- Le push vers `origin` est fait par le harnais lui-même après détection du commit, pas par l'agent — ne pas essayer de pousser manuellement.
- `npm test` doit passer avant tout commit (imposé par hook, voir Security Standards).
- `npm run lint` (ESLint + Prettier) doit passer avant tout push (imposé par Husky `pre-push`).

## Code Review

**Politique changée le 17 juillet 2026, décision explicite de l'utilisatrice** : le produit doit être autonome — deux agents distincts, l'un développe (`issue-worker`), l'autre valide et merge (`code-reviewer`). Ce n'est plus "le merge reste un geste humain" (ancienne règle, ne plus l'appliquer).

- `code-reviewer` est le seul décideur de ce qui atteint `main`. Il merge lui-même (`gh pr merge`) une fois que **toutes** les conditions sont réunies : CI verte (`statusCheckRollup`), `npm run lint`/`npm test` verts en local sur son propre run (pas de confiance aveugle dans le diff), pas de bug de correctness/sécurité non traité, tests E2E présents, doc à jour si le changement le justifie.
- S'il manque une seule de ces conditions : commentaire + label `needs-fixup` (voir Review Loop — `--request-changes` échoue sur sa propre PR), jamais de merge "en attendant".
- `src/loop.ts` ne merge jamais lui-même — il ne fait qu'invoquer `code-reviewer` et lire l'état de la PR après coup (`getPullRequestState`). Toute la décision de merge vit dans l'agent, pas dans le code TypeScript du harnais.
- Le seul gate qui reste réellement indépendant des agents est CI + branch protection (`enforce_admins: true`) : même `code-reviewer` ne peut pas merger si le check `lint-and-test` échoue.

## Code Style

- ESLint (`eslint.config.js`) impose la nomenclature : camelCase pour fonctions/variables, PascalCase pour les types.
- Toute fonction exportée doit avoir un commentaire TSDoc (`/** ... */`) décrivant ce qu'elle fait — imposé par `eslint-plugin-jsdoc` (`jsdoc/require-jsdoc`).
- Prettier formate automatiquement (`npm run format`) ; `npm run lint` vérifie que c'est déjà fait.

## Testing Requirements

- Toute fonctionnalité ajoutée ou bug corrigé doit avoir un test E2E dans `test/`.
- `npm test` (vitest) doit passer avant de committer.

## Security Standards

- Un hook `PreToolUse` bloque (`exit 2`) tout `git commit` si `npm run lint` ou `npm test` échoue — ne pas contourner en committant via un autre outil.
- Un hook `PreToolUse` bloque toute commande Bash contenant un pattern de secret probable (clé API, token, mot de passe).
- Ne jamais committer `.env` ou toute valeur de `CLAUDE_CODE_OAUTH_TOKEN` / `GH_TOKEN`.

## Memory

Chaque invocation d'`issue-worker`/`code-reviewer` est une session fraîche : pas de mémoire des runs précédents au-delà de ce qui est commité dans le repo (voir Architecture Overview). Évalué dans l'issue #12 : intégrer mem0 (service externe de mémoire vectorielle) vs. mémoire fichier native. Décision : mémoire fichier native, pas de mem0 — aucun besoin concret non couvert par un simple fichier versionné n'a été identifié, et mem0 aurait ajouté une dépendance/service externe (clé API, coût, point de défaillance supplémentaire) pour un problème que git résout déjà.

Concrètement : `MEMORY.md` à la racine du repo consigne les leçons/patterns/décisions récurrents repérés par les agents. Il est injecté automatiquement dans le prompt de chaque invocation d'agent (`memorySection()` dans `src/prompt.ts`, utilisé par `buildPrompt`/`buildFixupPrompt` et par `runCodeReview` dans `src/claude.ts`), tronqué au-delà de `MAX_MEMORY_CHARS` pour éviter qu'un fichier mal élagué ne gonfle indéfiniment le prompt. `issue-worker` peut y ajouter une entrée directement ; `code-reviewer`, qui ne commite pas sur la branche, le signale dans son commentaire de review pour qu'`issue-worker` l'ajoute au prochain cycle. Les décisions d'architecture durables migrent vers ce fichier (`CLAUDE.md`) plutôt que de rester dans `MEMORY.md`.

## Known Pitfalls

- `--permission-mode acceptEdits` ne suffit pas en headless : les appels Bash (donc `npm test`, `git commit`) sont refusés silencieusement sans personne pour approuver. Il faut `bypassPermissions`, ce qui n'est sûr que confiné dans le conteneur Docker du harnais.
- Cette contrainte ("bypassPermissions seulement confiné au sandbox") s'applique aussi hors headless : `everest chat` (`runChat` dans `src/cli.ts`, issue #33) démarre/réutilise le conteneur Docker Compose `harness` (`docker compose up -d harness`, idempotent) puis lance `claude --agent chat --permission-mode bypassPermissions` **dedans** via `docker compose exec -it`, plutôt que sur l'hôte comme avant. Ce n'est pas le fait qu'un humain soit au clavier qui rendait `bypassPermissions` risqué, c'est l'absence de confinement — `-it` donne une session interactive normale, mais c'est le conteneur qui rend le bypass des prompts d'approbation acceptable.
- `bypassPermissions` refuse de s'exécuter en root — le conteneur tourne avec l'utilisateur `node`.
- `git push` en HTTPS a besoin du credential helper `gh auth git-credential` configuré globalement dans le conteneur (pas d'auth interactive possible en headless).
- `runLoop` isole chaque itération dans un try/catch (`src/loop.ts`) : une erreur non gérée (ex: `createBranch` qui échoue sur une branche locale orpheline laissée par une tentative interrompue) est loguée puis la boucle continue après `pollIntervalMs`, plutôt que de faire planter tout le conteneur. `createBranch` est devenu idempotent (`git branch -D` avant `checkout -b`) pour la même raison. Bug repéré en observant le harnais tourner sans supervision : une issue trop ambitieuse pour son budget (#15) a planté tout le process, pas juste cette issue.

## References

- Repo : github.com/WhiteRoseLK/everest
- Plan d'implémentation initial : voir historique de conversation / commits du 15-16 juillet 2026
