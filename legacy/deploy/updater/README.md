# Tauri Auto-Updater Deployment

This directory contains the key generation script for the Tauri auto-updater functionality.

## Setup Instructions

### 1. Generate Signing Keys (One-time setup)

Run the following command to generate signing keys:

```bash
cd deploy/updater
./generate-keys.sh
```

This will generate:
- `updater.key` - Private key (keep secure, do not commit)
- `updater.key.pub` - Public key

### 2. Configure GitHub Secrets

Add the following secrets to your GitHub repository:

1. `TAURI_SIGNING_PRIVATE_KEY` - Contents of `updater.key`
2. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - Password for the private key (if you set one)

### 3. Update Configuration

The public key has already been added to `desktop/tauri.conf.json`

### 4. GitHub Actions Workflow

The GitHub Actions workflow has been updated to:
- Sign releases automatically
- Generate and publish `latest.json` to the `updater` branch

## Signing Process

All signing is handled automatically by GitHub Actions during the release process. The workflow uses `cargo tauri signer sign` directly with the private key from GitHub Secrets.
