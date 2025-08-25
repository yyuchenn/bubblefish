#!/bin/bash
set -e

# Build
cd ../..
python build.py web-build

# Copy headers
cp deploy/cloudflare/_headers frontend/build/

# Deploy
wrangler pages deploy frontend/build \
  --project-name=bubblefish \
  --branch=${1:-preview}