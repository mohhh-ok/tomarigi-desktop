/** Attributes for elements that jump to the Ghostty pane on click (Perch rows, event cards, garden birds).
 * Nothing is added for ones that can't be matched (Codex, mock) = clicking does nothing and the look doesn't change */
export function focusProps(id: string, onFocus?: (id: string) => void, canFocus?: (id: string) => boolean) {
  if (!onFocus || !canFocus?.(id)) return {};
  return {
    className: "focusable",
    onClick: () => onFocus(id),
  };
}
