// The settings page's half of TOMARIGI_SETTINGS_TEST (src-tauri/src/settings_window.rs; debug builds only): with the
// floating window hidden, it changes settings through the page's own controls, one every 1.5 seconds, and logs each
// step as `[settings-test]`. The floating window logs its reloads (`[settings-sync] main reloads …`), and the check
// reads the floating window's values through the MCP get_settings tool (README)
import { invoke } from "@tauri-apps/api/core";

const log = (line: string) => void invoke("log", { line: `[settings-test] page ${line}` }).catch(() => {});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function nav(index: number) {
  document.querySelectorAll<HTMLButtonElement>(".settings-nav-item")[index]?.click();
  // Until React has shown the section
  await wait(400);
}

function click(selector: string, index = 0): boolean {
  const el = document.querySelectorAll<HTMLElement>(selector)[index];
  el?.click();
  return Boolean(el);
}

/** Sets a React-controlled range input the way a drag does */
function slide(selector: string, value: number): boolean {
  const input = document.querySelector<HTMLInputElement>(selector);
  if (!input) return false;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

export async function runSettingsSelfTest(): Promise<void> {
  log(`loaded section=${new URLSearchParams(location.search).get("section")} focus=${document.hasFocus()}`);
  // Until the floating window is hidden (settings_window.rs)
  await wait(7000);
  const steps: [string, () => Promise<boolean>][] = [
    ["sound: toggle notify with sound", async () => (await nav(0), click(".voice-controls input[type=checkbox]"))],
    ["sound: chirp volume 40", async () => slide(".voice-controls .volume-slider", 40)],
    ["sound: toggle read aloud", async () => click(".voice-controls input[type=checkbox]", 1)],
    ["sound: readout voice system", async () => click(".readout-voice input[type=radio]:not(:checked)")],
    ["concierge: other look", async () => (await nav(2), click(".concierge-look input:not(:checked)"))],
    ["icons: next set for the first row", async () => (await nav(4), click(".icon-set-toggle"))],
    ["window: standard", async () => (await nav(5), click(".window-mode input[type=radio]:not(:checked)"))],
    ["window: floating", async () => click(".window-mode input[type=radio]:not(:checked)")],
  ];
  for (const [name, run] of steps) {
    await wait(name === "window: floating" ? 4000 : 1500);
    log(`${name} found=${await run()}`);
  }
  await wait(1500);
  log(`after window mode focus=${document.hasFocus()}`);
  log("done");
}
