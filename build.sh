#!/bin/bash
# Build HexNote.
# Usage: ./build.sh
#
# Without credentials this builds the bring-your-own-key app (Team mode
# only): users paste their own Google Cloud OAuth client on first launch.
#
# To also offer Solo mode ("Sign in with Google" using HexNote's own
# verified OAuth client with the drive.file scope), put the client in a
# .env file (never committed) or the environment:
#   HEXNOTE_CLIENT_ID=....apps.googleusercontent.com
#   HEXNOTE_CLIENT_SECRET=...
# They are injected into the binary at compile time, never in source code.

set -e

# Load credentials from .env
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# -s strips symbol table, -w strips DWARF debug info
LDFLAGS="-s -w"

if [ -n "$HEXNOTE_CLIENT_ID" ] && [ -n "$HEXNOTE_CLIENT_SECRET" ]; then
    LDFLAGS="$LDFLAGS -X 'hexnote/internal/drive.bundledClientID=${HEXNOTE_CLIENT_ID}' -X 'hexnote/internal/drive.bundledClientSecret=${HEXNOTE_CLIENT_SECRET}'"
    echo "Building HexNote with the bundled OAuth client (Solo + Team mode)..."
elif [ -n "$HEXNOTE_CLIENT_ID" ] || [ -n "$HEXNOTE_CLIENT_SECRET" ]; then
    echo "ERROR: set both HEXNOTE_CLIENT_ID and HEXNOTE_CLIENT_SECRET, or neither."
    exit 1
else
    echo "Building HexNote without a bundled OAuth client (Team mode only)..."
fi

wails build -ldflags "$LDFLAGS"
echo "Done: build/bin/hexnote.exe"
