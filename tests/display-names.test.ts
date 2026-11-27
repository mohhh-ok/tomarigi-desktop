// Sessions on screen that would show the same display name are told apart: by the session's own name when it
// has one, otherwise by a number in the order they started (docs/design/display-names.md "Display names")
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
    expect(namesOf([session("a", "app-p"), session("b", "tomarigi-desktop")])).toEqual({
      a: "app-p",
      b: "tomarigi-desktop",
    });
  });

  test("a session name isn't used when the name doesn't collide", () => {
    expect(namesOf([session("a", "app-p", { sessionName: "app-p-daily" })])).toEqual({
      a: "app-p",
    });
  });

  test("two the same without session names: numbered in the order they started, the first keeps the plain name", () => {
    expect(
      namesOf([session("a", "app-p", { startedAt: 2000 }), session("b", "app-p", { startedAt: 1000 })]),
    ).toEqual({ a: "app-p 2", b: "app-p" });
  });

  test("three the same: 1st plain, then 2 and 3", () => {
    expect(
      namesOf([
        session("a", "app-p", { startedAt: 3000 }),
        session("b", "app-p", { startedAt: 1000 }),
        session("c", "app-p", { startedAt: 2000 }),
      ]),
    ).toEqual({ a: "app-p 3", b: "app-p", c: "app-p 2" });
  });

  test("sessions with no start time come after those with one, then by id, so the numbers don't change between scans", () => {
    const entries = [
      session("z", "app-p"),
      session("y", "app-p"),
      session("x", "app-p", { startedAt: 5000 }),
    ];
    expect(namesOf(entries)).toEqual({ x: "app-p", y: "app-p 2", z: "app-p 3" });
    expect(namesOf([...entries].reverse())).toEqual(namesOf(entries));
  });

  test("session names tell them apart when each has one", () => {
    expect(
      namesOf([
        session("a", "app-p", { sessionName: "app-p-daily", startedAt: 1000 }),
        session("b", "app-p", { sessionName: "app-p-render", startedAt: 2000 }),
      ]),
    ).toEqual({ a: "app-p-daily", b: "app-p-render" });
  });

  test("one with a session name, one without: the named one shows its name, the other keeps the plain name", () => {
    expect(
      namesOf([
        session("a", "app-p", { startedAt: 1000 }),
        session("b", "app-p", { sessionName: "app-p-daily", startedAt: 2000 }),
      ]),
    ).toEqual({ a: "app-p", b: "app-p-daily" });
  });

  test("a session name equal to the base name doesn't count", () => {
    expect(
      namesOf([
        session("a", "app-p", { sessionName: "app-p", startedAt: 2000 }),
        session("b", "app-p", { startedAt: 1000 }),
      ]),
    ).toEqual({ a: "app-p 2", b: "app-p" });
  });

  test("the same session name on two sessions: numbered after the session name", () => {
    expect(
      namesOf([
        session("a", "app-p", { sessionName: "daily", startedAt: 2000 }),
        session("b", "app-p", { sessionName: "daily", startedAt: 1000 }),
        session("c", "app-p", { startedAt: 500 }),
      ]),
    ).toEqual({ a: "daily 2", b: "daily", c: "app-p" });
  });

  test("a session name that equals another session's plain name is numbered with it", () => {
    expect(
      namesOf([
        session("a", "app-p", { startedAt: 1000 }),
        session("b", "app-p", { sessionName: "tomarigi-desktop", startedAt: 2000 }),
        session("c", "tomarigi-desktop", { startedAt: 500 }),
      ]),
    ).toEqual({ a: "app-p", b: "tomarigi-desktop 2", c: "tomarigi-desktop" });
  });

  test("the same project in two agent folders still gets the folder's label", () => {
    expect(
      namesOf([
        session("a", "app-p", { rootId: "c1", rootLabel: "claude" }),
        session("b", "app-p", { rootId: "c2", rootLabel: "claude2" }),
      ]),
    ).toEqual({ a: "app-p (claude)", b: "app-p (claude2)" });
  });

  test("two in one folder and one in another: the folder's label, then numbers within the folder", () => {
    expect(
      namesOf([
        session("a", "app-p", { rootId: "c1", rootLabel: "claude", startedAt: 1000 }),
        session("b", "app-p", { rootId: "c1", rootLabel: "claude", startedAt: 2000 }),
        session("c", "app-p", { rootId: "c2", rootLabel: "claude2", startedAt: 500 }),
      ]),
    ).toEqual({ a: "app-p (claude)", b: "app-p (claude) 2", c: "app-p (claude2)" });
  });

  test("two in one folder with session names and one in another folder", () => {
    expect(
      namesOf([
        session("a", "app-p", { rootId: "c1", rootLabel: "claude", sessionName: "daily", startedAt: 1000 }),
        session("b", "app-p", { rootId: "c1", rootLabel: "claude", startedAt: 2000 }),
        session("c", "app-p", { rootId: "c2", rootLabel: "claude2", startedAt: 500 }),
      ]),
    ).toEqual({ a: "daily", b: "app-p (claude)", c: "app-p (claude2)" });
  });

  test("a numbered name never repeats a name already on screen", () => {
    expect(
      namesOf([
        session("a", "app-p", { startedAt: 1000 }),
        session("b", "app-p", { startedAt: 2000 }),
        session("c", "app-p 2", { startedAt: 3000 }),
      ]),
    ).toEqual({ a: "app-p", b: "app-p 3", c: "app-p 2" });
  });

  test("the end that tells a name apart is kept as its suffix, so it stays visible when the name is cut", () => {
    expect(
      suffixesOf([
        session("a", "app-p", { startedAt: 1000 }),
        session("b", "app-p", { startedAt: 2000 }),
        session("c", "tomarigi-desktop", { sessionName: "tomarigi-desktop-advice-links", startedAt: 1000 }),
        session("d", "tomarigi-desktop", { startedAt: 2000 }),
        session("e", "blog"),
      ]),
    ).toEqual({ a: undefined, b: " 2", c: "-advice-links", d: undefined, e: undefined });
  });

  test("suffixes of folder labels, numbers after a label, and numbers after a session name", () => {
    expect(
      suffixesOf([
        session("a", "app-p", { rootId: "c1", rootLabel: "claude", startedAt: 1000 }),
        session("b", "app-p", { rootId: "c1", rootLabel: "claude", startedAt: 2000 }),
        session("c", "app-p", { rootId: "c2", rootLabel: "claude2" }),
        session("d", "blog", { sessionName: "daily", startedAt: 1000 }),
        session("e", "blog", { sessionName: "daily", startedAt: 2000 }),
      ]),
    ).toEqual({ a: " (claude)", b: " (claude) 2", c: " (claude2)", d: undefined, e: " 2" });
  });
});
