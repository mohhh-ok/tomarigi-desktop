import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdClose } from "react-icons/md";
import { loadPersistedEvents, type SessionEvent } from "@/lib/sessions";

type SaveStatus = "idle" | "saved";

// 保存フィードバック表示を自動的に idle へ戻すまでの時間
const SAVE_FEEDBACK_MS = 2000;

// App.tsx の POLL_MS(スキャンループ間隔)と同じ値。イベントログのポーリング再読込にも
// 同じ間隔を使う(App.tsx から export を増やさず、ここにローカル定数として複製する)
const DEBUG_POLL_MS = 3_000;

// lib/sessions.ts がひな(サブエージェント)由来イベントの project に付ける区切り
// (`${project} · ${chick.view.name}` 形式)。sessions.ts 側に定数が無いため、生成側の
// フォーマットとここで手動で合わせている(sessions.ts は別作業中のため触らない)
const CHICK_PROJECT_SEPARATOR = " · ";

// ひな由来の project 値("親 · ひな名")を親プロジェクト名だけに正規化する。
// 区切りが無ければそのまま返す(親プロジェクト自身のイベント)
function parentProject(project: string): string {
  const idx = project.indexOf(CHICK_PROJECT_SEPARATOR);
  return idx === -1 ? project : project.slice(0, idx);
}

// ファイル名に使えない文字(スペース・/・() 等)を "-" に潰す。
// 連続した不可視/記号は1つの "-" にまとめ、前後の "-" は削る(例: "base (root)" → "base-root")。
// サニタイズ後の衝突は許容する(要件)。
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

