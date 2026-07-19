#!/usr/bin/env bash
# Bootstrap "clé en main" pour déployer everest sur un hôte frais (typiquement un VPS
# Debian/Ubuntu). Le seul prérequis hôte est Docker + Docker Compose : le conteneur
# `harness` (voir Dockerfile) embarque déjà Node, npm et `gh`, donc il n'y a rien d'autre
# à installer sur l'hôte lui-même (voir issue #71 — avant ce script, le README suggérait
# `npm install && npm start` en premier, ce qui laissait croire à tort qu'il fallait Node/gh
# sur l'hôte).
#
# Usage: ./setup.sh
set -euo pipefail

log() {
  echo "==> $*"
}

install_docker_debian() {
  log "Docker introuvable, installation via le script officiel get.docker.com..."
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh

  if ! groups "$USER" | grep -q '\bdocker\b'; then
    log "Ajout de $USER au groupe 'docker' (évite de préfixer chaque commande par sudo)..."
    sudo usermod -aG docker "$USER"
    log "Déconnecte-toi puis reconnecte-toi (ou lance 'newgrp docker') pour que le groupe soit pris en compte, puis relance ce script."
    exit 0
  fi
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker déjà installé ($(docker --version))."
    return
  fi

  local os
  os="$(uname -s)"
  if [ "$os" != "Linux" ]; then
    echo "Docker n'est pas installé et ce script ne sait automatiser son installation que sur Linux (Debian/Ubuntu)." >&2
    echo "Installe Docker Desktop manuellement (https://docs.docker.com/desktop/) puis relance ce script." >&2
    exit 1
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Distribution Linux non basée sur apt : installe Docker manuellement (https://docs.docker.com/engine/install/) puis relance ce script." >&2
    exit 1
  fi

  install_docker_debian
}

ensure_compose() {
  if docker compose version >/dev/null 2>&1; then
    log "Docker Compose déjà disponible ($(docker compose version --short 2>/dev/null || echo 'plugin détecté'))."
    return
  fi
  echo "Docker est installé mais le plugin 'docker compose' est absent." >&2
  echo "Réinstalle Docker via https://docs.docker.com/engine/install/ (le plugin compose est inclus) puis relance ce script." >&2
  exit 1
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
