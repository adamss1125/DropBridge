import { spawn } from "node:child_process";
import electron from "electron";
const vite = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  { stdio: "inherit" },
);
// The phone is served production assets by the embedded service; watch them alongside desktop HMR.
const mobileBuild = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "build", "--watch"],
  { stdio: "inherit" },
);
let desktop;
for (let n = 0; n < 100; n++) {
  try {
    const res = await fetch("http://127.0.0.1:5174");
    if (res.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 150));
}
desktop = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, DROPBRIDGE_DEV_URL: "http://127.0.0.1:5174" },
});
const close = () => {
  desktop?.kill();
  vite.kill();
  mobileBuild.kill();
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
desktop.on("exit", () => {
  vite.kill();
  mobileBuild.kill();
  process.exit();
});
