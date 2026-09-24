#!/usr/bin/env bash
# One-shot: (re)creates the local LocalStack container and provisions its
# tables/bucket via Terraform, so `go run ./cmd/server` (see ../README.md's
# "Running locally") has something to talk to.
#
# Safe to re-run any time the container looks wrong — a stale SERVICES
# list, LocalStack forgetting its state after a machine restart, or the
# "ResourceNotFoundException: Cannot do operations on a non-existent
# table" error that means nothing was ever provisioned this boot. It
# always removes and recreates the container, since LocalStack's state
# lives only in it: there is nothing local dev needs preserved across a
# reset, and a stale container is a worse debugging trap than a fresh one.
#
#   provision/local-setup.sh
set -euo pipefail

localstack_version="localstack/localstack:4.4.0"  # see README.md for why this exact version

server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Recreating the localstack container..."
docker rm -f localstack >/dev/null 2>&1 || true
docker run -d --name localstack -p 4566:4566 -e SERVICES=dynamodb,s3,ssm "$localstack_version" >/dev/null

echo -n "Waiting for DynamoDB and S3..."
for _ in $(seq 1 30); do
  health=$(curl -sf http://localhost:4566/_localstack/health || true)
  if grep -Eq '"dynamodb": *"(available|running)"' <<<"$health" && grep -Eq '"s3": *"(available|running)"' <<<"$health"; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 2
done

cd "$server_dir/provision/envs/local"
terraform init -input=false >/dev/null
terraform apply -auto-approve

echo
echo "Local LocalStack is up and provisioned — 'go run ./cmd/server' (with"
echo "local.env loaded) can reach it now."
