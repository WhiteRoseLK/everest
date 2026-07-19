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

start_harness() {
  log "Démarrage du conteneur harness (docker compose up -d --build)..."
  docker compose up -d --build harness
  log "Harnais démarré. Logs : docker compose logs -f harness"
}

main() {
  ensure_docker
  ensure_compose
  ensure_env_file
  start_harness
}

main "$@"
