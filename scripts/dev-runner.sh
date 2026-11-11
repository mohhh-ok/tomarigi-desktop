#!/bin/sh
# cargo runner on macOS (src-tauri/.cargo/config.toml). Before `tauri dev` runs target/debug/tomarigi-desktop, signs it
# with the local Apple Development certificate and the dev identifier, so its designated requirement is the identifier
# and the certificate instead of the cdhash and the Keychain doesn't ask for permission after every rebuild
# (docs/design.md "BYOK API keys"). Other executables cargo runs through this (test binaries in target/debug/deps)
# are run as they are. Without a certificate, or if signing fails, warns and runs the binary unsigned
exe="$1"
case "$exe" in
  */debug/tomarigi-desktop)
    identity=$(sh "$(dirname "$0")/signing-identity.sh")
    if [ -z "$identity" ]; then
      echo "dev-runner: no Apple Development signing certificate found, running unsigned (the Keychain will ask for permission after every rebuild)" >&2
    elif ! out=$(codesign --force --timestamp=none -s "$identity" --identifier net.mohtech.tomarigi-desktop.dev "$exe" 2>&1); then
      echo "dev-runner: signing failed, running unsigned: $(printf '%s' "$out" | tr '\n' ' ')" >&2
      # arm64 doesn't run a binary without a signature: put back the ad hoc one in case signing left none
      codesign --force -s - "$exe" >/dev/null 2>&1
    fi
    ;;
esac
exec "$@"
