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
node bin/everest.js catchup                                                  # résumé "qu'ai-je manqué" depuis le dernier catchup
node bin/everest.js events                                                   # vide et affiche le backlog d'évènements non lus
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

`catchup` (`buildCatchupSummary`, `src/catchup.ts`) donne un résumé façon "équipe" - issues
fermées/ouvertes, PR en cours de review (`needs-fixup`) - depuis le dernier `catchup`, et se
termine toujours par un signal explicite ("Nothing needs you right now." ou "⚠️ Needs you: ...").
Contrairement à `status` (fenêtre fixe de 24h), la fenêtre est ancrée sur un horodatage persisté
(`.harness/catchup-last-seen.json`, gitignored, mis à jour à chaque appel) - donc "depuis la
dernière fois que tu as vérifié", pas une fenêtre glissante arbitraire. L'agent `chat` déclenche
aussi ce résumé de façon proactive quand on lui demande "qu'ai-je manqué"/"where are we", sans
attendre le nom exact de la sous-commande (voir `.claude/agents/chat.md`).

`ask` (`createIssuesFromMessage`, `src/github.ts`) ne se contente plus de dumper le message tel
quel (issue #38) : le titre reste dérivé via `deriveIssueTitle`, mais le corps est structuré (`##
Request`), un label de type (`bug`/`enhancement`/`documentation`/`question`) est déduit du contenu
via `inferLabels` (mots-clés), et `--priority` reste prioritaire sur l'urgence déduite du texte.
Si le message est une liste à puces/numérotée regroupant plusieurs demandes indépendantes
(`splitIntoTopics`), il est éclaté en autant d'issues séparées, croisées entre elles ("part of a
split, see also #x, #y") plutôt que de rester une seule issue surdimensionnée.

`events` (`src/eventlog.ts`, issue #42) vide et affiche le journal d'évènements append-only
(`.harness/event-log.jsonl`, gitignored) que `src/loop.ts` remplit _au fil de l'eau_ - PR mergée,
cycle `needs-fixup` démarré, escalade `needs-human` - plutôt que de le recalculer à la demande
comme `catchup`. Un marqueur (`.harness/event-log-drained.json`) retient combien d'évènements ont
déjà été montrés, pour qu'un second appel ne réaffiche que les nouveaux. `everest chat` en draine
et affiche le contenu automatiquement, sans qu'on ait besoin de demander, avant même d'ouvrir la
session interactive (le "must-do" de l'issue #42) ; l'agent `chat` relance ensuite `everest
events` à chaque tour (voir `.claude/agents/chat.md`) pour approcher, en best-effort, une
notification en direct pendant qu'une session est déjà ouverte - il n'existe pas de canal pour
qu'un processus externe (la boucle du harnais) pousse dans un tour déjà en cours d'affichage.

Nécessite `GITHUB_REPO` (voir `.env`/`src/config.ts`) et `gh` authentifié dans le `PATH`.

## Structure

- `src/loop.ts` — boucle principale
- `src/github.ts` — wrapper `gh` CLI (issues, branches, PR)
- `src/claude.ts` — invocation headless de Claude Code
- `src/state.ts` — checkpoint disque (reprise après rate-limit)
- `src/config.ts` — lecture/validation `.env`
- `src/prompt.ts` — construction du prompt + instructions QA E2E
- `src/cost.ts` — journal disque (`.harness/cost-log.jsonl`) du coût token (`total_cost_usd`) de chaque invocation, pour mesurer avant d'envisager une compression de contexte (voir issue #13)
- `src/eventlog.ts` — journal disque append-only (`.harness/event-log.jsonl`) de l'activité notable du harnais (PR mergée, cycle `needs-fixup`, escalade `needs-human`), drainé par `everest chat`/`everest events` (issue #42)
- `src/cli.ts` / `bin/everest.js` — CLI `everest` (voir section CLI ci-dessus)
- `.claude/agents/chat.md` — agent interactif utilisé par `everest chat`
