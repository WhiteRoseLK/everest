# Project: everest

## Mission

Développer ce projet en continu, en s'auto-améliorant autant que possible. GitHub Issues est le mécanisme opérationnel (comment le travail est proposé et suivi), pas la mission elle-même — la mission n'est pas de "vider un backlog" mécaniquement.

## Architecture Overview

`src/loop.ts` lit les issues ouvertes (FIFO, `priority:high` en premier), crée une branche, invoque `claude -p --agent issue-worker` en mode `bypassPermissions` dans un sandbox Docker, vérifie qu'un commit a bien été produit, pousse la branche et ouvre la PR. Tout tourne en dehors d'une conversation longue : chaque issue = une invocation fraîche, pas de contexte accumulé entre issues. L'agent `issue-worker` (`.claude/agents/issue-worker.md`) peut lui-même ouvrir de nouvelles issues quand il repère des améliorations hors scope — c'est la boucle d'auto-amélioration.

## Review Loop

Une fois la PR ouverte, `code-reviewer` (`.claude/agents/code-reviewer.md`) est invoqué sur la branche : il checkout, lance lui-même `npm run lint`/`npm test` (ne fait pas confiance au diff seul), lit le diff, vérifie que le check CI `lint-and-test` est vert, puis décide.

`gh pr review --approve` échoue sur sa propre PR ("Can not approve your own pull request" — PR et review partagent le même compte `GH_TOKEN`). Le reviewer ne l'utilise donc pas : s'il juge la PR prête, il **merge directement** (`gh pr merge --squash --delete-branch`). S'il juge que ce n'est pas prêt, il utilise `gh pr review --request-changes` (ça, ça marche sur sa propre PR — seule l'approbation formelle est bloquée).

Si `--request-changes` : le harnais rappelle `issue-worker` sur la même branche avec le retour du reviewer en contexte (`buildFixupPrompt`), repousse le commit, puis relance `code-reviewer`. Ce cycle se répète jusqu'au merge ou jusqu'à `MAX_REVIEW_CYCLES` (défaut 3, `runReviewLoop` dans `src/loop.ts`) — budget de lancement pour éviter une boucle infinie si l'agent et le reviewer n'arrivent jamais à s'accorder. Au-delà, un commentaire est posté sur l'issue pour signaler qu'une intervention humaine est nécessaire. Le harnais détecte la fin du cycle via `getPullRequestState()` (état `MERGED`), pas seulement via `reviewDecision` (qui reste `null` sur un merge direct, faute d'approve formel possible).

Avant de créer une nouvelle branche pour l'issue suivante, le harnais fait `checkoutMain()` (checkout + `pull --ff-only`) plutôt que de partir de la branche précédente — sinon une branche mergée-et-supprimée côté remote laisserait le prochain `git checkout -b` partir d'un historique obsolète (bug auto-repéré par le harnais, issue #17).

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
- S'il manque une seule de ces conditions : `--request-changes`, jamais de merge "en attendant".
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

## Known Pitfalls

- `--permission-mode acceptEdits` ne suffit pas en headless : les appels Bash (donc `npm test`, `git commit`) sont refusés silencieusement sans personne pour approuver. Il faut `bypassPermissions`, ce qui n'est sûr que confiné dans le conteneur Docker du harnais.
- `bypassPermissions` refuse de s'exécuter en root — le conteneur tourne avec l'utilisateur `node`.
- `git push` en HTTPS a besoin du credential helper `gh auth git-credential` configuré globalement dans le conteneur (pas d'auth interactive possible en headless).

## References

- Repo : github.com/WhiteRoseLK/everest
- Plan d'implémentation initial : voir historique de conversation / commits du 15-16 juillet 2026
