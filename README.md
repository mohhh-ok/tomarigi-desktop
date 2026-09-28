# tomarigi-desktop

AI コーディングエージェント(Claude Code / Codex)のセッションを、常に最前面に浮かぶ窓の鳥で見守る macOS アプリ。セッションごとに 1 羽の鳥が「にわ」にいて、作業中・返事待ち・完了が鳥の様子で分かる。鳥をクリックすると、その Claude Code が動いている Ghostty のペインへ移る。

- エージェント側に hook や設定を入れない。`~/.claude/projects`・`~/.codex/sessions` の transcript を読むだけで動く
- 返事待ちの「?」、ターンの終わりの要約の吹き出し、読み上げは任意の BYOK(OpenAI / Anthropic / TypeSafe)で使える。キーは macOS のキーチェーンに保存する
- 動作環境: macOS。ペインへの移動は Ghostty だけ対応

設計の正は docs/design.md。


## build

```sh
bun install   # prepare で core.hooksPath を .githooks に設定し、gitleaks の pre-commit を有効にする
bun run dev                   # 開発版のアプリを起動(tauri dev。vite の dev サーバー bun run dev:web も一緒に立つ)
bun run build:verify          # 検証用の .app(src-tauri/target/debug/bundle/macos/tomarigi-desktop (verify).app)。背景が緑がかった色になる。手元の Apple Development 証明書で署名する(scripts/build-verify.sh。APPLE_SIGNING_IDENTITY で上書き)
bun run tauri build --debug   # src-tauri/target/debug/bundle/macos/tomarigi-desktop.app
bun run tauri build           # release。できた .app を /Applications/tomarigi-desktop.app に置いて使う
bun run gen:locales           # scripts/locales/*.mjs → public/_locales/*/messages.json(bun run build でも走る)
bun run verify:locales        # 43ロケール × 全キー完全一致チェック
```

普段使い(/Applications)・`bun run dev`・`bun run build:verify` は identifier を分けている(`src-tauri/tauri.dev.conf.json`・`tauri.verify.conf.json` を `--config` で重ねる)。多重起動防止・設定・窓の位置はそれぞれ別で、同時に起動できる。Ghostty 操作の許可ダイアログはそれぞれ初回に出る。エージェントが検証で起動するのは verify の .app だけにする(普段使いの版や dev を止めない)。

i18n の `public/_locales` は生成物。直接編集せず scripts/locales/*.mjs に 43 ロケール分を書いて生成する。

dev サーバーのポートは 4842(HMR 4843)に固定している(`vite.config.ts`・`src-tauri/tauri.conf.json`)。

起動時の環境変数(バイナリ `Contents/MacOS/tomarigi-desktop` を直接起動するときに渡す):

- `TOMARIGI_MOCK=1`: mock モード(tomarigi の `?mock=1`)。実データの代わりにプリセット/JSON を注入する
- `TOMARIGI_QUERY`: 起動時の画面。`tab=perch` / `tab=events` / `settings=1` / `debug=1` / `preset=<id>`(mock の初期プリセット。`preset=asking` で返事待ちの「?」)/ `scrollTo=<クラス名>`(その要素まで窓をスクロール。例 `settings=1&scrollTo=window-mode`)を `&` でつなぐ
- `TOMARIGI_FOCUS_TEST="<config_dir>|<sessionId>|<戻り先 tty>"`: 起動 3 秒後にそのセッションの Ghostty ペインへ移り、1.5 秒後に戻り先へ移り直す(ログに `front=<tty>`)
- `TOMARIGI_MODE_TEST`: ウィンドウモードの自己テスト。`1` で 通常→浮遊→通常→最大化→フルスクリーン→浮遊 を 5 秒おきに切り替え、`normal` で通常の窓に切り替えるだけ

- `TOMARIGI_IMPORT_KEY=<anthropic|openai|typesafe>`: 標準入力の 1 行目をその提供元の API キーとして保存する(設定画面を手で操作できないときの確かめ用。ログには長さだけ出す)
- `TOMARIGI_KEY_BACKEND=webview`: キーの保存先を IndexedDB にする(普段使い・verify のキーチェーンを使わない。IndexedDB からキーチェーンへの移行を確かめるとき用)

BYOK の API キーの保存先は identifier で決まる(src-tauri/src/lib.rs の KeyStore)。普段使い・verify は macOS のキーチェーン(項目は `<identifier>.byok`)、dev は IndexedDB。キーを使う API 呼び出しは Rust から出す。

ログは `/tmp/tomarigi-desktop/app-log.txt` に追記する。

Rust 側の tauri 系 crate は npm 側 `@tauri-apps/api` 2.11 に合わせて 2.11 系に固定している(`tauri build` はメジャー/マイナー不一致で止まる)。

## ライセンス

MIT(LICENSE)。鳥などのキャラクター画像(`src/assets/`)は OpenAI の gpt-image で生成したもので、同じ MIT で配布する。
