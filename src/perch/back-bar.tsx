import { MdChevronLeft } from "react-icons/md";

// Row shown in place of the tabs on screens entered from the header (settings, the debug log): "‹ Back" and the
// screen's title. Writing the exit as text means leaving doesn't depend on telling the header's buttons apart
// (× next to them hides the window). Same height, border, and underline as .tabs so nothing shifts on the way in and out
export function BackBar({
  backLabel,
  title,
  onBack,
}: {
  backLabel: string;
  title: string;
  onBack: () => void;
}) {
  return (
    <div className="back-bar">
      <button type="button" className="back-bar-button" onClick={onBack}>
        <MdChevronLeft size={16} />
        {backLabel}
      </button>
      <h2 className="back-bar-title">{title}</h2>
    </div>
  );
}
