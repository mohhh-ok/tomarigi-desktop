// The LLM regression test's transport (tools/llm-regression/transport.ts) posts the app's bodies with fetch, copying
// the URLs, headers, and timeouts of Rust's keys.rs. This checks the copy still matches keys.rs, so the test keeps
// sending what the app sends (docs/design.md "LLM regression test")
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { KEYS_RS_VALUES } from "../tools/llm-regression/transport.ts";

const keysRs = readFileSync(new URL("../src-tauri/src/keys.rs", import.meta.url), "utf8");

test("the URLs and the Anthropic version are the ones keys.rs posts to", () => {
  expect(keysRs).toContain(`post_json("${KEYS_RS_VALUES.openaiUrl}", vec![("authorization", format!("Bearer {key}"))]`);
  expect(keysRs).toContain(`"${KEYS_RS_VALUES.anthropicUrl}",`);
  expect(keysRs).toContain(`vec![("x-api-key", key), ("anthropic-version", "${KEYS_RS_VALUES.anthropicVersion}".to_string())]`);
  expect(keysRs).toContain(`local_url(&base_url, "${KEYS_RS_VALUES.localChatPath}")`);
});

test("the timeouts are keys.rs CLOUD_TIMEOUT and LOCAL_TIMEOUT", () => {
  expect(keysRs).toContain(`const CLOUD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(${KEYS_RS_VALUES.cloudTimeoutSeconds});`);
  expect(keysRs).toContain(`const LOCAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(${KEYS_RS_VALUES.localTimeoutSeconds});`);
});
