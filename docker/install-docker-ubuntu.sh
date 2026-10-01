#!/usr/bin/env bash
# Install Docker Engine + compose plugin from Docker's official apt repo.
# Works on Ubuntu 22.04 (jammy) and 24.04 (noble).
#
#   sudo ./docker/install-docker-ubuntu.sh            # installs for $SUDO_USER
#
# Afterwards log out and back in (or run `newgrp docker`) so the user can run
# docker without sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi
TARGET_USER="${SUDO_USER:-}"

avail_gb=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
if (( avail_gb < 8 )); then
  echo "Only ${avail_gb} GB free on / — the trace-kit image needs about 8 GB. Free space first." >&2
  exit 1
fi

. /etc/os-release
echo "Installing Docker for Ubuntu ${VERSION_ID} (${VERSION_CODENAME})"

apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker

if [[ -n "$TARGET_USER" ]]; then
  usermod -aG docker "$TARGET_USER"
  echo "Added $TARGET_USER to the docker group — log out/in or run: newgrp docker"
fi

docker --version
docker compose version
docker run --rm hello-world >/dev/null && echo "Docker works."
