#!/bin/bash

# Script to generate signing keys for Tauri auto-updater
# This only needs to be run once to generate the keys

echo "Generating Tauri updater signing keys..."

# Check if tauri-cli is installed
if ! command -v cargo-tauri &> /dev/null && ! cargo tauri --version &> /dev/null; then
    echo "Error: tauri-cli is not installed. Please install it first:"
    echo "  cargo install tauri-cli"
    exit 1
fi

# Generate the key pair
cargo tauri signer generate -w updater.key

if [ $? -eq 0 ]; then
    echo ""
    echo "Keys generated successfully!"
    echo ""
    echo "IMPORTANT: Keep these keys secure!"
    echo "1. The private key (updater.key) should be stored securely and used for signing releases"
    echo "2. The public key shown above should be added to your tauri.conf.json"
    echo "3. Add the private key to GitHub Secrets as TAURI_SIGNING_PRIVATE_KEY"
    echo ""
    echo "Files created:"
    echo "  - updater.key (private key - DO NOT COMMIT)"
    echo "  - updater.key.pub (public key)"
else
    echo "Error: Failed to generate keys"
    exit 1
fi