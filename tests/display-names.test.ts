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

const namesOf = (entries: NameCandidate[]) => Object.fromEntries(displayNamesOf(entries));

describe("display names", () => {
  test("names that don't collide stay as they are", () => {
    expect(namesOf([session("a", "orbit"), session("b", "tomarigi-desktop")])).toEqual({
      a: "orbit",
      b: "tomarigi-desktop",
    });
  });

  test("a session name isn't used when the name doesn't collide", () => {
    expect(namesOf([session("a", "orbit", { sessionName: "orbit-daily" })])).toEqual({
      a: "orbit",
    });
  });

  test("two the same without session names: numbered in the order they started, the first keeps the plain name", () => {
    expect(
      namesOf([session("a", "orbit", { startedAt: 2000 }), session("b", "orbit", { startedAt: 1000 })]),
    ).toEqual({ a: "orbit 2", b: "orbit" });
  });

  test("three the same: 1st plain, then 2 and 3", () => {
    expect(
      namesOf([
        session("a", "orbit", { startedAt: 3000 }),
        session("b", "orbit", { startedAt: 1000 }),
        session("c", "orbit", { startedAt: 2000 }),
      ]),
    ).toEqual({ a: "orbit 3", b: "orbit", c: "orbit 2" });
  });

  test("sessions with no start time come after those with one, then by id, so the numbers don't change between scans", () => {
    const entries = [
      session("z", "orbit"),
      session("y", "orbit"),
      session("x", "orbit", { startedAt: 5000 }),
    ];
    expect(namesOf(entries)).toEqual({ x: "orbit", y: "orbit 2", z: "orbit 3" });
    expect(namesOf([...entries].reverse())).toEqual(namesOf(entries));
  });

  test("session names tell them apart when each has one", () => {
    expect(
      namesOf([
        session("a", "orbit", { sessionName: "orbit-daily", startedAt: 1000 }),
        session("b", "orbit", { sessionName: "orbit-render", startedAt: 2000 }),
      ]),
    ).toEqual({ a: "orbit-daily", b: "orbit-render" });
  });

  test("one with a session name, one without: the named one shows its name, the other keeps the plain name", () => {
    expect(
      namesOf([
        session("a", "orbit", { startedAt: 1000 }),
        session("b", "orbit", { sessionName: "orbit-daily", startedAt: 2000 }),
      ]),
    ).toEqual({ a: "orbit", b: "orbit-daily" });
  });

  test("a session name equal to the base name doesn't count", () => {
    expect(
      namesOf([
        session("a", "orbit", { sessionName: "orbit", startedAt: 2000 }),
        session("b", "orbit", { startedAt: 1000 }),
      ]),
    ).toEqual({ a: "orbit 2", b: "orbit" });
  });

  test("the same session name on two sessions: numbered after the session name", () => {
    expect(
      namesOf([
        session("a", "orbit", { sessionName: "daily", startedAt: 2000 }),
        session("b", "orbit", { sessionName: "daily", startedAt: 1000 }),
        session("c", "orbit", { startedAt: 500 }),
      ]),
    ).toEqual({ a: "daily 2", b: "daily", c: "orbit" });
  });

  test("a session name that equals another session's plain name is numbered with it", () => {
    expect(
      namesOf([
        session("a", "orbit", { startedAt: 1000 }),
        session("b", "orbit", { sessionName: "tomarigi-desktop", startedAt: 2000 }),
        session("c", "tomarigi-desktop", { startedAt: 500 }),
      ]),
    ).toEqual({ a: "orbit", b: "tomarigi-desktop 2", c: "tomarigi-desktop" });
  });

  test("the same project in two agent folders still gets the folder's label", () => {
    expect(
      namesOf([
        session("a", "orbit", { rootId: "c1", rootLabel: "claude" }),
        session("b", "orbit", { rootId: "c2", rootLabel: "claude2" }),
      ]),
    ).toEqual({ a: "orbit (claude)", b: "orbit (claude2)" });
  });

  test("two in one folder and one in another: the folder's label, then numbers within the folder", () => {
    expect(
      namesOf([
        session("a", "orbit", { rootId: "c1", rootLabel: "claude", startedAt: 1000 }),
        session("b", "orbit", { rootId: "c1", rootLabel: "claude", startedAt: 2000 }),
        session("c", "orbit", { rootId: "c2", rootLabel: "claude2", startedAt: 500 }),
      ]),
    ).toEqual({ a: "orbit (claude)", b: "orbit (claude) 2", c: "orbit (claude2)" });
  });

  test("two in one folder with session names and one in another folder", () => {
    expect(
      namesOf([
        session("a", "orbit", { rootId: "c1", rootLabel: "claude", sessionName: "daily", startedAt: 1000 }),
        session("b", "orbit", { rootId: "c1", rootLabel: "claude", startedAt: 2000 }),
        session("c", "orbit", { rootId: "c2", rootLabel: "claude2", startedAt: 500 }),
      ]),
    ).toEqual({ a: "daily", b: "orbit (claude)", c: "orbit (claude2)" });
  });

  test("a numbered name never repeats a name already on screen", () => {
    expect(
      namesOf([
        session("a", "orbit", { startedAt: 1000 }),
        session("b", "orbit", { startedAt: 2000 }),
        session("c", "orbit 2", { startedAt: 3000 }),
      ]),
    ).toEqual({ a: "orbit", b: "orbit 3", c: "orbit 2" });
  });
});
