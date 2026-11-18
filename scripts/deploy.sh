#!/usr/bin/env bash
# Production deploy: build the CLI, apply pending D1 migrations, then deploy the Worker,
# uploading secrets from .secrets.production when that file exists (otherwise existing secrets are kept).
# Extra arguments are passed to `cf deploy` (e.g. --dry-run, --message "...").
set -euo pipefail
cd "$(dirname "$0")/.."

DB_ID="202514c9-ef9c-4055-a818-9147862d5554"
SECRETS_FILE=".secrets.production"

echo "→ Building CLI"
pnpm run build:cli

migrate_args=()
for arg in "$@"; do [[ "$arg" == "--dry-run" ]] && migrate_args+=(--dry-run); done

echo "→ Applying D1 migrations"
pnpm exec cf d1 migrations apply "$DB_ID" ${migrate_args[@]+"${migrate_args[@]}"}

deploy_args=("$@")
if [[ -f "$SECRETS_FILE" ]]; then
	echo "→ Deploying with secrets from $SECRETS_FILE"
	deploy_args+=(--secrets-file "$SECRETS_FILE")
else
	echo "→ Deploying ($SECRETS_FILE not found; existing secrets are kept)"
fi
pnpm exec cf deploy "${deploy_args[@]}"
