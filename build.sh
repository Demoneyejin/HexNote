#!/bin/bash
# Build HexNote with OAuth credentials injected from .env
# Usage: ./build.sh
# Credentials are injected into the binary at compile time — never in source code.

set -e

# Load credentials from .env
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

if [ -z "$HEXNOTE_CLIENT_ID" ] || [ -z "$HEXNOTE_CLIENT_SECRET" ]; then
    echo "ERROR: HEXNOTE_CLIENT_ID and HEXNOTE_CLIENT_SECRET must be set."
    echo "Create a .env file with these values or export them as environment variables."
    exit 1
fi

# -s strips symbol table, -w strips DWARF debug info — makes casual string extraction harder
LDFLAGS="-s -w -X 'hexnote/internal/drive.bundledClientID=${HEXNOTE_CLIENT_ID}' -X 'hexnote/internal/drive.bundledClientSecret=${HEXNOTE_CLIENT_SECRET}'"

echo "Building HexNote with bundled credentials..."
wails build -ldflags "$LDFLAGS"
echo "Done: build/bin/hexnote.exe"
