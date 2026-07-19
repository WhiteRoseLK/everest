# Everest

Everest lit un backlog GitHub Issues et traite les issues une par une (features + bugs) en invoquant Claude Code en mode headless, impose des tests E2E, et ouvre des PR — en s'auto-améliorant en continu.

## Prérequis

- [Docker Engine](https://docs.docker.com/engine/install/) + le plugin Compose (`docker compose version`
  doit fonctionner). Rien d'autre : Node, npm et `gh` sont déjà embarqués dans l'image du conteneur
  qui fait tourner Everest (voir `Dockerfile`), donc inutile de les installer sur l'hôte.

## Setup

Une fois Docker installé :

```
git clone https://github.com/WhiteRoseLK/everest.git
cd everest
./setup.sh
```

`setup.sh` vérifie que Docker/Docker Compose sont bien présents (sinon il s'arrête en pointant vers
la section "Prérequis" ci-dessus), crée `.env` depuis `.env.example` s'il n'existe pas encore (le
script s'arrête alors le temps que tu renseignes `GITHUB_REPO`/`CLAUDE_CODE_OAUTH_TOKEN`/`GH_TOKEN`),
puis lance `docker compose up -d --build harness`. Relance simplement `./setup.sh` une fois `.env`
rempli.

Le conteneur tourne en boucle continue (`restart: unless-stopped`, voir `docker-compose.yml`) :
tant qu'il est up, Everest continue de traiter les issues ouvertes du repo au fil de l'eau — pas de
déploiement à répéter à chaque issue, tant que le budget de tokens/API suit (voir "Budget Policy"
dans `CLAUDE.md`). `docker compose logs -f harness` pour suivre l'activité, `docker compose down`
pour arrêter.

`setup.sh` ajoute aussi automatiquement un alias `everest` à ton shell (`.bashrc`/`.zshrc` selon
`$SHELL`, idempotent — pas de doublon si tu relances le script), qui exécute la CLI _dans_ le
conteneur (`docker compose exec harness node bin/everest.js ...`) puisque l'hôte n'a que Docker,
pas Node. Une fois le shell rechargé (`source ~/.bashrc`/`~/.zshrc`, ou un nouveau terminal), il
suffit de lancer `everest` pour interagir avec lui — voir la section CLI ci-dessous.

### Dev local sans Docker

Pour itérer sur le code d'Everest lui-même sans repasser par l'image Docker à chaque changement :

```
npm install
cp .env.example .env  # ajuster les valeurs
npm start
```

Nécessite alors Node.js et `gh` installés et authentifiés sur l'hôte. Ce chemin ne bénéficie pas
du confinement `bypassPermissions` ni de l'auto-redémarrage sur merge de `main` (voir "Known
Pitfalls" dans `CLAUDE.md`) — réservé au développement, pas à un déploiement long-terme.

## CLI

Pour interagir avec Everest, il suffit de lancer `everest` : c'est l'alias installé automatiquement
par `setup.sh` (voir Setup ci-dessus), qui exécute la CLI (`bin/everest.js`, point d'entrée
`src/cli.ts`) dans le conteneur plutôt que sur l'hôte, sans qu'il faille taper de commandes `gh` à
la main :

```
everest                                                          # ouvre une session de chat interactive (= `chat`)
everest chat                                                     # idem, explicite
everest ask "<message>" [--priority <critical|high|medium|low>] [--title "<title>"]  # crée une issue
everest status                                                   # PR ouvertes + issues fermées récemment
everest blockers                                                 # PR labellisées needs-human + dernier commentaire
everest catchup                                                  # résumé "qu'ai-je manqué" depuis le dernier catchup
everest doctor                                                   # auto-diagnostic : .harness/ inscriptible ?, issue en cours, erreurs d'itération
everest watch [--interval <ms>]                                  # poll continu (façon `watch`) des blockers/needs-fixup
```

(En dev local sans Docker — voir ci-dessus —, remplace `everest` par `node bin/everest.js` : pas de
conteneur dans lequel router l'alias.)

`chat` (et l'invocation nue `everest` sans sous-commande) ouvre une session `claude` interactive
avec l'agent `chat` (`.claude/agents/chat.md`) plutôt qu'une commande one-shot : on y pose des
questions en langage naturel sur l'état du projet (équivalent de `status`/`blockers`) ou on demande
de créer une issue (équivalent de `ask`), l'agent s'appuie sur `gh` pour y répondre. Cette session
tourne avec `--permission-mode bypassPermissions` (comme `issue-worker`/`code-reviewer`) : les tool
calls s'exécutent sans prompt d'approbation, ce qui n'est acceptable que confiné dans le sandbox
Docker (voir "Known Pitfalls" dans `CLAUDE.md`) — raison pour laquelle l'alias route systématiquement
vers le conteneur plutôt que d'exécuter la CLI sur l'hôte. Hors conteneur (`node bin/everest.js`
directement sur l'hôte, en dev local sans Docker), `chat` démarre/réutilise lui-même le conteneur
via `docker compose exec -it`, ce qui nécessite alors `docker`/`docker compose` disponibles
localement, en plus de `gh`.

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

`--title "<title>"` court-circuite `deriveIssueTitle` (une heuristique de troncature, pas un vrai
résumé — voir issue #44) avec un titre choisi explicitement par l'appelant, pour les cas où un
vrai jugement est disponible (typiquement l'agent `chat`, qui compose déjà un titre concis avant
d'appeler `ask`). N'a d'effet que quand `message` reste un seul topic : sur un message qui se
scinde en plusieurs issues (`splitIntoTopics`), un titre unique ne peut pas s'appliquer à chacune
d'elles, donc `--title` est ignoré (avec un avertissement) et chaque topic retombe sur son propre
titre dérivé.

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
