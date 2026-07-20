#!/usr/bin/env bash
# Bootstrap pour déployer everest sur un hôte déjà équipé de Docker (voir la section
# "Prérequis" du README). Ce script ne touche pas à l'installation de Docker lui-même : il
# vérifie juste sa présence et s'arrête avec un message clair sinon. Le conteneur `harness`
# (voir Dockerfile) embarque déjà Node, npm et `gh`, donc il n'y a rien d'autre à installer
# sur l'hôte au-delà de Docker (voir issue #71 — avant ce script, le README suggérait
# `npm install && npm start` en premier, ce qui laissait croire à tort qu'il fallait Node/gh
# sur l'hôte).
#
# Usage: ./setup.sh
set -euo pipefail

log() {
  echo "==> $*"
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker n'est pas installé. Voir la section 'Prérequis' du README pour l'installer, puis relance ce script." >&2
    exit 1
  fi
  log "Docker déjà installé ($(docker --version))."
}

ensure_compose() {
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker est installé mais le plugin 'docker compose' est absent. Voir la section 'Prérequis' du README, puis relance ce script." >&2
    exit 1
  fi
  log "Docker Compose déjà disponible ($(docker compose version --short 2>/dev/null || echo 'plugin détecté'))."
}

ensure_env_file() {
  if [ -f .env ]; then
    log ".env déjà présent."
    return
  fi
  log ".env absent, création depuis .env.example..."
  cp .env.example .env
  echo
  echo "Édite .env et renseigne au minimum GITHUB_REPO, CLAUDE_CODE_OAUTH_TOKEN et GH_TOKEN," >&2
  echo "puis relance ./setup.sh pour démarrer le conteneur." >&2
  exit 0
}

start_everest() {
  log "Démarrage du conteneur Everest (docker compose up -d --build)..."
  docker compose --project-directory "$REPO_DIR" up -d --build harness
  log "Everest est démarré."
}

# Résout le fichier de config de l'interpréteur de l'opérateur (pas celui de ce script, qui
# tourne en bash même si l'opérateur est sous zsh) pour y ajouter l'alias `everest`.
shell_rc_file() {
  case "$(basename "${SHELL:-bash}")" in
    zsh) echo "$HOME/.zshrc" ;;
    *) echo "$HOME/.bashrc" ;;
  esac
}

# Ajoute un alias `everest` qui exécute la CLI *dans* le conteneur (`docker compose exec`)
# plutôt que sur l'hôte : l'hôte n'a que Docker (voir Prérequis), pas Node, donc `node
# bin/everest.js` ne peut tourner que côté conteneur, qui l'embarque déjà (voir Dockerfile).
# `-u node` est indispensable : le conteneur démarre en root (son entrypoint réaligne l'ownership
# du repo bind-monté sur node avant de dropper vers node - voir docker-entrypoint.sh / issue #84),
# donc un `exec` sans `-u` tournerait en root, ce que `bypassPermissions` de Claude Code refuse.
# Idempotent : ne réécrit rien si l'alias est déjà présent.
ensure_alias() {
  local rc_file
  rc_file="$(shell_rc_file)"
  local alias_line="alias everest='docker compose --project-directory \"$REPO_DIR\" exec -u node harness node bin/everest.js'"

  if [ -f "$rc_file" ] && grep -qF "alias everest=" "$rc_file"; then
    log "Alias 'everest' déjà présent dans $rc_file."
    return
  fi

  {
    echo ""
    echo "# Ajouté par everest/setup.sh : interagir avec Everest via 'everest' (status/ask/chat/...)"
    echo "$alias_line"
  } >>"$rc_file"
  log "Alias 'everest' ajouté à $rc_file."
  echo "Lance 'source $rc_file' (ou ouvre un nouveau terminal) pour l'utiliser dans cette session." >&2
}

main() {
  ensure_docker
  ensure_compose
  ensure_env_file
  start_everest
  ensure_alias
  echo
  echo "Pour interagir avec Everest, lance simplement : everest"
}

main "$@"
