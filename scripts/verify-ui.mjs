import { chromium, _electron as electron, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { fixture } from "../tests/helpers.mjs";

const f = await fixture();
const root = process.cwd();
const errors = [];
const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  downloadsPath: path.join(f.root, "browser-downloads"),
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  acceptDownloads: true,
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("requestfailed", (req) =>
  console.log("FAILED", req.url(), req.failure()),
);
f.service.on("diagnostic", (message) => console.log("SERVER", message));
let desktop;
try {
  await page.goto(f.service.url + "/#pair=" + f.service.pairCode);
  await expect(
    page.getByRole("button", { name: "Connect to my PC" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Connect to my PC" }).click();
  await expect.poll(() => f.service.pending.size).toBe(1);
  await f.service.approvePairing([...f.service.pending.keys()][0], true);
  await expect(
    page.getByRole("button", { name: "Send Photos & Videos" }),
  ).toBeVisible();
  const content = Buffer.from("Browser to Windows: original bytes");
  await page
    .locator("input[type=file]")
    .last()
    .setInputFiles([
      { name: "browser-test.txt", mimeType: "text/plain", buffer: content },
      {
        name: "browser-test.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("duplicate"),
      },
    ]);
  await expect
    .poll(
      () => f.service.history.filter((t) => t.status === "Completed").length,
      { timeout: 30000 },
    )
    .toBe(2);
  if (
    !f.service.history.some(
      (t) => t.sha256 === createHash("sha256").update(content).digest("hex"),
    )
  )
    throw new Error("Browser checksum mismatch");
  const shared = path.join(f.root, "download.txt");
  await fs.writeFile(shared, "Windows to browser");
  await f.service.addShares([shared]);
  await expect(
    page.getByRole("button", { name: "Download", exact: true }),
  ).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const download = await downloading;
  const save = path.join(f.root, "downloaded.txt");
  await download.saveAs(save);
  if ((await fs.readFile(save, "utf8")) !== "Windows to browser")
    throw new Error("Download mismatch");
  await page
    .getByRole("button", { name: "Select download.txt", exact: true })
    .click();
  const zipping = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download 1 as ZIP" }).click();
  const zip = await zipping;
  await zip.saveAs(path.join(f.root, "browser.zip"));
  if (
    (await fs.readFile(path.join(f.root, "browser.zip"))).readUInt32LE() !==
    0x04034b50
  )
    throw new Error("ZIP mismatch");
  const imagePath = path.join(f.root, "preview.png");
  await fs.copyFile(path.join(root, "build/icon.png"), imagePath);
  await f.service.addShares([imagePath]);
  await page.getByRole("button", { name: "Preview preview.png" }).click();
  await expect(
    page.getByRole("dialog", { name: "Preview preview.png" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    if (overflow) throw new Error(`Overflow at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(root, "docs/mobile.png"),
    fullPage: true,
  });
  const bounds = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  if (bounds.scroll > bounds.width)
    throw new Error("Mobile horizontal overflow");
  await f.service.revokeDevice(f.service.devices[0].id);
  await expect(
    page.getByRole("button", { name: "Connect to my PC" }),
  ).toBeVisible();
  console.log(
    "PASS mobile viewport: pairing, approval, batch upload, collision, checksums, file download, ZIP, revocation, no overflow",
  );
  await context.close();
  await f.close();
  desktop = await electron.launch({
    executablePath: process.env.DROPBRIDGE_EXECUTABLE,
    args: process.env.DROPBRIDGE_EXECUTABLE ? [] : ["."],
    cwd: root,
    env: {
      ...process.env,
      DROPBRIDGE_DATA_DIR: path.join(root, ".test-data", "electron-data"),
      DROPBRIDGE_RECEIVE_DIR: path.join(
        root,
        ".test-data",
        "electron-received",
      ),
    },
  });
  const win = await desktop.firstWindow();
  win.on("pageerror", (e) => errors.push(e.message));
  await expect(
    win.getByRole("heading", { name: "A little closer, together." }),
  ).toBeVisible();
  const config = await desktop.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const p = w.webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  if (!config.sandbox || !config.contextIsolation || config.nodeIntegration)
    throw new Error("Electron isolation mismatch");
  const initial = await win.evaluate(() => window.dropbridge.invoke("state"));
  if (!initial.running) throw new Error(initial.serverError);
  await win.locator(".address").click();
  await expect(
    win.getByText("Local address copied", { exact: true }),
  ).toBeVisible();
  const filename = path.join(
    root,
    ".test-data",
    `desktop-share-${Date.now()}.txt`,
  );
  await fs.writeFile(filename, "Desktop bridge share");
  await win.evaluate(
    (p) => window.dropbridge.invoke("addFiles", [p]),
    filename,
  );
  await win.getByRole("button", { name: "Send Files", exact: true }).click();
  await expect(
    win.getByText(path.basename(filename), { exact: true }),
  ).toBeVisible();
  await win.getByRole("button", { name: "Settings", exact: true }).click();
  await win.getByLabel("Device name").fill("DropBridge QA PC");
  await win.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() =>
      win.evaluate(() =>
        window.dropbridge.invoke("state").then((s) => s.deviceName),
      ),
    )
    .toBe("DropBridge QA PC");
  await win.getByRole("button", { name: "Dashboard", exact: true }).click();
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  });
  const peer = await phone.newPage();
  peer.on("pageerror", (e) => errors.push(e.message));
  const real = await win.evaluate(() => window.dropbridge.invoke("state"));
  await peer.goto(real.url + "/#pair=" + real.pairCode);
  await peer.getByRole("button", { name: "Connect to my PC" }).click();
  await expect(
    win.getByRole("button", { name: "Approve", exact: true }),
  ).toBeVisible();
  await win.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    peer.getByRole("button", { name: "Send Files", exact: true }),
  ).toBeVisible();
  const realName = `LAN-test-${Date.now()}.txt`;
  await peer
    .locator("input[type=file]")
    .last()
    .setInputFiles({
      name: realName,
      mimeType: "text/plain",
      buffer: Buffer.from("Actual Electron LAN upload"),
    });
  await expect
    .poll(
      () =>
        win.evaluate(
          (name) =>
            window.dropbridge
              .invoke("state")
              .then((s) =>
                s.history.some(
                  (t) => t.name === name && t.status === "Completed",
                ),
              ),
          realName,
        ),
      { timeout: 30000 },
    )
    .toBe(true);
  await win.getByRole("button", { name: "Send Files", exact: true }).click();
  const fileCard = peer
    .locator(".mobile-file-card")
    .filter({ hasText: path.basename(filename) });
  const realDownloading = peer.waitForEvent("download");
  await fileCard.getByRole("button", { name: "Download", exact: true }).click();
  const realDownload = await realDownloading;
  const realSave = path.join(root, ".test-data", "actual-lan-download.txt");
  await realDownload.saveAs(realSave);
  if ((await fs.readFile(realSave, "utf8")) !== "Desktop bridge share")
    throw new Error("Actual LAN download mismatch");
  await win.getByRole("button", { name: "Dashboard", exact: true }).click();
  await win.screenshot({ path: path.join(root, "docs/desktop.png") });
  await win.getByRole("button", { name: "Local server online" }).click();
  await expect(
    win.getByRole("button", { name: "Start local server" }),
  ).toBeVisible();
  await win.getByRole("button", { name: "Start local server" }).click();
  await expect(
    win.getByRole("button", { name: "Local server online" }),
  ).toBeVisible();
  await phone.close();
  await desktop.close();
  desktop = undefined;
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "PASS actual Electron: secure preload, internal LAN server, share, persisted setting, server stop/start, production UI; no page errors",
  );
} finally {
  await desktop?.close().catch(() => {});
  await browser.close().catch(() => {});
  if (f.service.running) await f.close();
}
