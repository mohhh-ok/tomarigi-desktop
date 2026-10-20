// A small button that runs something and shows it while it runs: a turning ring and the running label take the place of
// its label, and it can't be pressed again. Shared by the connection tests and "Check for updates"

export function BusyButton({
  label,
  busyLabel,
  busy,
  disabled = false,
  onClick,
}: {
  label: string;
  busyLabel: string;
  busy: boolean;
  // Can't be pressed for another reason (dimmed); busy isn't dimmed, since it is doing what was asked
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="small busy-button" onClick={onClick} disabled={disabled || busy} aria-busy={busy}>
      {busy && <span className="busy-ring" aria-hidden="true" />}
      {busy ? busyLabel : label}
    </button>
  );
}
