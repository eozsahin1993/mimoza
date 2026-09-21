#!/usr/bin/env bash
# Uploads server/<env>.env to SSM, where the Lambda module reads it:
# settings go to /<RESOURCE_PREFIX>/config/<KEY> (read by Terraform at
# apply time), the two push keys to /<RESOURCE_PREFIX>/fcm-service-account
# and /<RESOURCE_PREFIX>/apns-auth-key (read by the relay at runtime). Run it
# again whenever the file changes, then `terraform apply` so the Lambda
# picks the new settings up.
#
#   provision/push-config.sh staging
set -euo pipefail

env_name="${1:?usage: push-config.sh <staging|prod>}"
server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$server_dir/$env_name.env"
[[ -f "$env_file" ]] || { echo "no $env_file — copy .env.example" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

# Terraform names this env mimoza-<env>; a mismatched prefix would upload
# settings the Lambda never reads.
[[ "${RESOURCE_PREFIX:-}" == "mimoza-$env_name" ]] ||
  { echo "RESOURCE_PREFIX in $env_name.env must be mimoza-$env_name" >&2; exit 1; }

# Only relay settings leave the machine — never AWS credentials, PORT, or
# the LocalStack switches that may sit in the same file.
settings=(
  GOOGLE_CLIENT_ID_IOS GOOGLE_CLIENT_ID_ANDROID GOOGLE_CLIENT_ID_WEB
  APPLE_CLIENT_ID_IOS APPLE_SIGNIN_KEY_ID APPLE_SIGNIN_TEAM_ID
  APNS_KEY_ID APNS_TEAM_ID APNS_TOPIC APNS_PRODUCTION
)

put() { aws ssm put-parameter --overwrite --type "$1" --name "$2" --value "$3" >/dev/null; }
# SSM rejects empty values, so a blank setting deletes its parameter
# instead — clearing a line in the file clears it in the Lambda too.
remove() { aws ssm delete-parameter --name "$1" >/dev/null 2>&1 || true; }

for key in "${settings[@]}"; do
  name="/$RESOURCE_PREFIX/config/$key"
  if [[ -n "${!key:-}" ]]; then
    put String "$name" "${!key}"
    echo "set     $name"
  else
    remove "$name"
    echo "cleared $name"
  fi
done

for pair in FCM_CREDENTIAL_FILE=fcm-service-account APNS_AUTH_KEY_FILE=apns-auth-key APPLE_SIGNIN_KEY_FILE=apple-signin-key; do
  key="${pair%%=*}"
  name="/$RESOURCE_PREFIX/${pair#*=}"
  path="${!key:-}"
  if [[ -z "$path" ]]; then
    echo "skipped $name ($key not set)"
    continue
  fi
  [[ "$path" = /* ]] || path="$server_dir/$path"
  # Refuse a key that doesn't parse. Uploaded, it only shows up as a relay
  # that quietly can't sign: prod's FCM key sat broken that way for days,
  # damaged on disk by a repo-wide find-and-replace.
  if [[ "$key" == FCM_CREDENTIAL_FILE ]]; then
    jq -er .private_key "$path" 2>/dev/null | openssl pkey -noout 2>/dev/null
  else
    openssl pkey -in "$path" -noout 2>/dev/null
  fi || { echo "refusing $name: $path doesn't hold a key that parses" >&2; exit 1; }
  put SecureString "$name" "$(cat "$path")"
  echo "set     $name (from $key)"
done
