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
node bin/everest.js ask "<message>" [--priority <critical|high|medium|low>]  # crée une issue
node bin/everest.js status                                                   # PR ouvertes + issues fermées récemment
node bin/everest.js blockers                                                 # PR labellisées needs-human + dernier commentaire
```

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
