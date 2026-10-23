// Which Perch rows show the state and elapsed time on a second line under the name (docs/design.md "Display names")
import { useLayoutEffect, useState, type RefObject } from "react";

/** What decides whether a row fits on one line. Widths are the texts' own widths, not what the layout gave them, so
 * the answer is the same whether the row is on one line or two and it doesn't flip back and forth */
export interface RowFit {
  /** The row's width */
  rowWidth: number;
  /** From the row's left edge to the name's (the marks' room, the bird and the gap after it) */
  nameLeft: number;
  /** The whole name's width */
  nameWidth: number;
  /** The whole state word's width plus the elapsed time's (with the working dots) */
  statusWidth: number;
  /** The gap between the name and the state word */
  gap: number;
  /** The tool name's whole width (with its 「 · 」), or 0 without one */
  toolWidth: number;
}

/** Whether the name and the state with its elapsed time don't fit on one line together. The tool name and the request
 * excerpt don't count: they take only what is left and hide when nothing is */
export function needsTwoLines({ rowWidth, nameLeft, nameWidth, statusWidth, gap }: RowFit): boolean {
  return Math.ceil(nameLeft + nameWidth + gap + statusWidth) > Math.floor(rowWidth);
}

/** Whether the tool name fits whole after the state and elapsed time, on the first line or, for a row on two lines, on
 * the second (which starts under the name). One that doesn't is left out, so it takes no width: hidden but still laid
 * out, it kept the state from going to the row's right end */
export function toolFits(fit: RowFit, twoLines: boolean): boolean {
  const { rowWidth, nameLeft, nameWidth, statusWidth, gap, toolWidth } = fit;
  const before = twoLines ? nameLeft + statusWidth : nameLeft + nameWidth + gap + statusWidth;
  return Math.ceil(before + toolWidth) <= Math.floor(rowWidth);
}

let canvas: HTMLCanvasElement | undefined;

/** The width of an element's whole text in its own font, however much of it is shown */
function textWidth(el: Element): number {
  const style = getComputedStyle(el);
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return el.getBoundingClientRect().width;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return ctx.measureText(el.textContent ?? "").width;
}

/** RowFit of a row's first line (.bird-row-main), or undefined for a row without a name */
export function measureRow(row: HTMLElement): RowFit | undefined {
  const name = row.querySelector<HTMLElement>(".bird-row-name");
  const label = row.querySelector<HTMLElement>(".bird-row-label");
  const since = row.querySelector<HTMLElement>(".bird-row-since");
  const tool = row.querySelector<HTMLElement>(".bird-row-tool");
  if (!name || !label || !since) return undefined;
  const style = getComputedStyle(row);
  const rowLeft = row.getBoundingClientRect().left + (parseFloat(style.paddingLeft) || 0);
  return {
    rowWidth: row.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
    nameLeft: name.getBoundingClientRect().left - rowLeft,
    nameWidth: textWidth(name),
    // The elapsed time never shrinks, so its box is its own width (the dots included); it sits right after the state
    // word (its negative margin takes back the row gap)
    statusWidth: textWidth(label) + since.getBoundingClientRect().width,
    gap: parseFloat(style.columnGap) || 0,
    // Its negative margin takes back the row gap too
    toolWidth: tool ? textWidth(tool) : 0,
  };
}

export interface RowLayouts {
  /** Rows that show the state on a second line */
  twoLines: Set<string>;
  /** Rows whose tool name doesn't fit and is left out */
  noTool: Set<string>;
}

const sameIds = (a: Set<string>, b: Set<string>) => a.size === b.size && [...b].every((id) => a.has(id));

/**
 * How the rows (data-row-id on .bird-row-main) under list are laid out. Measured again when the list's width changes,
 * when what the rows show changes (key), and once the fonts have loaded
 */
export function useRowLayouts(list: RefObject<HTMLElement | null>, key: unknown): RowLayouts {
  const [layouts, setLayouts] = useState<RowLayouts>(() => ({ twoLines: new Set(), noTool: new Set() }));
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      const next: RowLayouts = { twoLines: new Set(), noTool: new Set() };
      for (const row of el.querySelectorAll<HTMLElement>(".bird-row-main[data-row-id]")) {
        const fit = measureRow(row);
        if (!fit) continue;
        const id = row.dataset.rowId!;
        const twoLines = needsTwoLines(fit);
        if (twoLines) next.twoLines.add(id);
        if (fit.toolWidth > 0 && !toolFits(fit, twoLines)) next.noTool.add(id);
      }
      setLayouts((prev) =>
        sameIds(prev.twoLines, next.twoLines) && sameIds(prev.noTool, next.noTool) ? prev : next,
      );
    };
    measure();
    let alive = true;
    void document.fonts?.ready.then(() => alive && measure());
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [list, key]);
  return layouts;
}
