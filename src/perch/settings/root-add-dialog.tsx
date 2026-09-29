import { useEffect, useMemo, useRef, useState } from "react";
import { MdCheckCircle, MdClose, MdContentCopy } from "react-icons/md";
import { t } from "@/lib/i18n";
import type { RootKind } from "@/lib/fsa";

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

export function RootAddDialog({
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
      console.warn("[tomarigi] failed to copy the path to the clipboard", error);
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
