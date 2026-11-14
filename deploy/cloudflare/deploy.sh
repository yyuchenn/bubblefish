#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)
branch=${1:-preview}
if [[ ! "$branch" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo 'Deployment branch must contain only letters, digits, dots, underscores or hyphens.' >&2
  exit 1
fi

cd -- "$repo_dir"
npm run build:web
cp deploy/cloudflare/_headers dist/web/_headers
npx wrangler pages deploy dist/web --project-name=bubblefish --branch="$branch"
