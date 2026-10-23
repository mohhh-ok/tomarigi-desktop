// The header's button into "Concierge only" (docs/design.md "Concierge"): the concierge's picture the user chose, made
// like the other header buttons. Dictionaries aren't loaded here, so its label renders empty
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConciergeOnlyEntry } from "../src/perch/concierge.tsx";

test("the button shows the chosen look and is a small header button", () => {
  const owl = renderToStaticMarkup(<ConciergeOnlyEntry look="owl" onClick={() => {}} />);
  const penguin = renderToStaticMarkup(<ConciergeOnlyEntry look="penguin" onClick={() => {}} />);
  expect(owl).toContain('<button class="small concierge-only-entry"');
  expect(owl).toContain("owl");
  expect(penguin).toContain("penguin");
  expect(penguin).not.toContain("owl");
});
