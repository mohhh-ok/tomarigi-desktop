import { useEffect, useRef, useState } from "react";
import { MdCheckCircle, MdClose, MdContentCopy } from "react-icons/md";
import { t } from "@/lib/i18n";
import type { RootKind } from "@/lib/fsa";

interface RootChoice {
  kind: RootKind;
  label: string;
  path: string;
  shortcut: string;
}

// The app runs on macOS only, so the paths and the shortcut of the macOS folder picker (Go to Folder) are fixed
const ROOT_CHOICES: RootChoice[] = [
  { kind: "claude", label: "Claude Code", path: "~/.claude/projects", shortcut: "Cmd+Shift+G" },
  { kind: "codex", label: "Codex", path: "~/.codex/sessions", shortcut: "Cmd+Shift+G" },
];

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
          {ROOT_CHOICES.map((choice, index) => (
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
