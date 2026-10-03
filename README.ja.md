# Tomarigi

AI コーディングエージェント（Claude Code / Codex）のセッションを、常に手前に出る窓の中の鳥として見守る macOS アプリです。セッションごとに 1 羽の鳥が「にわ」にいて、どれが作業中で、どれがあなたの返事を待っていて、どれが終わったかがひと目で分かります。鳥を押すと、そのセッションが動いている Ghostty のペインへ飛びます。

- 浮遊窓の「にわ」では、鳥と吹き出しと「tomarigi」のハンドルだけが見え、それ以外の場所のクリックは下の窓に届きます。ハンドルを押すと窓全体が出て、ドラッグすると窓が動きます
- アイコンセット: 鳥・小人・ネコ・ロボット・カエルから、プロジェクトごとに選べます
- エージェント側のフックや設定の変更は要りません。`~/.claude/projects` と `~/.codex/sessions` の会話記録を読むだけです
- API キーは任意（BYOK）です。OpenAI か Anthropic のキーで、終わったターンを要約する吹き出しが出ます。TypeSafe のキーで、文章で聞かれた質問（「?」）と AI への暴言（怒りマーク）を見分けます。読み上げは macOS の音声合成を使うので、キーは要りません
- 動作環境: macOS。ペインへ飛ぶ機能は Ghostty だけで動きます

| | |
|---|---|
| <img src="docs/images/gallery-1-on-top.webp" alt="画面のどこでも最前面に出て、下が透けて見える" /> | <img src="docs/images/gallery-2-garden.webp" alt="Claude Code や Codex のセッションごとに 1 羽の鳥" /> |
| <img src="docs/images/gallery-3-needs-reply.webp" alt="エージェントが返事を待っていると「?」が出る" /> | <img src="docs/images/gallery-4-bubble.webp" alt="ターンが終わると吹き出しが要約する" /> |

ビルドなど開発の手順は [README.md](README.md)（英語）にあります。

## ライセンス

MIT（LICENSE を参照）。キャラクター画像（`src/assets/`）は OpenAI の gpt-image で生成したもので、同じ MIT ライセンスで配布しています。
