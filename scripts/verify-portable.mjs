import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
const root = process.cwd();
const exe = path.join(root, "release/DropBridge-1.0.0-x64-portable.exe");
const shot = path.join(root, "docs/portable.png");
await fs.mkdir(path.join(root, ".test-data"), { recursive: true });
// NSIS does not forward its child's console output. Inspect the actual extracted app through a local debug port instead.
const child = spawn(exe, ["--remote-debugging-port=9228"], {
  windowsHide: true,
  env: {
    ...process.env,
    DROPBRIDGE_SMOKE: "0",
    DROPBRIDGE_DATA_DIR: path.join(root, ".test-data/portable-data"),
    DROPBRIDGE_RECEIVE_DIR: path.join(root, ".test-data/portable-received"),
  },
});
let output = "";
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});
const exited = new Promise((resolve, reject) => {
  child.on("exit", resolve);
  child.on("error", reject);
});
let browser;
try {
  for (let n = 0; n < 120; n++) {
    try {
      const res = await fetch("http://127.0.0.1:9228/json/version");
      if (res.ok) {
        browser = await chromium.connectOverCDP("http://127.0.0.1:9228");
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!browser)
    throw new Error("Portable app did not open its inspection port.");
  const page = browser.contexts()[0].pages()[0];
  await expect(
    page.getByRole("heading", { name: "A little closer, together." }),
  ).toBeVisible();
  const state = await page.evaluate(() => window.dropbridge.invoke("state"));
  if (!state.running) throw new Error(state.serverError);
  await page.screenshot({ path: shot });
  console.log(
    JSON.stringify({ running: state.running, url: state.url, bridge: true }),
  );
  await page.close();
} catch (error) {
  child.kill();
  throw error;
}
const code = await exited;
if (code !== 0) throw new Error(`Portable launch failed (${code}): ${output}`);
if (!(await fs.stat(shot)).size) throw new Error("Portable screenshot missing");
console.log(
  "PASS standalone portable executable: self-extraction, production UI, native bridge, internal private LAN server, clean shutdown.",
);
