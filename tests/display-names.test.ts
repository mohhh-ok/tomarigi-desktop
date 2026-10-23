// Sessions on screen that would show the same display name are told apart: by the session's own name when it
// has one, otherwise by a number in the order they started (docs/design.md "Display names")
import { describe, expect, test } from "bun:test";
import { displayNamesOf, type NameCandidate } from "../src/lib/display-names.ts";

const session = (id: string, base: string, more: Partial<NameCandidate> = {}): NameCandidate => ({
  id,
  base,
  rootId: "claude",
  rootLabel: "Claude Code",
  ...more,
});

const namesOf = (entries: NameCandidate[]) =>
  Object.fromEntries([...displayNamesOf(entries)].map(([id, { name }]) => [id, name]));
const suffixesOf = (entries: NameCandidate[]) =>
  Object.fromEntries([...displayNamesOf(entries)].map(([id, { suffix }]) => [id, suffix]));

describe("display names", () => {
  test("names that don't collide stay as they are", () => {
    expect(namesOf([session("a", "billionclips"), session("b", "tomarigi-desktop")])).toEqual({
      a: "billionclips",
      b: "tomarigi-desktop",
    });
  });

  test("a session name isn't used when the name doesn't collide", () => {
    expect(namesOf([session("a", "billionclips", { sessionName: "billionclips-daily" })])).toEqual({
      a: "billionclips",
    });
  });

  test("two the same without session names: numbered in the order they started, the first keeps the plain name", () => {
    expect(
      namesOf([session("a", "billionclips", { startedAt: 2000 }), session("b", "billionclips", { startedAt: 1000 })]),
    ).toEqual({ a: "billionclips 2", b: "billionclips" });
  });

  test("three the same: 1st plain, then 2 and 3", () => {
    expect(
      namesOf([
        session("a", "billionclips", { startedAt: 3000 }),
        session("b", "billionclips", { startedAt: 1000 }),
        session("c", "billionclips", { startedAt: 2000 }),
      ]),
    ).toEqual({ a: "billionclips 3", b: "billionclips", c: "billionclips 2" });
  });

  test("sessions with no start time come after those with one, then by id, so the numbers don't change between scans", () => {
    const entries = [
      session("z", "billionclips"),
      session("y", "billionclips"),
      session("x", "billionclips", { startedAt: 5000 }),
    ];
    expect(namesOf(entries)).toEqual({ x: "billionclips", y: "billionclips 2", z: "billionclips 3" });
    expect(namesOf([...entries].reverse())).toEqual(namesOf(entries));
  });

  test("session names tell them apart when each has one", () => {
    expect(
      namesOf([
        session("a", "billionclips", { sessionName: "billionclips-daily", startedAt: 1000 }),
        session("b", "billionclips", { sessionName: "billionclips-render", startedAt: 2000 }),
      ]),
    ).toEqual({ a: "billionclips-daily", b: "billionclips-render" });
  });

  test("one with a session name, one without: the named one shows its name, the other keeps the plain name", () => {
    expect(
      namesOf([
        session("a", "billionclips", { startedAt: 1000 }),
        session("b", "billionclips", { sessionName: "billionclips-daily", startedAt: 2000 }),
      ]),
    ).toEqual({ a: "billionclips", b: "billionclips-daily" });
  });

  test("a session name equal to the base name doesn't count", () => {
    expect(
      namesOf([
        session("a", "billionclips", { sessionName: "billionclips", startedAt: 2000 }),
        session("b", "billionclips", { startedAt: 1000 }),
      ]),
    ).toEqual({ a: "billionclips 2", b: "billionclips" });
  });

  test("the same session name on two sessions: numbered after the session name", () => {
    expect(
      namesOf([
        session("a", "billionclips", { sessionName: "daily", startedAt: 2000 }),
        session("b", "billionclips", { sessionName: "daily", startedAt: 1000 }),
        session("c", "billionclips", { startedAt: 500 }),
      ]),
    ).toEqual({ a: "daily 2", b: "daily", c: "billionclips" });
  });

  test("a session name that equals another session's plain name is numbered with it", () => {
    expect(
      namesOf([
        session("a", "billionclips", { startedAt: 1000 }),
        session("b", "billionclips", { sessionName: "tomarigi-desktop", startedAt: 2000 }),
        session("c", "tomarigi-desktop", { startedAt: 500 }),
      ]),
    ).toEqual({ a: "billionclips", b: "tomarigi-desktop 2", c: "tomarigi-desktop" });
  });

  test("the same project in two agent folders still gets the folder's label", () => {
    expect(
      namesOf([
        session("a", "billionclips", { rootId: "c1", rootLabel: "claude" }),
        session("b", "billionclips", { rootId: "c2", rootLabel: "claude2" }),
      ]),
    ).toEqual({ a: "billionclips (claude)", b: "billionclips (claude2)" });
  });

  test("two in one folder and one in another: the folder's label, then numbers within the folder", () => {
    expect(
      namesOf([
        session("a", "billionclips", { rootId: "c1", rootLabel: "claude", startedAt: 1000 }),
        session("b", "billionclips", { rootId: "c1", rootLabel: "claude", startedAt: 2000 }),
        session("c", "billionclips", { rootId: "c2", rootLabel: "claude2", startedAt: 500 }),
      ]),
    ).toEqual({ a: "billionclips (claude)", b: "billionclips (claude) 2", c: "billionclips (claude2)" });
  });

  test("two in one folder with session names and one in another folder", () => {
    expect(
      namesOf([
        session("a", "billionclips", { rootId: "c1", rootLabel: "claude", sessionName: "daily", startedAt: 1000 }),
        session("b", "billionclips", { rootId: "c1", rootLabel: "claude", startedAt: 2000 }),
        session("c", "billionclips", { rootId: "c2", rootLabel: "claude2", startedAt: 500 }),
      ]),
    ).toEqual({ a: "daily", b: "billionclips (claude)", c: "billionclips (claude2)" });
  });

  test("a numbered name never repeats a name already on screen", () => {
    expect(
      namesOf([
        session("a", "billionclips", { startedAt: 1000 }),
        session("b", "billionclips", { startedAt: 2000 }),
        session("c", "billionclips 2", { startedAt: 3000 }),
      ]),
    ).toEqual({ a: "billionclips", b: "billionclips 3", c: "billionclips 2" });
  });

  test("the end that tells a name apart is kept as its suffix, so it stays visible when the name is cut", () => {
    expect(
      suffixesOf([
        session("a", "billionclips", { startedAt: 1000 }),
        session("b", "billionclips", { startedAt: 2000 }),
        session("c", "tomarigi-desktop", { sessionName: "tomarigi-desktop-advice-links", startedAt: 1000 }),
        session("d", "tomarigi-desktop", { startedAt: 2000 }),
        session("e", "blog"),
      ]),
    ).toEqual({ a: undefined, b: " 2", c: "-advice-links", d: undefined, e: undefined });
  });

  test("suffixes of folder labels, numbers after a label, and numbers after a session name", () => {
    expect(
      suffixesOf([
        session("a", "billionclips", { rootId: "c1", rootLabel: "claude", startedAt: 1000 }),
        session("b", "billionclips", { rootId: "c1", rootLabel: "claude", startedAt: 2000 }),
        session("c", "billionclips", { rootId: "c2", rootLabel: "claude2" }),
        session("d", "blog", { sessionName: "daily", startedAt: 1000 }),
        session("e", "blog", { sessionName: "daily", startedAt: 2000 }),
      ]),
    ).toEqual({ a: " (claude)", b: " (claude) 2", c: " (claude2)", d: undefined, e: " 2" });
  });
});
