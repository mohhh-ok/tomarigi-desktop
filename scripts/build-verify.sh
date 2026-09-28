#!/bin/sh
# Builds the .app for verification (identifier .verify). BYOK keys live in the Keychain, so to avoid being asked for
# Keychain permission after every rebuild, sign with the local Apple Development certificate (docs/design.md "BYOK API keys").
# Uses APPLE_SIGNING_IDENTITY if set; otherwise uses the first Apple Development certificate in the Keychain
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')
fi
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  echo "build-verify: no Apple Development signing certificate found, building unsigned (Keychain permission will be asked every time)" >&2
else
  export APPLE_SIGNING_IDENTITY
fi
exec tauri build --debug --config src-tauri/tauri.verify.conf.json "$@"
