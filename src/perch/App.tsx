import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  MdBugReport,
  MdCheckCircle,
  MdClose,
  MdContentCopy,
  MdHelp,
  MdSettings,
  MdVolumeUp,
} from "react-icons/md";
import { t, uiLanguage } from "@/lib/i18n";
import { summarizeTurnLine } from "@/lib/summarize";
import { lastSentence } from "@/lib/last-sentence";
import { chirpDone, chirpWaiting, primeAudio, setChirpVolume } from "@/lib/chirp";
import {
  deleteAiProvider,
  deleteApiKey,
  initApiKeys,
  loadActiveAiProvider,
  loadAiProvider,
  loadApiKeyStatus,
  loadChirpVolume,
  loadMuted,
  loadRoots,
  loadVoiceEnabled,
  loadVoiceVolume,
  pickNewRoot,
  queryRead,
  resolveAiProvider,
  saveAiProvider,
  saveApiKey,
  saveChirpVolume,
  saveMuted,
  saveRoots,
  saveVoiceEnabled,
  saveVoiceVolume,
  type RootEntry,
  type RootKind,
  type AiProvider,
  type ApiKeyProvider,
} from "@/lib/fsa";
import {
  loadIconSetAssignments,
  saveIconSetAssignments,
  type IconSetAssignments,
  type IconSetId,
} from "@/lib/icon-set-store";
import { focusSession, focusTargetOf } from "@/lib/ghostty";
import { testJudgeConnection, type JudgeErrorKind } from "@/lib/judge";
import { testOpenAiConnection } from "@/lib/openai-judge";
import { judgeAsking, testTypeSafeConnection, type AskJudgement } from "@/lib/jev";
import { recordAskJudgement, type SessionEvent, type SessionView } from "@/lib/sessions";
import { cancelSpeech, setVoiceVolume, speakDoneEvent, speakEvent } from "@/lib/voice";
import DebugApp from "./DebugApp";
import { Garden } from "./garden";
import { bubbleText } from "./bubble";
import {
  DEFAULT_ICON_SET,
  ICON_SET_IDS,
  ICON_SET_LABEL,
  ICON_SETS,
  resolveIconSet,
} from "./icon-sets";
import { type PerchSource } from "./source";
import { EVENT, EventFeed, Perch } from "./stage";
import { currentWindowMode, useWindowMode } from "./window-mode";

const POLL_MS = 3_000;

// 鳴き声は ScanResult.events から発火する(issue #6)。イベント種別ごとにどの鳴き声を
// 対応させるか(started/closed は鳴かない)
const EVENT_CHIRP: Partial<Record<SessionEvent["type"], () => void>> = {
  done: chirpDone,
  waiting: chirpWaiting,
};

// イベントの at からこれ以内なら「新しい」とみなして鳴らす。起動直後のスキャンで、過去に発生済みのイベントを再構成しても
// 鳴らさないための鮮度ガード(下の tick 内コメント参照)
const EVENT_FRESHNESS_MS = 30_000;

type Phase = "loading" | "ready";

// 見る面(止まり木・イベント・にわ)をタブで切り替える。永続化不要のため useState のみ。
// 設定は別階層(⚙ ボタン → 設定ビュー)なので Tab には含めない
type Tab = "perch" | "events" | "garden";

// 窓の背景を掴んだら窓ごと動かす(tomarigi の PiP は上部バーでしか動かせなかった)。
// 押して操作する要素・文字入力・鳥(にわのドラッグ)・スクロールする一覧は除く
const NO_WINDOW_DRAG =
  "button, input, select, textarea, a, label, kbd, code, .garden-node, .garden-nest, .bird, .chick, .event-card, .debug-overlay, .mock-panel, .root-add-overlay";

interface Editing {
  id: string;
  draft: string;
}

// IconSetSettings に出す1行(issue #14)。running=false は「今は走っていないが割り当てが
// 保存されている」行(淡色表示。IconSetSettings 参照)
interface IconSetRow {
  slug: string;
  label: string;
  running: boolean;
}

// 接続テストボタンの表示状態。reason は byokTestResultFailure の $REASON$ に
// そのまま埋め込む技術的な識別子(kind)で、ローカライズはしない(HTTP ステータス相当の扱い)。
// キーは判定専用ではないため型名も Judge に限定しない(JudgeErrorKind 自体は
// lib/judge.ts が持つ既存の名前をそのまま流用しているだけ)
/** Jev 判定のターンの識別。done イベントの key と同じ基準(sessionId + 最終応答の時刻) */
function turnKey(sessionId: string, at: number): string {
  return `${sessionId}:${at}`;
}

// TypeSafe の公式サイト(設定の説明文からのリンク先)
const TYPESAFE_SITE_URL = "https://typesafe.ai";

type ApiKeyTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success" }
  | { phase: "failure"; reason: JudgeErrorKind }
  | { phase: "no-key" };

