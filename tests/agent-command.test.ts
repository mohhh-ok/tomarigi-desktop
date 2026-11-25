import { describe, expect, test } from "bun:test";
import { commandParts } from "../src/perch/agent-command";

describe("commandParts", () => {
  test("takes the URL and the token from the command the app shows", () => {
    const command =
      'claude mcp add --scope user --transport http tomarigi http://127.0.0.1:4844/mcp --header "Authorization: Bearer 0f3a9c"';
    expect(commandParts(command)).toEqual({ url: "http://127.0.0.1:4844/mcp", token: "0f3a9c" });
  });

  test("null for a command without them, so no empty rows show", () => {
    expect(commandParts("claude mcp remove --scope user tomarigi")).toBeNull();
  });
});
