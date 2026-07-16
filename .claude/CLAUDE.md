# Project: everest

## Mission

Développer ce projet en continu, en s'auto-améliorant autant que possible. GitHub Issues est le mécanisme opérationnel (comment le travail est proposé et suivi), pas la mission elle-même — la mission n'est pas de "vider un backlog" mécaniquement.

## Architecture Overview

`src/loop.ts` lit les issues ouvertes (FIFO, `priority:high` en premier), crée une branche, invoque `claude -p --agent issue-worker` en mode `bypassPermissions` dans un sandbox Docker, vérifie qu'un commit a bien été produit, pousse la branche et ouvre la PR. Une fois la PR ouverte, `claude -p --agent code-reviewer` est invoqué sur la même branche pour laisser une review (jamais d'approve/merge automatique). Tout tourne en dehors d'une conversation longue : chaque issue = une invocation fraîche, pas de contexte accumulé entre issues. L'agent `issue-worker` (`.claude/agents/issue-worker.md`) peut lui-même ouvrir de nouvelles issues quand il repère des améliorations hors scope — c'est la boucle d'auto-amélioration.

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

- Le harnais n'a pas le droit de merger ses propres PR : `openPullRequest()` ouvre la PR et s'arrête là, le merge reste un geste humain.
- Toute PR doit être relue avant merge, même ouverte automatiquement par le harnais.
- Ne jamais ajouter de merge automatique/auto-merge à `src/github.ts` sans que ce soit explicitement demandé.

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
