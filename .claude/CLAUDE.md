# Project: everest

## Mission
Harnais léger qui orchestre Claude Code en headless pour traiter un backlog GitHub Issues de façon autonome : implémenter, tester, committer, ouvrir une PR.

## Architecture Overview
`src/loop.ts` lit les issues ouvertes (FIFO), crée une branche, invoque `claude -p` en mode `bypassPermissions` dans un sandbox Docker, vérifie qu'un commit a bien été produit, pousse la branche et ouvre la PR. Tout tourne en dehors d'une conversation longue : chaque issue = une invocation fraîche, pas de contexte accumulé entre issues.

## Development Workflow
- Une fonctionnalité ou un correctif = un commit sur une branche `harness/issue-<n>-<slug>`.
- Le push vers `origin` est fait par le harnais lui-même après détection du commit, pas par l'agent — ne pas essayer de pousser manuellement.
- `npm test` doit passer avant tout commit (imposé par hook, voir Security Standards).

## Testing Requirements
- Toute fonctionnalité ajoutée ou bug corrigé doit avoir un test E2E dans `test/`.
- `npm test` (vitest) doit passer avant de committer.

## Security Standards
- Un hook `PreToolUse` bloque (`exit 2`) tout `git commit` si `npm test` échoue — ne pas contourner en committant via un autre outil.
- Un hook `PreToolUse` bloque toute commande Bash contenant un pattern de secret probable (clé API, token, mot de passe).
- Ne jamais committer `.env` ou toute valeur de `CLAUDE_CODE_OAUTH_TOKEN` / `GH_TOKEN`.

## Known Pitfalls
- `--permission-mode acceptEdits` ne suffit pas en headless : les appels Bash (donc `npm test`, `git commit`) sont refusés silencieusement sans personne pour approuver. Il faut `bypassPermissions`, ce qui n'est sûr que confiné dans le conteneur Docker du harnais.
- `bypassPermissions` refuse de s'exécuter en root — le conteneur tourne avec l'utilisateur `node`.
- `git push` en HTTPS a besoin du credential helper `gh auth git-credential` configuré globalement dans le conteneur (pas d'auth interactive possible en headless).

## References
- Repo : github.com/WhiteRoseLK/everest
- Plan d'implémentation initial : voir historique de conversation / commits du 15-16 juillet 2026