export default function App({
  source,
  extraPanel,
}: {
  source: PerchSource;
  extraPanel?: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [roots, setRoots] = useState<RootEntry[]>([]);
  const [perms, setPerms] = useState<Record<string, PermissionState>>({});
  const [brokenIds, setBrokenIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  // にわが一番見ていて楽しい = 製品の顔なのでデフォルトタブにする
  // ?tab=perch|events / ?settings=1 は起動時の画面の指定(スクショ確認用。README の TOMARIGI_QUERY)
  const [tab, setTab] = useState<Tab>(() => {
    const q = new URLSearchParams(location.search).get("tab");
    return q === "perch" || q === "events" ? q : "garden";
  });
  const [settingsOpen, setSettingsOpen] = useState(
    () => new URLSearchParams(location.search).has("settings"),
  );
  // ?scrollTo=<クラス名> は起動時にその要素まで窓をスクロールする(スクショ確認用。README の TOMARIGI_QUERY)。
  // 浮遊窓の高さでは設定の下の方が見えないため
  useEffect(() => {
    const target = new URLSearchParams(location.search).get("scrollTo");
    if (phase !== "ready" || !target || !/^[\w-]+$/.test(target)) return;
    document.querySelector(`.${target}`)?.scrollIntoView({ block: "center" });
  }, [phase]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [chirpVolume, setChirpVolumeState] = useState(1);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceVolume, setVoiceVolumeState] = useState(1);
  const [windowMode, setWindowMode] = useWindowMode();
  // API キーは done 読み上げ要約(speakDoneEvent)と接続テストの共用設定なので judge に限定しない名前
  const [aiKeySet, setAiKeySet] = useState<Record<ApiKeyProvider, boolean>>({
    anthropic: false,
    openai: false,
    typesafe: false,
  });
  const [aiKeyTestState, setAiKeyTestState] = useState<Record<ApiKeyProvider, ApiKeyTestState>>({
    anthropic: { phase: "idle" },
    openai: { phase: "idle" },
    typesafe: { phase: "idle" },
  });
  // Jev の判断待ち判定(lib/jev.ts)。キーはターン(turnKey)。判定を始めたターンは
  // askRequestedRef に入れ、ポーリングのたびに呼び直さない。画面から消えたターンは捨てる
  const [askJudgements, setAskJudgements] = useState<Record<string, AskJudgement>>({});
  const askRequestedRef = useRef(new Set<string>());
  const typeSafeKeySetRef = useRef(false);
  useEffect(() => {
    typeSafeKeySetRef.current = aiKeySet.typesafe;
  }, [aiKeySet.typesafe]);
  const [aiProvider, setAiProvider] = useState<AiProvider | null>(null);
  // アイコンセットのプロジェクト個別割り当て(issue #14)。slug → {set, label} の辞書。
  // Perch/Garden/IconSetSettings は resolveIconSet(lib/icon-set-store.ts)経由でこの辞書を
  // lookup し、割り当てが無ければ DEFAULT_ICON_SET へフォールバックする
  const [iconSetAssignments, setIconSetAssignments] = useState<IconSetAssignments>({});
  // ?debug=1 直開き時はデバッグログを最初から開いた状態にする。以降は URL を一切いじらず
  // このステートだけで開閉するページ内ダイアログとして扱う
  const [showDebug, setShowDebug] = useState(
    () => new URLSearchParams(location.search).has("debug"),
  );
  const [rootDialogOpen, setRootDialogOpen] = useState(false);
  const closeDebug = useCallback(() => setShowDebug(false), []);
  const mutedRef = useRef(muted);
  const voiceEnabledRef = useRef(voiceEnabled);
  const scanBusyRef = useRef(false); // スキャンが POLL_MS を超えたときの多重実行防止(鳴き声の二重発火を防ぐ)
  // issue #6: 鳴き声はすべて ScanResult.events から発火する(旧来の状態エッジ検出は廃止)。
  // 観測済みイベント key の集合。前回までに鳴らした(または鳴らす判定をした)イベントを覚えておき、
  // 同じイベントで二度鳴かないようにする。sessionEventCache 側と同じ「直近だけ保持」の性質に
  // 合わせて、毎スキャンで最新の events に含まれる key だけへ入れ替える(無限に増えない)
  const seenEventKeysRef = useRef<Set<string>>(new Set());
  // 初回スキャンでは一切鳴らさない。起動直後は
  // 過去に発生済みのイベントがそのまま events に載って返ってくるため、それを新規発火と
  // 誤認して一斉に鳴くのを防ぐ
  const firstScanRef = useRef(true);
  const scanSignatureRef = useRef("");

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  useEffect(() => {
    void (async () => {
      // mock ソース(source.usesRoots === false)では roots/perms サブシステムを一切使わない。
      // roots=[]・perms={} のまま(useState の初期値)にして、セットアップ画面・監視フォルダ
      // 設定・権限チェックを丸ごとスキップする
      if (source.usesRoots) {
        const loaded = await loadRoots();
        setRoots(loaded);
        const entries = await Promise.all(
          loaded.map(async (r) => [r.id, await queryRead(r)] as const),
        );
        setPerms(Object.fromEntries(entries));
      }
      setMuted(await loadMuted());
      const cVolume = await loadChirpVolume();
      setChirpVolumeState(cVolume);
      setChirpVolume(cVolume);
      setVoiceEnabled(await loadVoiceEnabled());
      const volume = await loadVoiceVolume();
      setVoiceVolumeState(volume);
      setVoiceVolume(volume);
      // キーは Rust が持つ(docs/design.md「BYOK の API キー…」)。以前の版が IndexedDB に残したキーの移行
      // (キーチェーンの版)・dev の IndexedDB からの受け渡しを済ませてから、保存済みかどうかだけを聞く
      try {
        await initApiKeys();
      } catch (e) {
        console.warn("[tomarigi] API キーの初期化に失敗", e);
      }
      const [keyStatus, preferredProvider] = await Promise.all([loadApiKeyStatus(), loadAiProvider()]);
      // 保存済みかどうか(真偽だけ)をログに出す。キーの値は受け取らない・出さない
      void invoke("log", {
        line: `[keys] status anthropic=${keyStatus.anthropic} openai=${keyStatus.openai} typesafe=${keyStatus.typesafe}`,
      });
      const resolvedProvider = resolveAiProvider(preferredProvider, keyStatus.anthropic, keyStatus.openai);
      setAiKeySet(keyStatus);
      setAiProvider(resolvedProvider ?? null);
      // 旧データや使用中キー削除後の不整合は、利用可能な側へ一度だけ正規化する。
      if (resolvedProvider && resolvedProvider !== preferredProvider) {
        await saveAiProvider(resolvedProvider);
      }
      setIconSetAssignments(await loadIconSetAssignments());
      setPhase("ready");
    })();
  }, []);

  // AudioContext の解錠。WKWebView は操作なしでも running になる(docs/design.md「前提になった実測」)が、
  // 念のため起動時と最初のポインタ操作の両方で呼ぶ
  useEffect(() => {
    primeAudio();
    const unlock = () => primeAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    return () => document.removeEventListener("pointerdown", unlock);
  }, []);

  // 窓の背景を掴んで窓を動かす(NO_WINDOW_DRAG 参照)。左ボタンだけ
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest(NO_WINDOW_DRAG)) return;
      // 通常の窓はタイトルバーで動かす(最大化・フルスクリーン中に背景を掴んで窓が外れないように)
      if (currentWindowMode() === "normal") return;
      void getCurrentWindow().startDragging();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);

  // 止まったターンの最後の応答を、BYOK(OpenAI / Anthropic)で吹き出しのセリフに 1 回だけ要約する
  // (docs/design.md「鳥に直近のメッセージを短く要約したセリフを吹き出しで出す」)。キーが無ければ出さない。
  // 結果は turnLines に入り、描画時に SessionView.summary として付く。working になれば reply が無くなり消える
  const [turnLines, setTurnLines] = useState<Record<string, string>>({});
  const turnLineRequestedRef = useRef(new Set<string>());
  const summaryKeySetRef = useRef(false);
  useEffect(() => {
    summaryKeySetRef.current = aiKeySet.anthropic || aiKeySet.openai;
  }, [aiKeySet.anthropic, aiKeySet.openai]);
  const requestTurnLines = useCallback((views: SessionView[]) => {
    const live = new Set<string>();
    for (const view of views) {
      // summary を最初から持つ view(mock)は要約しない
      if (!view.reply || view.summary) continue;
      const key = turnKey(view.id, view.reply.at);
      live.add(key);
      if (!summaryKeySetRef.current || turnLineRequestedRef.current.has(key)) continue;
      turnLineRequestedRef.current.add(key);
      const { project, reply } = view;
      void (async () => {
        const provider = await loadActiveAiProvider();
        if (!provider) return;
        const result = await summarizeTurnLine(provider, {
          ui_language: uiLanguage(),
          assistant_text: reply.text,
        });
        const line = result.ok && typeof result.verdict.line === "string" ? result.verdict.line.trim() : "";
        void invoke("log", {
          line: `[bubble] ${result.ok ? `ok len=${line.length}` : `error=${result.kind}`} ${project}`,
        });
        if (!line) return;
        setTurnLines((current) =>
          turnLineRequestedRef.current.has(key) ? { ...current, [key]: line } : current,
        );
      })();
    }
    for (const key of turnLineRequestedRef.current) {
      if (!live.has(key)) turnLineRequestedRef.current.delete(key);
    }
    setTurnLines((current) => {
      const stale = Object.keys(current).filter((key) => !live.has(key));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const key of stale) delete next[key];
      return next;
    });
  }, []);

  // 止まったターン(reply のある done / dozing)を1回だけ Jev に聞く。done の鳴き声・読み上げは
  // これを待たない。結果は askJudgements に入り、描画時に SessionView.ask として付く
  const requestAskJudgements = useCallback((views: SessionView[]) => {
    const live = new Set<string>();
    for (const view of views) {
      // ask を最初から持つ view(mock)は Jev に聞かない
      if (!view.reply || view.ask) continue;
      const key = turnKey(view.id, view.reply.at);
      live.add(key);
      if (!typeSafeKeySetRef.current || askRequestedRef.current.has(key)) continue;
      askRequestedRef.current.add(key);
      const { id, project, reply } = view;
      setAskJudgements((current) => ({ ...current, [key]: { status: "pending" } }));
      void (async () => {
        const ask: AskJudgement = await judgeAsking(reply.text);
        setAskJudgements((current) => (key in current ? { ...current, [key]: ask } : current));
        recordAskJudgement(id, reply.at, ask);
        void invoke("log", {
          line: `[jev] ${ask.status} p=${ask.probability?.toFixed(2) ?? "-"}${ask.errorKind ? ` error=${ask.errorKind}` : ""} ${project}`,
        });
      })();
    }
    for (const key of askRequestedRef.current) {
      if (!live.has(key)) askRequestedRef.current.delete(key);
    }
    setAskJudgements((current) => {
      const stale = Object.keys(current).filter((key) => !live.has(key));
      if (stale.length === 0) return current;
      const next = { ...current };
      for (const key of stale) delete next[key];
      return next;
    });
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    const granted = roots.filter((r) => perms[r.id] === "granted");
    // mock ソース(source.usesRoots === false)は roots/perms を使わないため granted は常に
    // 空のままだが、それは「アクセスを失った」状態ではないのでこの早期 return はスキップし
    // そのままスキャンへ進む(mock の scan() は granted を無視して mock データを返す)
    if (source.usesRoots && granted.length === 0) {
      setSessions([]);
      setBrokenIds([]);
      setEvents([]);
      // アクセスを失った状態からの再開は「初回スキャン」として扱う。ここでリセットしないと、
      // 再許可直後に古い key が「未観測」のまま大量に届き、一斉に鳴いてしまう
      seenEventKeysRef.current = new Set();
      firstScanRef.current = true;
      return;
    }
    let alive = true;
    const tick = async () => {
      if (scanBusyRef.current) return;
      scanBusyRef.current = true;
      try {
        const { views, brokenIds: broken, events: nextEvents } = await source.scan(granted);
        if (!alive) return;
        const now = Date.now();
        const seen = seenEventKeysRef.current;
        if (!firstScanRef.current) {
          for (const event of nextEvents) {
            if (seen.has(event.key)) continue;
            // ミュート付き done(ひな待ちの抑止明けが、親の再起動でキャンセルされたもの。
            // lib/sessions.ts の deriveDoneEvent 参照)はログ・フィードには残すが鳴らさない
            if (event.muted) continue;
            // 鮮度ガード: 未観測でも at が古い(スキャンの間隔を超えて前から起きていた)
            // イベントは、再構成であって新規発生ではないとみなして鳴らさない。
            // firedAt があれば(抑止明けの timeout 発火 done)そちらを実発火時刻として使う
            if (now - (event.firedAt ?? event.at) > EVENT_FRESHNESS_MS) continue;
            if (!mutedRef.current) EVENT_CHIRP[event.type]?.();
            void invoke("log", {
              line: `[event] ${event.type} ${event.project} chirp=${!mutedRef.current && Boolean(EVENT_CHIRP[event.type])} voice=${voiceEnabledRef.current}`,
            });
            // 読み上げはミュート(鳴き声)とは独立のオプトイン設定。制約は lib/voice.ts 参照。
            // done だけは要約読み上げ(API キー設定時)の対象。speakDoneEvent 内部でキーの有無・
            // フォールバック込みの分岐をしているため、ここでは type で振り分けるだけでよい
            if (voiceEnabledRef.current) {
              if (event.type === "done") {
                void speakDoneEvent(event, () => voiceEnabledRef.current);
              } else {
                speakEvent(event);
              }
            }
          }
        }
        // 観測済みの入れ替えはミュート中でも行う(ミュート解除後に取りこぼし分が
        // まとめて鳴るのを防ぐ)。sessionEventCache 同様、直近の events だけを覚えれば足りる
        // 鳥の顔ぶれ・状態が変わったときだけ Rust のログ(/tmp/tomarigi-desktop/app-log.txt)へ出す。
        // 画面を見ずに transcript の実態と突き合わせるため
        const signature = views.map((v) => `${v.id}:${v.state}`).join(",");
        if (signature !== scanSignatureRef.current) {
          scanSignatureRef.current = signature;
          const lines = views.map(
            (v) => `  ${v.state.padEnd(7)} ${v.project} ${v.id.split("/").slice(1).join("/")}`,
          );
          void invoke("log", { line: `[scan] ${views.length} sessions\n${lines.join("\n")}` });
        }
        seenEventKeysRef.current = new Set(nextEvents.map((e) => e.key));
        firstScanRef.current = false;
        requestAskJudgements(views);
        requestTurnLines(views);
        setSessions(views);
        setBrokenIds(broken);
        setEvents(nextEvents);
      } catch (e) {
        console.warn("[tomarigi] scan failed", e);
      } finally {
        scanBusyRef.current = false;
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    // mock ソースは POLL_MS を待たずデータ変更を即座に反映したい(MockPanel での編集が
    // 見た目にすぐ効くようにするため)。real は subscribe を持たないため何もしない
    const unsub = source.subscribe?.(() => void tick());
    return () => {
      alive = false;
      clearInterval(timer);
      unsub?.();
    };
  }, [phase, roots, perms, source]);

  /** 失敗しても state と永続化が無言で乖離しないよう、warn + 画面表示に寄せる */
  const persistRoots = useCallback(async (next: RootEntry[]) => {
    try {
      await saveRoots(next);
    } catch (e) {
      console.warn("[tomarigi] 保存に失敗", e);
      setAddMessage(t("saveFailedMessage"));
    }
  }, []);

  const addRoot = useCallback(async (kind: RootKind) => {
    const result = await pickNewRoot(roots, kind);
    if (result === "cancelled") return;
    if (result === "duplicate") {
      setAddMessage(t("duplicateRootMessage"));
      return;
    }
    setAddMessage(null);
    const next = [...roots, result];
    setRoots(next);
    await persistRoots(next);
    const perm = await queryRead(result);
    setPerms((prev) => ({ ...prev, [result.id]: perm }));
  }, [roots, persistRoots]);

  const removeRoot = useCallback(
    async (id: string) => {
      const next = roots.filter((r) => r.id !== id);
      setRoots(next);
      await persistRoots(next);
      setPerms((prev) => {
        const rest = { ...prev };
        delete rest[id];
        return rest;
      });
      setEditing((prev) => (prev?.id === id ? null : prev));
    },
    [roots, persistRoots],
  );

  const startEdit = useCallback((root: RootEntry) => {
    setEditing({ id: root.id, draft: root.label });
  }, []);

  const cancelEdit = useCallback(() => setEditing(null), []);

  const commitEdit = useCallback(async () => {
    if (!editing) return;
    const { id, draft } = editing;
    setEditing(null);
    const trimmed = draft.trim();
    if (!trimmed) return; // 空なら元の値のまま
    const next = roots.map((r) => (r.id === id ? { ...r, label: trimmed } : r));
    setRoots(next);
    await persistRoots(next);
  }, [editing, roots, persistRoots]);

  const toggleMuted = useCallback(() => {
    const next = !muted;
    setMuted(next);
    void saveMuted(next);
  }, [muted]);

  const toggleVoiceEnabled = useCallback(() => {
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    void saveVoiceEnabled(next);
    // OFF は「静かにしたい」操作なので、再生中・キュー済みの発話も即座に止める
    if (!next) cancelSpeech();
  }, [voiceEnabled]);

  // スライダー(入力値は 0〜100 表示、内部値は 0〜1)。lib/voice.ts のモジュール変数は
  // 発話「時点」の最新値を読みに行く方式なので、ここでは state 更新と同時に即
  // setVoiceVolume で反映すればよい(次に鳴る発話から音量が変わる)
  const changeVoiceVolume = useCallback((next: number) => {
    setVoiceVolumeState(next);
    setVoiceVolume(next);
    void saveVoiceVolume(next);
  }, []);

  // 鳴き声(chirp)側の音量。lib/chirp.ts の masterGain と同じくモジュール変数方式なので、
  // 変更は即 setChirpVolume で反映する(試聴ボタンも同じ経路を通るため、スライダーを
  // 動かした直後の試聴に即座に反映される)
  const changeChirpVolume = useCallback((next: number) => {
    setChirpVolumeState(next);
    setChirpVolume(next);
    void saveChirpVolume(next);
  }, []);

  /** 保存後は draft をどこにも保持しない(state 上に平文キーを残さない) */
  // 保存できたら true。失敗(キーチェーンに書けない等)は false を返し、設定画面の行に失敗を出させる
  const saveAiKey = useCallback(async (provider: ApiKeyProvider, draft: string): Promise<boolean> => {
    const trimmed = draft.trim();
    if (!trimmed) return false;
    try {
      await saveApiKey(provider, trimmed);
    } catch (e) {
      void invoke("log", { line: `[keys] save failed ${provider}: ${String(e).slice(0, 120)}` }).catch(() => {});
      return false;
    }
    setAiKeySet((current) => ({ ...current, [provider]: true }));
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "idle" } }));
    // 要約の提供元は最初の1本を自動選択する。すでに選択済みなら、2本目を保存しても勝手に切り替えない。
    // TypeSafe は要約に使わないので対象外
    if (provider !== "typesafe" && !aiProvider) {
      await saveAiProvider(provider);
      setAiProvider(provider);
    }
    return true;
  }, [aiProvider]);

  const removeAiKey = useCallback(async (provider: ApiKeyProvider) => {
    await deleteApiKey(provider);
    const nextKeySet = { ...aiKeySet, [provider]: false };
    setAiKeySet(nextKeySet);
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "idle" } }));
    if (aiProvider === provider) {
      const nextProvider = resolveAiProvider(
        undefined,
        nextKeySet.anthropic,
        nextKeySet.openai,
      );
      setAiProvider(nextProvider ?? null);
      if (nextProvider) await saveAiProvider(nextProvider);
      else await deleteAiProvider();
    }
  }, [aiKeySet, aiProvider]);

  const selectAiProvider = useCallback(async (provider: AiProvider) => {
    await saveAiProvider(provider);
    setAiProvider(provider);
  }, []);

  const runAiKeyTest = useCallback(async (provider: ApiKeyProvider) => {
    if (!(await loadApiKeyStatus())[provider]) {
      setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "no-key" } }));
      return;
    }
    setAiKeyTestState((current) => ({ ...current, [provider]: { phase: "testing" } }));
    const result = await (provider === "typesafe"
      ? testTypeSafeConnection()
      : provider === "openai"
        ? testOpenAiConnection()
        : testJudgeConnection());
    setAiKeyTestState((current) => ({
      ...current,
      [provider]: result.ok ? { phase: "success" } : { phase: "failure", reason: result.kind },
    }));
  }, []);

  // 3種の鳴きを個別に試聴する(連続再生ではどの音がどの状態か対応が取れないため)
  const previewChirp = useCallback((chirp: () => void) => {
    primeAudio();
    chirp();
  }, []);

  /** 1プロジェクト分の割り当てを変更する。set が DEFAULT_ICON_SET(鳥)ならエントリ自体を
   * 削除する(「鳥を選択 = 割り当て無し」の意味論。lib/icon-set-store.ts 参照)。それ以外は
   * {set, label} で upsert する(label は選択時点の表示名スナップショット)。
   * 変更は即 save + state 反映(他の設定項目と同じ方式) */
  const assignIconSet = useCallback(
    (slug: string, label: string, set: IconSetId) => {
      const next = { ...iconSetAssignments };
      if (set === DEFAULT_ICON_SET) {
        delete next[slug];
      } else {
        next[slug] = { set, label };
      }
      setIconSetAssignments(next);
      void saveIconSetAssignments(next);
    },
    [iconSetAssignments],
  );

  // 鳥・行のクリックで Ghostty のペインへ移る。mock は roots を使わないので対応が取れず何もしない
  const onFocusSession = useCallback(
    (id: string) => {
      void focusSession(id, roots).catch((e) => console.warn("[tomarigi] focus failed", e));
    },
    [roots],
  );
  const canFocus = useCallback((id: string) => focusTargetOf(id, roots) !== null, [roots]);

  const grantedCount = roots.filter((r) => perms[r.id] === "granted").length;
  // mock ソースは roots/perms を使わないため grantedCount は常に 0 のままだが、それは
  // 「アクセスが無い」状態ではないので Perch/Garden の空表示分岐には使わない
  const hasGranted = !source.usesRoots || grantedCount > 0;

  const showTabs = phase === "ready" && (!source.usesRoots || roots.length > 0);

  // アイコンセット設定に出す行 = 「現在のセッションに出ているプロジェクト(slug で重複除去)」
  // ∪「保存済み割り当てだけが残っているプロジェクト」。走っているものを先頭群にして
  // そのときの利用実態を優先しつつ、各群の中はラベル昇順で固定する。sessions は
  // sinceMs(直近書き込みからの経過)でソートされており、書き込みのたびに 0 へ戻るため
  // 出現順のままだと行の <select> がポーリング(3秒)ごとに並び替わってしまう
  // (開いている <select> の DOM ノードが再配置され、Chrome では開いたままのドロップダウンが
  // 閉じる実害がある)。ラベル昇順なら sessions の並びに依存せず安定する
  const iconSetRows = useMemo<IconSetRow[]>(() => {
    const seen = new Set<string>();
    const running: IconSetRow[] = [];
    for (const s of sessions) {
      if (seen.has(s.slug)) continue;
      seen.add(s.slug);
      running.push({ slug: s.slug, label: s.project, running: true });
    }
    running.sort((a, b) => a.label.localeCompare(b.label));
    const savedOnly = Object.entries(iconSetAssignments)
      .filter(([slug]) => !seen.has(slug))
      .map(([slug, a]) => ({ slug, label: a.label, running: false }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...running, ...savedOnly];
  }, [sessions, iconSetAssignments]);

  // Jev の判定を、同じターンの鳥にだけ付ける(ターンが変われば turnKey が変わり付かない)。
  // mock は ask を直接持つので上書きしない
  const displaySessions = useMemo(() => {
    // 要約用のキー(OpenAI / Anthropic)が無ければ、Jev が返事待ちと判定したターンは最後の応答文の最後の 1 文を
    // 吹き出しに出す(docs/design.md。AI を使わない)
    const hasSummaryKey = aiKeySet.anthropic || aiKeySet.openai;
    return sessions.map((s) => {
      if (!s.reply) return s;
      const key = turnKey(s.id, s.reply.at);
      const ask = s.ask ?? askJudgements[key];
      return {
        ...s,
        ask,
        summary: s.summary ?? turnLines[key],
        replyTail: !hasSummaryKey && ask?.status === "asking" ? lastSentence(s.reply.text) : undefined,
      };
    });
  }, [sessions, askJudgements, turnLines, aiKeySet.anthropic, aiKeySet.openai]);

  // 最近の動き・にわの印でも、Jev が返事待ちと判定したターンの done を応答待ちとして見せるため、
  // 同じターン(sessionId + 最終応答の時刻)の done イベントに判定を付ける
  // 最近の動きの行には、そのターンの吹き出しと同じ文(bubbleText)を添える。追加の要約は呼ばず、
  // 画面にいる鳥の今のターンのものだけを使う(永続のイベントログには入れない)
  const displayEvents = useMemo(() => {
    const askByTurn = new Map<string, AskJudgement>();
    const lineByDoneTurn = new Map<string, string>();
    const lineByWaitingSession = new Map<string, string>();
    for (const s of displaySessions) {
      const line = bubbleText(s);
      if (s.reply) {
        const key = turnKey(s.id, s.reply.at);
        if (s.ask) askByTurn.set(key, s.ask);
        if (line) lineByDoneTurn.set(key, line);
      } else if (s.state === "waiting" && line) {
        lineByWaitingSession.set(s.id, line);
      }
    }
    if (askByTurn.size === 0 && lineByDoneTurn.size === 0 && lineByWaitingSession.size === 0) {
      return events;
    }
    return events.map((e) => {
      const key = turnKey(e.sessionId, e.at);
      const ask = e.type === "done" ? askByTurn.get(key) : undefined;
      const line =
        e.type === "done"
          ? lineByDoneTurn.get(key)
          : e.type === "waiting"
            ? lineByWaitingSession.get(e.sessionId)
            : undefined;
      return ask || line ? { ...e, ...(ask && { ask }), ...(line && { line }) } : e;
    });
  }, [events, displaySessions]);

  return (
    <main className="page">
      <div className="page-header">
        <h1 className="brand">tomarigi</h1>
        {/* ミュート・デバッグ・設定・隠すはどのタブでも常に見える必要があるため、タブの外(ヘッダー)に置く。
            tomarigi の PIP ボタンは無い(アプリの窓そのものが常に最前面の浮遊窓) */}
        <div className="header-controls">
          {showTabs && (
            <>
            <button
              className="small"
              onClick={toggleMuted}
              aria-label={t(muted ? "unmuteButtonAria" : "muteButtonAria")}
            >
              {muted ? "🔕" : "🔔"}
            </button>
            {/* デバッグ専用ボタンなので i18n はせず英語ハードコード(DebugApp.tsx の方針と同じ) */}
            <button
              className={showDebug ? "small active" : "small"}
              onClick={() => setShowDebug((v) => !v)}
              aria-label="Debug log"
              title="Debug log"
              aria-pressed={showDebug}
            >
              <MdBugReport size={16} />
            </button>
            <button
              className={settingsOpen ? "small active" : "small"}
              onClick={() => setSettingsOpen((v) => !v)}
              aria-label={t("tabSettingsLabel")}
              aria-pressed={settingsOpen}
            >
              <MdSettings size={16} />
            </button>
            </>
          )}
          {/* 窓を隠す。メニューバーのアイコンから戻せる */}
          <button
            className="small"
            onClick={() => void invoke("hide_window")}
            aria-label={t("closeButtonAria")}
            title={t("closeButtonAria")}
          >
            <MdClose size={16} />
          </button>
        </div>
      </div>
      {phase === "loading" && <p className="note">{t("loadingLabel")}</p>}
      {phase === "ready" && source.usesRoots && roots.length === 0 && (
        <section className="setup">
          <p>{t("setupIntro")}</p>
          <button onClick={() => setRootDialogOpen(true)}>{t("setupButton")}</button>
          {addMessage && <p className="add-message">{addMessage}</p>}
        </section>
      )}
      {/* tomarigi は PiP へ移すために createPortal でまとめていたが、デスクトップ版は窓が1つなのでそのまま描画する */}
      <>
          {showTabs && (
            <>
              {/* 設定中はタブバーを隠し、⚙ 側で戻る。タブは「見る面(止まり木/イベント)」のみで、
                  設定は別階層なのでここには並べない */}
              {!settingsOpen && (
                <div className="tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    id="tab-btn-garden"
                    aria-selected={tab === "garden"}
                    aria-controls="tabpanel-garden"
                    className={tab === "garden" ? "tab-btn active" : "tab-btn"}
                    onClick={() => setTab("garden")}
                  >
                    {t("tabGardenLabel")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="tab-btn-perch"
                    aria-selected={tab === "perch"}
                    aria-controls="tabpanel-perch"
                    className={tab === "perch" ? "tab-btn active" : "tab-btn"}
                    onClick={() => setTab("perch")}
                  >
                    {t("tabPerchLabel")}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="tab-btn-events"
                    aria-selected={tab === "events"}
                    aria-controls="tabpanel-events"
                    className={tab === "events" ? "tab-btn active" : "tab-btn"}
                    onClick={() => setTab("events")}
                  >
                    {t("eventFeedHeading")}
                  </button>
                </div>
              )}
              {/* 各タブパネルは常にマウントしたまま hidden 属性で隠す(タブ切替のたびに
                  作り直すと Garden 等の内部 state が失われる)。設定中も同じく hidden */}
              <section
                role="tabpanel"
                id="tabpanel-events"
                aria-labelledby="tab-btn-events"
                hidden={settingsOpen || tab !== "events"}
              >
                <div className="stage stage-events">
                  <EventFeed
                    events={displayEvents}
                    showHeading={false}
                    onFocus={onFocusSession}
                    canFocus={canFocus}
                  />
                </div>
              </section>
              <section
                role="tabpanel"
                id="tabpanel-perch"
                aria-labelledby="tab-btn-perch"
                hidden={settingsOpen || tab !== "perch"}
              >
                <div className="stage stage-perch">
                  <Perch
                    sessions={displaySessions}
                    hasGranted={hasGranted}
                    iconSetAssignments={iconSetAssignments}
                    onFocus={onFocusSession}
                    canFocus={canFocus}
                  />
                </div>
              </section>
              <section
                role="tabpanel"
                id="tabpanel-garden"
                aria-labelledby="tab-btn-garden"
                hidden={settingsOpen || tab !== "garden"}
              >
                <div className="stage stage-garden">
                  <Garden
                    sessions={displaySessions}
                    events={displayEvents}
                    hasGranted={hasGranted}
                    iconSetAssignments={iconSetAssignments}
                    onFocus={onFocusSession}
                    canFocus={canFocus}
                  />
                </div>
              </section>
              <section className="settings-panel" hidden={!settingsOpen}>
                {/* 監視フォルダ管理は roots/perms サブシステムそのものなので mock では丸ごと
                    非表示にする(代替表示は無し)。BYOK・音量・読み上げ設定は mock でも
                    実物のまま動く(下の ApiKeySettings・voice-controls 参照) */}
                {source.usesRoots && (
                  <RootManager
                    roots={roots}
                    perms={perms}
                    brokenIds={brokenIds}
                    editing={editing}
                    addMessage={addMessage}
                    onRequestAdd={() => setRootDialogOpen(true)}
                    onRemove={removeRoot}
                    onStartEdit={startEdit}
                    onEditChange={(draft) => setEditing((prev) => (prev ? { ...prev, draft } : prev))}
                    onCommitEdit={commitEdit}
                    onCancelEdit={cancelEdit}
                  />
                )}
                <AiKeySettings
                  keySet={aiKeySet}
                  selectedProvider={aiProvider}
                  testState={aiKeyTestState}
                  onSaveKey={saveAiKey}
                  onDeleteKey={(provider) => void removeAiKey(provider)}
                  onTest={(provider) => void runAiKeyTest(provider)}
                  onSelect={(provider) => void selectAiProvider(provider)}
                />
                <IconSetSettings
                  rows={iconSetRows}
                  assignments={iconSetAssignments}
                  onChange={assignIconSet}
                />
                {/* 通知系トグル2種を「親チェックボックス + 直下のサブ行」の文法で統一する。
                    「音で知らせる」は既存の muted state の逆(checked = !muted)。ヘッダーの
                    🔔/🔕 ボタン(toggleMuted)と同じ state を共有するので自動的に同期する。
                    直下にまず鳴き声(chirp)専用の音量スライダー、続けて試聴ボタン2つを置く。
                    読み上げ(speechSynthesis)の音量とは別軸の独立設定(ゲームの SE/BGM 音量
                    分離と同じ発想。lib/chirp.ts の setChirpVolume 参照)。
                    「声で読み上げる」はイベント読み上げ(speechSynthesis)。デフォルト OFF の
                    オプトイン設定で、直下に読み上げ側の音量スライダーを置く */}
                <div className="voice-controls">
                  <label className="voice-enable-row">
                    <input type="checkbox" checked={!muted} onChange={toggleMuted} />
                    {t("soundEnableLabel")}
                  </label>
                  {/* 鳴き声側スライダーは muted(音で知らせる OFF)でも disabled にしない。
                      理由: 直下の試聴ボタンが muted でも押せるのと同じで、「試聴しながら
                      音量を決めて ON にする」流れを成立させるため。読み上げ側(試聴ボタンが
                      無い)は voiceEnabled で disabled にする方針のまま維持する(用途が違う:
                      読み上げ側は「発話するかどうか」のトグルに音量の意味が従属するが、
                      鳴き声側は試聴という確認手段があるので disabled にする理由が無い) */}
                  <label className="settings-subrow volume-row">
                    {t("voiceVolumeLabel")}
                    <input
                      type="range"
                      className="volume-slider"
                      min={0}
                      max={100}
                      value={Math.round(chirpVolume * 100)}
                      onChange={(e) => changeChirpVolume(Number(e.target.value) / 100)}
                    />
                    <span className="volume-value">{Math.round(chirpVolume * 100)}%</span>
                  </label>
                  {/* 試聴は「ON にするか決めるために聞く」操作なので、muted(音で知らせる OFF)でも
                      disabled にしない。ここを殺すと「鳴らしてみてから ON にする」という
                      自然な使い方ができなくなり本末転倒(音量スライダーは対象の設定自体を
                      変更する操作なので voiceEnabled で disabled にする方針のまま維持する) */}
                  <div className="settings-subrow sound-preview-row">
                    {/* 音はイベント発火なのでラベルもイベント側を使う(状態ラベルだと対応がずれる)。
                        ボタンのアイコンはフィードと同じ意味を教える */}
                    <button className="small" onClick={() => previewChirp(chirpDone)}>
                      <MdVolumeUp size={14} className="preview-mic" />
                      <MdCheckCircle className="event-icon tone-done" size={18} /> {EVENT.done.label}
                    </button>
                    <button className="small" onClick={() => previewChirp(chirpWaiting)}>
                      <MdVolumeUp size={14} className="preview-mic" />
                      <MdHelp className="event-icon tone-turn" size={18} /> {EVENT.waiting.label}
                    </button>
                  </div>
                  <label className="voice-enable-row">
                    <input type="checkbox" checked={voiceEnabled} onChange={toggleVoiceEnabled} />
                    {t("voiceEnableLabel")}
                  </label>
                  {/* 音量は voiceEnabled OFF でも値自体は保持する(トグルは発話するかどうかの
                      スイッチであり、音量とは独立の設定のため)。OFF 中は無意味な調整を防ぐため
                      disabled にするだけで値は変えない */}
                  <label className="settings-subrow volume-row">
                    {t("voiceVolumeLabel")}
                    <input
                      type="range"
                      className="volume-slider"
                      min={0}
                      max={100}
                      value={Math.round(voiceVolume * 100)}
                      disabled={!voiceEnabled}
                      onChange={(e) => changeVoiceVolume(Number(e.target.value) / 100)}
                    />
                    <span className="volume-value">{Math.round(voiceVolume * 100)}%</span>
                  </label>
                </div>
                {/* 浮遊窓 / 通常の窓(メニューバーのメニューからも変えられる。window-mode.ts) */}
                <section className="window-mode">
                  <h2>{t("windowModeHeading")}</h2>
                  <label className="voice-enable-row">
                    <input
                      type="radio"
                      name="window-mode"
                      checked={windowMode === "floating"}
                      onChange={() => setWindowMode("floating")}
                    />
                    {t("windowModeFloating")}
                  </label>
                  <label className="voice-enable-row">
                    <input
                      type="radio"
                      name="window-mode"
                      checked={windowMode === "normal"}
                      onChange={() => setWindowMode("normal")}
                    />
                    {t("windowModeNormal")}
                  </label>
                </section>
              </section>
            </>
          )}
          {/* App のスキャンループには一切影響しない、独立したページ内ダイアログ */}
          {showDebug && <DebugApp onClose={closeDebug} />}
          {rootDialogOpen && (
            <RootAddDialog
              onClose={() => setRootDialogOpen(false)}
              onChoose={(kind) => {
                setRootDialogOpen(false);
                void addRoot(kind);
              }}
            />
          )}
      </>
      {/* mock ソース専用のコントロールパネル(main.tsx が渡す MockPanel) */}
      {extraPanel}
    </main>
  );
}

interface RootChoice {
  kind: RootKind;
  label: string;
  path: string;
  shortcut: string;
}

function rootChoicesForCurrentPlatform(): RootChoice[] {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? "";
  const windows = /windows|win32/i.test(platform);
  const mac = /mac/i.test(platform);
  const shortcut = mac ? "Cmd+Shift+G" : "Ctrl+L";
  return [
    {
      kind: "claude",
      label: "Claude Code",
      path: windows ? String.raw`%USERPROFILE%\.claude\projects` : "~/.claude/projects",
      shortcut,
    },
    {
      kind: "codex",
      label: "Codex",
      path: windows ? String.raw`%USERPROFILE%\.codex\sessions` : "~/.codex/sessions",
      shortcut,
    },
  ];
}

function RootAddDialog({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (kind: RootKind) => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedKind, setCopiedKind] = useState<RootKind | null>(null);
  const choices = useMemo(rootChoicesForCurrentPlatform, []);

  useEffect(() => {
    const doc = overlayRef.current?.ownerDocument ?? document;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyPath = async (choice: RootChoice) => {
    try {
      await navigator.clipboard.writeText(choice.path);
      setCopiedKind(choice.kind);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedKind(null), 1_500);
    } catch (error) {
      console.warn("[tomarigi] パスをクリップボードへコピーできませんでした", error);
    }
  };

  return (
    <div
      className="root-add-overlay"
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="root-add-dialog-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="root-add-dialog">
        <div className="root-add-dialog-header">
          <h2 id="root-add-dialog-title">{t("setupIntro")}</h2>
          <button
            className="small"
            onClick={onClose}
            aria-label={t("closeButtonAria")}
            title={t("closeButtonAria")}
          >
            <MdClose size={16} />
          </button>
        </div>
        <div className="root-add-choices">
          {choices.map((choice, index) => (
            <div key={choice.kind} className="root-add-choice">
              <button autoFocus={index === 0} onClick={() => onChoose(choice.kind)}>
                ＋ {choice.label}
              </button>
              <span className="root-add-hint">
                {t("setupPickPrefix")}
                <kbd>{choice.shortcut}</kbd>
                {t("setupPickMiddle")}
                <button
                  type="button"
                  className="root-path-copy"
                  onClick={() => void copyPath(choice)}
                  aria-label={`${t("copyPathButton")}: ${choice.path}`}
                  title={`${t("copyPathButton")}: ${choice.path}`}
                >
                  <code>{choice.path}</code>
                  {copiedKind === choice.kind ? (
                    <MdCheckCircle size={16} aria-hidden="true" />
                  ) : (
                    <MdContentCopy size={16} aria-hidden="true" />
                  )}
                </button>
                {t("setupPickSuffix")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RootManager({
  roots,
  perms,
  brokenIds,
  editing,
  addMessage,
  onRequestAdd,
  onRemove,
  onStartEdit,
  onEditChange,
  onCommitEdit,
  onCancelEdit,
}: {
  roots: RootEntry[];
  perms: Record<string, PermissionState>;
  brokenIds: string[];
  editing: Editing | null;
  addMessage: string | null;
  onRequestAdd: () => void;
  onRemove: (id: string) => void;
  onStartEdit: (root: RootEntry) => void;
  onEditChange: (draft: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
}) {
  // Escape でキャンセルした直後に発火する blur が onCommitEdit を呼んで
  // 上書きコミットしてしまわないよう抑止する(編集行は常に高々1つなので共有で足りる)
  const suppressBlurRef = useRef(false);

  return (
    <section className="roots">
      <h2>{t("rootsHeading")}</h2>
      <ul className="root-list">
        {roots.map((root) => {
          const perm = perms[root.id];
          const broken = brokenIds.includes(root.id);
          const isEditing = editing?.id === root.id;
          return (
            <li key={root.id} className="root-row">
              {isEditing ? (
                <input
                  className="root-label-input"
                  autoFocus
                  value={editing.draft}
                  placeholder={t("rootLabelPlaceholder")}
                  onChange={(e) => onEditChange(e.target.value)}
                  // Escape 後に blur が来ないブラウザでフラグが残ると次回の blur 確定を
                  // 誤って握りつぶすため、編集開始のフォーカスで必ずリセットする
                  onFocus={() => {
                    suppressBlurRef.current = false;
                  }}
                  onBlur={() => {
                    if (suppressBlurRef.current) {
                      suppressBlurRef.current = false;
                      return;
                    }
                    onCommitEdit();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onCommitEdit();
                    if (e.key === "Escape") {
                      suppressBlurRef.current = true;
                      onCancelEdit();
                    }
                  }}
                />
              ) : (
                <span className="root-label" title={root.path}>
                  {root.label}
                  {/* ラベルだけでは実体(どの設定ディレクトリか)が分からないので、パスを添える */}
                  <span className="root-path">{root.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                </span>
              )}
              {/* 既定で常に監視するフォルダ(~/.claude/projects 等)。削除できない */}
              {root.builtin && <span className="badge badge-default">{t("rootDefaultBadge")}</span>}
              {/* デスクトップ版は読み取り許可の概念が無い。フォルダが無い・読めないときだけ出す */}
              {(broken || perm !== "granted") && (
                <span className="badge badge-error">{t("badgeUnreadable")}</span>
              )}
              {!isEditing && (
                <button className="small" onClick={() => onStartEdit(root)}>
                  {t("editLabelButton")}
                </button>
              )}
              {root.builtin ? (
                // 既定は消せない。× の場所だけ取って、追加した行とラベル編集ボタンの位置を揃える
                <button
                  className="small remove root-remove-placeholder"
                  aria-hidden="true"
                  tabIndex={-1}
                  disabled
                >
                  ✕
                </button>
              ) : (
                <button
                  className="small remove"
                  onClick={() => onRemove(root.id)}
                  aria-label={t("removeButtonAria")}
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button onClick={onRequestAdd}>{t("addRootButton")}</button>
      {addMessage && <p className="add-message">{addMessage}</p>}
    </section>
  );
}

/** APIキー設定全体。共通説明はここで1度だけ出し、プロバイダーごとの差は行に閉じ込める。 */
function AiKeySettings({
  keySet,
  selectedProvider,
  testState,
  onSaveKey,
  onDeleteKey,
  onTest,
  onSelect,
}: {
  keySet: Record<ApiKeyProvider, boolean>;
  selectedProvider: AiProvider | null;
  testState: Record<ApiKeyProvider, ApiKeyTestState>;
  onSaveKey: (provider: ApiKeyProvider, draft: string) => Promise<boolean>;
  onDeleteKey: (provider: ApiKeyProvider) => void;
  onTest: (provider: ApiKeyProvider) => void;
  onSelect: (provider: AiProvider) => void;
}) {
  return (
    <section className="ai-keys">
      <h2>{t("aiApiKeysHeading")}</h2>
      <p className="judge-description">{t("aiApiKeysDescription")}</p>
      <div className="ai-key-provider-list">
        {(["anthropic", "openai", "typesafe"] as const).map((provider) => (
          <ApiKeyProviderSettings
            key={provider}
            provider={provider}
            keySet={keySet[provider]}
            selected={selectedProvider === provider}
            testState={testState[provider]}
            onSaveKey={(draft) => onSaveKey(provider, draft)}
            onDeleteKey={() => onDeleteKey(provider)}
            onTest={() => onTest(provider)}
            onSelect={provider === "typesafe" ? undefined : () => onSelect(provider)}
          />
        ))}
      </div>
    </section>
  );
}

function ApiKeyProviderSettings({
  provider,
  keySet,
  selected,
  testState,
  onSaveKey,
  onDeleteKey,
  onTest,
  onSelect,
}: {
  provider: ApiKeyProvider;
  keySet: boolean;
  selected: boolean;
  testState: ApiKeyTestState;
  onSaveKey: (draft: string) => Promise<boolean>;
  onDeleteKey: () => void;
  onTest: () => void;
  // 要約の提供元に選べる行だけ渡す(TypeSafe は判断待ちの判定専用で、要約には使わない)
  onSelect?: () => void;
}) {
  // 保存前のキー入力欄のみが持つ一時state。保存後はここを空にして破棄する(平文を残さない)
  const [draft, setDraft] = useState("");
  // 保存済みのキーを差し替える入力欄を開いているか。キーの値は出さず、新しい値を入れて保存するだけ
  const [replacing, setReplacing] = useState(false);
  // 直前の保存が失敗したか。失敗したら入力を残したまま、この行に失敗を出す
  const [saveFailed, setSaveFailed] = useState(false);
  const heading =
    provider === "typesafe"
      ? t("typeSafeApiKeyHeading")
      : provider === "openai"
        ? t("openAiApiKeyHeading")
        : t("aiApiKeyHeading");

  return (
    <div className={`ai-key-provider ai-key-provider-${provider}`}>
      <h3>{heading}</h3>
      {provider === "typesafe" && (
        <p className="judge-description">
          {t("typeSafeApiKeyDescription")}{" "}
          {/* キーの取り方が分かるよう公式サイトへ。WebView の中ではなく外部ブラウザで開く */}
          <a
            href={TYPESAFE_SITE_URL}
            className="external-link"
            onClick={(e) => {
              e.preventDefault();
              void openUrl(TYPESAFE_SITE_URL).catch(() => window.open(TYPESAFE_SITE_URL, "_blank"));
            }}
          >
            {t("typeSafeSiteLink")}
          </a>
        </p>
      )}
      <div className="judge-key-row">
        {keySet && !replacing ? (
          <>
            <span className="judge-key-set">{t("byokApiKeySetLabel")}</span>
            <button className="small" onClick={() => setReplacing(true)}>
              {t("byokReplaceButton")}
            </button>
            <button className="small remove" onClick={onDeleteKey}>
              {t("byokDeleteButton")}
            </button>
          </>
        ) : (
          <>
            <input
              className="judge-key-input"
              type="password"
              autoComplete="off"
              value={draft}
              placeholder={heading}
              aria-label={heading}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              className="small"
              onClick={() => {
                void onSaveKey(draft).then((saved) => {
                  setSaveFailed(!saved && draft.trim() !== "");
                  if (!saved) return;
                  setDraft("");
                  setReplacing(false);
                });
              }}
            >
              {t("byokSaveButton")}
            </button>
          </>
        )}
      </div>
      {saveFailed && (
        <p className="judge-status judge-status-error" role="alert">
          {t("byokSaveFailedMessage")}
        </p>
      )}
      {keySet && onSelect && (
        <label className="ai-provider-choice">
          <input
            type="radio"
            name="summary-provider"
            checked={selected}
            onChange={onSelect}
          />
          {t("byokUseForSummaryLabel")}
        </label>
      )}
      {/* キー未設定時は無効化する。押しても no-key 結果になるだけの操作を防ぐ */}
      <button className="small" onClick={onTest} disabled={!keySet}>
        {t("byokTestButton")}
      </button>
      {testState.phase === "testing" && (
        <p className="judge-status">{t("byokTestingLabel")}</p>
      )}
      {testState.phase === "success" && (
        <p className="judge-status judge-status-ok">
          {t("byokTestResultSuccess")}
        </p>
      )}
      {testState.phase === "failure" && (
        <p className="judge-status judge-status-error">
          {t("byokTestResultFailure", testState.reason)}
        </p>
      )}
      {testState.phase === "no-key" && (
        <p className="judge-status judge-status-error">
          {t("byokNoKeyMessage")}
        </p>
      )}
    </div>
  );
}

/**
 * アイコンセットのプロジェクト個別割り当て(issue #14)。行 = プロジェクト(slug 単位で
 * 重複除去)で、右端のトグルボタンを押すたびに ICON_SET_IDS の並び順で次のセットへ
 * 順送りする(frog の次は birds に一周)。対象は「現在のセッションに出ているプロジェクト」
 * ∪「保存済み割り当てだけが残っているプロジェクト」の和集合(iconSetRows。App.tsx 側で
 * 計算)。走っていない行は淡色にして区別する(icon-set-row-idle)。「鳥」に戻すと割り当て
 * エントリ自体を削除する(エントリ無し = 鳥、という意味論。lib/icon-set-store.ts の
 * resolveIconSet 参照)。変更は即 save + state 反映(RootManager 等と同じく、専用の
 * 保存ボタンは置かない方式)。
 */
function IconSetSettings({
  rows,
  assignments,
  onChange,
}: {
  rows: IconSetRow[];
  assignments: IconSetAssignments;
  onChange: (slug: string, label: string, set: IconSetId) => void;
}) {
  return (
    <section className="icon-sets">
      <h2>{t("iconSetHeading")}</h2>
      {rows.length === 0 ? (
        <p className="icon-set-empty">{t("iconSetEmpty")}</p>
      ) : (
        <ul className="icon-set-list">
          {rows.map((row) => {
            const set = resolveIconSet(assignments, row.slug);
            const nextSet = ICON_SET_IDS[(ICON_SET_IDS.indexOf(set) + 1) % ICON_SET_IDS.length];
            return (
              <li
                key={row.slug}
                className={row.running ? "icon-set-row" : "icon-set-row icon-set-row-idle"}
              >
                <span className="icon-set-project" title={row.slug}>
                  {row.label}
                </span>
                <img
                  className="icon-set-glyph"
                  src={ICON_SETS[set].working}
                  width={20}
                  height={20}
                  alt=""
                  title={ICON_SET_LABEL[set]}
                  draggable={false}
                />
                <button
                  type="button"
                  className="small icon-set-toggle"
                  aria-label={`${t("iconSetToggleAria")}: ${row.label} (${ICON_SET_LABEL[set]})`}
                  onClick={() => onChange(row.slug, row.label, nextSet)}
                >
                  ⇄
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