// App.tsx のヘッダーからページ内ダイアログとして開く(?debug=1 直開き時は showDebug の
// 初期値が true になるだけで、以降は URL を一切いじらない)。lib/sessions.ts が永続化する
// イベント判定の発火履歴(lib/fsa.ts の eventLog)をそのまま一覧表示する。実データ・root 設定・
// BYOK 等は一切触らない。デバッグ画面なので i18n はせず日本語ハードコードで良い
// (public/_locales は生成物のため触らない)。
//
// 開閉自体(showDebug state)は App のスキャンループには一切影響しない。
export default function DebugApp({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<SessionEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // プロジェクト名ごとの保存結果(ボタンの一時フィードバック用)
  const [saveStatus, setSaveStatus] = useState<Record<string, SaveStatus>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Escape リスナーを張る document を実体から取るための ref(下の keydown effect 参照)
  const overlayRef = useRef<HTMLDivElement>(null);

  // 開いている間 DEBUG_POLL_MS ごとに再読込して一覧を自動更新する。key(SessionEvent.key)は
  // sessionId/at/type 由来で安定しているため、setState での置き換えは React が差分適用し、
  // 既存行の DOM は保たれる(スクロール位置が飛ばない)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await loadPersistedEvents();
        if (cancelled) return;
        setEvents(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        console.warn("[tomarigi] イベントログの読み込みに失敗", e);
        setError("イベントログの読み込みに失敗しました");
      }
    };
    void load();
    const interval = setInterval(() => void load(), DEBUG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const timer of Object.values(saveTimers.current)) clearTimeout(timer);
    };
  }, []);

  // Escape で閉じる(ダイアログ的な UI のため)
  useEffect(() => {
    const doc = overlayRef.current?.ownerDocument ?? document;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 新しい順(末尾が最新で永続化されているため、表示用に反転する)
  const sorted = events ? [...events].sort((a, b) => b.at - a.at) : [];

  // 重複を除いた親プロジェクト名一覧(ひな由来の project は親名に正規化してグルーピングする。
  // sorted が新しい順のため、直近にイベントがあった順になる)
  const projects = Array.from(new Set(sorted.map((e) => parentProject(e.project))));

  // 指定した親プロジェクトのイベント(ひな由来イベントも含む)を新しい順で JSON ダウンロード
  // (~/Downloads/tomarigi-eventlog-<project>.json に落ちる。既存の同名ファイルがあるときは
  // Chrome と同じく " (1)" 等を付けるため、読み手は該当パターンの mtime 最新を読む。
  // クリップボードは揮発性・占有の問題があったため使わない)
  const saveProject = async (project: string) => {
    const targetEvents = sorted.filter((e) => parentProject(e.project) === project);
    // WKWebView には <a download> のダウンロードが無いので、Rust 側で ~/Downloads に書く
    // (tomarigi で Chrome がダウンロードしていた場所と同じ)
    try {
      await invoke("save_download", {
        name: `tomarigi-eventlog-${sanitizeFilename(project)}.json`,
        content: JSON.stringify(targetEvents, null, 2),
      });
    } catch (e) {
      console.warn("[tomarigi] イベントログの保存に失敗", e);
      return;
    }
    setSaveStatus((prev) => ({ ...prev, [project]: "saved" }));
    clearTimeout(saveTimers.current[project]);
    saveTimers.current[project] = setTimeout(() => {
      setSaveStatus((prev) => ({ ...prev, [project]: "idle" }));
    }, SAVE_FEEDBACK_MS);
  };

  return (
    // fixed + z-index で App の上に全画面重ねる。App 側の DOM ツリーはそのまま裏に
    // 残り続けるので、ここでのマウント/アンマウントは App(スキャンループ)に影響しない
    <div className="debug-overlay" ref={overlayRef}>
      <div className="page debug-page">
        <div className="page-header">
          <h1 className="brand">tomarigi イベントログ(debug)</h1>
          <button className="small" onClick={onClose} aria-label="Close" title="Close">
            <MdClose size={16} />
          </button>
        </div>
        <p className="note">
          lib/sessions.ts が発火したイベント判定の永続履歴です(最大500件、TTLなし)。
        </p>
        {error && <p className="note debug-log-error">{error}</p>}
        {!error && events === null && <p className="note">読み込み中…</p>}
        {!error && events !== null && sorted.length === 0 && (
          <p className="empty">まだイベントは記録されていません</p>
        )}
        {!error && projects.length > 0 && (
          <div className="debug-save-list">
            {projects.map((project) => {
              const status = saveStatus[project] ?? "idle";
              return (
                <button
                  key={project}
                  type="button"
                  className="debug-save-btn"
                  onClick={() => void saveProject(project)}
                >
                  {status === "saved" ? "保存しました" : `${project} を保存`}
                </button>
              );
            })}
          </div>
        )}
        {!error && sorted.length > 0 && (
          <ul className="debug-log-list">
            {sorted.map((e) => (
              <li key={e.key} className="debug-log-row">
                <span className="debug-log-time">
                  {new Date(e.at).toLocaleString()}
                  {/* firedAt: 抑止明け timeout 発火の実発火時刻。at は key 基準(親のターン終了時刻)の
                      まま不変なので、実際に鳴った(鳴らなかった)時刻はここで別に見せる */}
                  {e.firedAt !== undefined && (
                    <span className="debug-log-fired-at">
                      (実発火 {new Date(e.firedAt).toLocaleString()})
                    </span>
                  )}
                </span>
                <span className={`debug-log-type debug-log-type-${e.type}`}>{e.type}</span>
                {/* muted: ひな待ちで抑止されていた done が親の再起動でキャンセルされたもの。
                    ログには残るが鳴らない(lib/sessions.ts の deriveDoneEvent 参照) */}
                {e.muted && <span className="debug-log-muted-badge">ミュート</span>}
                {/* Jev の判断待ち判定(lib/jev.ts)。確率は yes(返事待ち)の確率 */}
                {e.ask && (
                  <span className="debug-log-ask">
                    jev {e.ask.status}
                    {e.ask.probability !== undefined && ` ${e.ask.probability.toFixed(2)}`}
                    {e.ask.errorKind && ` (${e.ask.errorKind})`}
                  </span>
                )}
                <span className="debug-log-project">{e.project}</span>
                {e.snippet && <span className="debug-log-snippet">「{e.snippet}」</span>}
                <span className="debug-log-key">{e.key}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
