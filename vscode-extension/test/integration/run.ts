// Starts a downloaded VS Code with this extension and runs the suite inside it. HOME points at a temporary folder so
// the window file is written there, not in the user's ~/.tomarigi
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tomarigi-ext-home-"));
  try {
    await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, "../../.."),
      extensionTestsPath: path.resolve(__dirname, "suite"),
      launchArgs: ["--disable-extensions", "--user-data-dir", path.join(home, "user-data")],
      extensionTestsEnv: { HOME: home, TOMARIGI_TEST_HOME: home },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
