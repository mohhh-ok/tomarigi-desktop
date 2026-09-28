// 鳥のセリフの吹き出し(docs/design.md「鳥に直近のメッセージを短く要約したセリフを吹き出しで出す」)。
// にわ(アイコンの下)と止まり木(行の中の 1 行)の両方でこの 1 部品を使う。
import type { CSSProperties } from "react";
import { t } from "@/lib/i18n";
import type { SessionView } from "@/lib/sessions";

/**
 * 吹き出しに出す文。作業中(working)は出さない。
 * - 返事待ち(質問ツール): ツールの入力にある質問文。ExitPlanMode は質問文を持たないので固定の文
 * - 止まったターン(done / dozing): BYOK で要約したセリフ。返事待ちなら何を聞いているか。要約用のキーが無く、
 *   Jev が返事待ちと判定したときは、最後の応答文の最後の 1 文(replyTail。AI を使わない)
 */
export function bubbleText(s: SessionView): string | undefined {
  if (s.state === "waiting") {
    return s.question ?? (s.toolName === "ExitPlanMode" ? t("bubblePlanApproval") : undefined);
  }
  if (s.state === "done" || s.state === "dozing") return s.summary ?? s.replyTail;
  return undefined;
}

/** placement: below はにわのアイコンの下、row は止まり木・最近の動きの行の中 */
export function SpeechBubble({
  text,
  placement,
  style,
}: {
  text: string;
  placement: "below" | "row";
  // にわの端で枠の内側へ寄せるときの位置(garden.tsx の bubbleShift)
  style?: CSSProperties;
}) {
  // 長い文は CSS で「…」に切る。マウスを載せると全文(title)
  if (placement === "below") {
    // にわ: 「…」で切る本体(overflow: hidden)の外に、しっぽと位置を持つ外枠を置く(perch.css の .speech-bubble-below)
    return (
      <span className="speech-bubble-below" title={text} style={style}>
        <span className="speech-bubble">{text}</span>
      </span>
    );
  }
  // 止まり木の行では 2 段目を丸ごと取る外枠に入れ、吹き出し自体は文の長さに合わせる
  return (
    <span className="speech-bubble-line">
      <span className="speech-bubble speech-bubble-row" title={text} style={style}>
        {text}
      </span>
    </span>
  );
}
