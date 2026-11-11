#!/bin/sh
# Prints the code signing identity for local builds (verify by scripts/build-verify.sh, dev by scripts/dev-runner.sh):
# APPLE_SIGNING_IDENTITY if set, otherwise the first Apple Development certificate in the Keychain. Prints nothing
# when there is none (docs/design.md "BYOK API keys")
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
  printf '%s\n' "$APPLE_SIGNING_IDENTITY"
  exit 0
fi
security find-identity -v -p codesigning 2>/dev/null | awk '/Apple Development/ {print $2; exit}'
