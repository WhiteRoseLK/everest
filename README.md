# everest

Harnais léger d'orchestration Claude Code. Lit un backlog GitHub Issues, traite les issues une par une (features + bugs) en invoquant Claude Code en mode headless, impose des tests E2E, et ouvre des PR.

## Setup

```
npm install
cp .env.example .env  # déjà fait en local, ajuster si besoin
npm start
```

## CLI

`everest` (`bin/everest.js`, point d'entrée `src/cli.ts`) permet d'interagir avec le harnais sans
taper des commandes `gh` à la main :

```
node bin/everest.js                                                          # ouvre une session de chat interactive (= `chat`)
node bin/everest.js chat                                                     # idem, explicite
node bin/everest.js ask "<message>" [--priority <critical|high|medium|low>]  # crée une issue
node bin/everest.js status                                                   # PR ouvertes + issues fermées récemment
node bin/everest.js blockers                                                 # PR labellisées needs-human + dernier commentaire
node bin/everest.js watch [--interval <ms>]                                  # poll continu (façon `watch`) des blockers/needs-fixup
```

`chat` (et l'invocation nue `everest` sans sous-commande) démarre (ou réutilise, si déjà lancé)
le conteneur Docker Compose `harness` puis y ouvre une session `claude` interactive (`docker
compose exec -it`) avec l'agent `chat` (`.claude/agents/chat.md`) plutôt qu'une commande one-shot :
on y pose des questions en langage naturel sur l'état du projet (équivalent de `status`/
`blockers`) ou on demande de créer une issue (équivalent de `ask`), l'agent s'appuie sur `gh` pour
y répondre. Contrairement à l'ancien design, cette session tourne désormais avec
`--permission-mode bypassPermissions` (comme `issue-worker`/`code-reviewer`) : les tool calls
s'exécutent sans prompt d'approbation, ce qui n'est devenu acceptable qu'en confinant la session
dans le sandbox Docker (voir "Known Pitfalls" dans CLAUDE.md) plutôt qu'en l'exécutant directement
sur l'hôte. Nécessite donc `docker`/`docker compose` disponibles localement, en plus de `gh`.

`watch` réaffiche périodiquement (intervalle `--interval`, défaut `WATCH_POLL_INTERVAL_MS`,
30s) les PR labellisées `needs-human` (avec leur dernier commentaire) et celles encore en boucle
de review (`needs-fixup`), sans qu'il faille relancer `blockers` à la main. Réutilise
`listBlockers`/`listHarnessPullRequests` (`src/github.ts`), pas de nouveau service - juste un
intervalle de poll côté CLI, comme `pollIntervalMs` dans `src/loop.ts`.

Nécessite `GITHUB_REPO` (voir `.env`/`src/config.ts`) et `gh` authentifié dans le `PATH`.

## Structure

- `src/loop.ts` — boucle principale
- `src/github.ts` — wrapper `gh` CLI (issues, branches, PR)
- `src/claude.ts` — invocation headless de Claude Code
- `src/state.ts` — checkpoint disque (reprise après rate-limit)
- `src/config.ts` — lecture/validation `.env`
- `src/prompt.ts` — construction du prompt + instructions QA E2E
- `src/cost.ts` — journal disque (`.harness/cost-log.jsonl`) du coût token (`total_cost_usd`) de chaque invocation, pour mesurer avant d'envisager une compression de contexte (voir issue #13)
- `src/cli.ts` / `bin/everest.js` — CLI `everest` (voir section CLI ci-dessus)
- `.claude/agents/chat.md` — agent interactif utilisé par `everest chat`
