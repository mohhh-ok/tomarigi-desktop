// The concierge's bubble with a "What's going on?" summary (docs/design.md "Concierge"): session names link to their
// panes both in the summary and in the advice below the dividing line, the same way and with the same look
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionView } from "../src/lib/sessions.ts";
import { ConciergeReport } from "../src/perch/concierge-report.tsx";

const view = (id: string): SessionView => ({ id, project: id, slug: id, state: "working", sinceMs: 1000 });
const sessions = [view("billionclips"), view("blog")];

const render = (advice: string, canJump: (id: string) => boolean = () => true) =>
  renderToStaticMarkup(
    <ConciergeReport
      parts={{ summary: { kind: "shown", text: "blog: 下書き中" }, advice }}
      sessions={sessions}
      canJump={canJump}
      onCloseSummary={() => {}}
    />,
  );
const NAME = '<span role="button" tabindex="0" class="concierge-summary-name fade-target">';
const adviceOf = (html: string) => html.slice(html.indexOf('class="concierge-summary-advice"'));

describe("names in the advice below the dividing line", () => {
  test("link like the summary's names, with the same look; the rest stays text", () => {
    const html = render("billionclipsに対応するissue番号を指定してください");
    expect(html).toContain(`${NAME}blog</span>: 下書き中`);
    expect(adviceOf(html)).toBe(
      `class="concierge-summary-advice">${NAME}billionclips</span>に対応するissue番号を指定してください</span>`,
    );
  });

  test("only sessions the user can jump to are links", () => {
    expect(adviceOf(render("billionclipsに返事を", (id) => id !== "billionclips"))).toBe(
      'class="concierge-summary-advice">billionclipsに返事を</span>',
    );
  });
});
