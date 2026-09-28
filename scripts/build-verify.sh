#!/bin/sh
# 検証用の .app(identifier .verify)を作る。BYOK のキーをキーチェーンに置くので、ビルドし直すたびに
# キーチェーンの許可を聞かれないよう、手元の Apple Development 証明書で署名する(docs/design.md「BYOK の API キー…」)。
# APPLE_SIGNING_IDENTITY が指定されていればそれを使い、無ければキーチェーンの最初の Apple Development 証明書を使う
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  APPLE_SIGNING_IDENTITY=$(security find-identity -v -p codesigning | awk '/Apple Development/ {print $2; exit}')
fi
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
  echo "build-verify: Apple Development の署名証明書が見つからないので署名せずに作る(キーチェーンの許可を毎回聞かれる)" >&2
else
  export APPLE_SIGNING_IDENTITY
fi
exec tauri build --debug --config src-tauri/tauri.verify.conf.json "$@"
