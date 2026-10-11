import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import {
  randomBytes,
  randomInt,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, WebSocket } from "ws";
import archiver from "archiver";
import QRCode from "qrcode";
import { networkAdapters, isPrivateIPv4 } from "./network.mjs";

export const CHUNK_SIZE = 4 * 1024 * 1024;
const SESSION_MS = 24 * 60 * 60 * 1000;
const PARTIAL_MS = 24 * 60 * 60 * 1000;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
const token = () => randomBytes(32).toString("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
function equal(a, b) {
  return (
    typeof a === "string" &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function safeFilename(input) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    /[\/\\\x00-\x1f]/.test(input) ||
    input === "." ||
    input === ".."
  )
    fail(400, "Invalid filename. Paths are not allowed.");
  let name = input
    .normalize("NFC")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = "_" + name;
  if (!name) fail(400, "Invalid filename.");
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}
function cookie(req) {
  const part = (req.headers.cookie || "")
    .split(";")
    .find((p) => p.trim().startsWith("db_session="));
  return part?.trim().slice(11);
}
async function readJSON(req) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16384) fail(413, "Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    fail(400, "Invalid JSON.");
  }
}
function json(res, data, status = 200) {
  if (!res.destroyed && !res.headersSent) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  }
}
async function fileHash(filename, signal) {
  const h = createHash("sha256");
  for await (const c of fs.createReadStream(filename, { signal })) h.update(c);
  return h.digest("hex");
}

export class DropBridgeService extends EventEmitter {
  constructor({ dataDir, receiveDir, webDir, host, port = 47831 }) {
    super();
    this.dataDir = dataDir;
    this.webDir = webDir;
    this.requestedHost = host;
    this.port = port;
    this.settings = {
      deviceName: os.hostname(),
      receiveDir,
      maxConcurrent: 3,
      maxFileGB: 20,
      notifications: true,
      autoAccept: true,
      theme: "dark",
      launchAtLogin: false,
      adapter: "",
    };
    this.devices = [];
    this.history = [];
    this.shares = [];
    this.uploads = new Map();
    this.sessions = new Map();
    this.pending = new Map();
    this.rate = new Map();
    this.inflight = new Map();
    this.downloads = new Map();
    this.previews = new Map();
    this.running = false;
    this.networkWarning = "";
    this.serverError = "";
    this.writeChain = Promise.resolve();
    this.changeTimer = null;
    this.stopping = false;
    this.handlers = new Set();
  }
  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    this.partDir = path.join(this.dataDir, "partials");
    await fsp.mkdir(this.partDir, { recursive: true });
    try {
      const saved = JSON.parse(
        await fsp.readFile(path.join(this.dataDir, "state.json"), "utf8"),
      );
      this.settings = { ...this.settings, ...saved.settings };
      this.devices = saved.devices || [];
      this.history = saved.history || [];
      this.shares = saved.shares || [];
      // Tokens deliberately do not persist. Active uploads remain resumable by an explicitly re-approved device.
      for (const u of saved.uploads || []) {
        if (
          !/^[a-f0-9-]{36}$/.test(u.id) ||
          Date.now() - u.updated > PARTIAL_MS
        )
          continue;
        try {
          const stat = await fsp.stat(this.partialPath(u.id));
          if (stat.size >= u.offset) {
            await fsp.truncate(this.partialPath(u.id), u.offset);
            this.uploads.set(u.id, {
              ...u,
              liveOffset: u.offset,
              status: u.status === "Waiting" ? "Waiting" : "Paused",
              speed: 0,
            });
          }
        } catch {
          /* Missing partial cannot resume. */
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.serverError =
          "Saved state could not be read; a new session was started.";
      }
    }
    await fsp.mkdir(this.settings.receiveDir, { recursive: true });
    const keep = new Set([...this.uploads.keys()].map((id) => id + ".part"));
    for (const file of await fsp.readdir(this.partDir))
      if (/^[a-f0-9-]{36}\.part$/.test(file) && !keep.has(file))
        await fsp.unlink(path.join(this.partDir, file)).catch(() => {});
    await this.rotatePairing();
    return this;
  }
  partialPath(id) {
    return path.join(this.partDir, id + ".part");
  }
  persist() {
    const data = JSON.stringify({
      settings: this.settings,
      devices: this.devices,
      history: this.history.slice(0, 500),
      shares: this.shares,
      uploads: [...this.uploads.values()],
    });
    this.writeChain = this.writeChain
      .catch(() => {})
      .then(async () => {
        const file = path.join(this.dataDir, "state.json");
        await fsp.writeFile(file + ".tmp", data);
        await fsp.rename(file + ".tmp", file);
      });
    return this.writeChain;
  }
  async rotatePairing() {
    this.pairCode = String(randomInt(100000, 1000000));
    this.pairExpires = Date.now() + 5 * 60 * 1000;
    await this.makeQR();
    this.changed();
  }
  async makeQR() {
    this.qr = this.url
      ? await QRCode.toDataURL(`${this.url}/#pair=${this.pairCode}`, {
          width: 240,
          margin: 2,
          color: { dark: "#101216", light: "#ffffff" },
        })
      : "";
  }
  desktopState() {
    return {
      ...this.publicState(),
      settings: this.settings,
      url: this.url || "",
      host: this.host || "",
      port: this.actualPort || this.port,
      qr: this.qr,
      pairCode: this.pairCode,
      pairExpires: this.pairExpires,
      devices: this.devices.map((d) => ({
        ...d,
        connected:
          [...this.sessions.values()].some(
            (s) => s.deviceId === d.id && s.expires > Date.now(),
          ) &&
          (this.wss?.clients
            ? [...this.wss.clients].some(
                (ws) =>
                  ws.deviceId === d.id && ws.readyState === WebSocket.OPEN,
              )
            : false),
      })),
      pending: [...this.pending.values()]
        .filter((p) => p.status === "Waiting" && p.expires > Date.now())
        .map(({ ticket, ...p }) => p),
      adapters: networkAdapters(),
      networkWarning: this.networkWarning,
      serverError: this.serverError,
      uploads: [...this.uploads.values()],
      history: this.history,
      shares: this.shares,
    };
  }
  publicState(deviceId) {
    const transfers = [...this.uploads.values(), ...this.history]
      .filter((t) => !deviceId || t.deviceId === deviceId)
      .map(({ path: _path, ...t }) => t);
    return {
      running: this.running,
      deviceName: this.settings.deviceName,
      maxConcurrent: this.settings.maxConcurrent,
      maxFileGB: this.settings.maxFileGB,
      chunkSize: CHUNK_SIZE,
      shares: this.shares.map(({ path: _path, ...s }) => s),
      transfers,
      downloads: [...this.downloads.values()]
        .filter((t) => !deviceId || t.deviceId === deviceId)
        .map(({ abort: _abort, sessionKey: _key, ...t }) => t),
      totalReceived: this.history
        .filter((t) => t.direction === "receive" && t.status === "Completed")
        .reduce((n, t) => n + t.size, 0),
    };
  }
  changed(immediate = true) {
    const send = () => {
      this.changeTimer = null;
      this.emit("state", this.desktopState());
      for (const ws of this.wss?.clients || []) {
        if (ws.readyState === WebSocket.OPEN) {
          const s = this.sessions.get(ws.sessionKey);
          if (!s || s.expires <= Date.now()) ws.close(4001, "Session expired");
          else ws.send(JSON.stringify(this.publicState(ws.deviceId)));
        }
      }
    };
    if (immediate) {
      if (this.changeTimer) clearTimeout(this.changeTimer);
      send();
    } else if (!this.changeTimer) this.changeTimer = setTimeout(send, 180);
  }
  async start() {
    if (this.running) return;
    const adapters = networkAdapters();
    this.host =
      this.requestedHost ||
      this.settings.adapter ||
      adapters.find((a) => !a.virtual)?.address;
    if (!this.host) {
      this.serverError =
        "No private Wi-Fi or Ethernet address found. Connect to your local network, then start the server.";
      this.changed();
      return;
    }
    if (!this.requestedHost && !adapters.some((a) => a.address === this.host)) {
      this.serverError =
        "The selected network address is no longer available. Choose another adapter in Settings.";
      this.changed();
      return;
    }
    this.stopping = false;
    this.http = http.createServer((req, res) => {
      const task = this.handle(req, res)
        .catch((error) => {
          if (res.headersSent) res.destroy();
          else
            json(
              res,
              {
                error: error.status
                  ? error.message
                  : "The operation failed. Check disk space and permissions on your PC.",
              },
              error.status || 500,
            );
          if (!error.status) this.emit("diagnostic", error.message);
        })
        .finally(() => this.handlers.delete(task));
      this.handlers.add(task);
    });
    this.http.requestTimeout = 120000;
    this.http.headersTimeout = 20000;
    this.http.maxHeadersCount = 50;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
    this.http.on("upgrade", (req, socket, head) => {
      try {
        this.checkRequest(req);
        if (req.url !== "/ws") fail(404, "Not found");
        const s = this.auth(req);
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          ws.deviceId = s.deviceId;
          ws.sessionKey = s.key;
          ws.alive = true;
          ws.on("pong", () => {
            ws.alive = true;
          });
          ws.on("error", () => {});
          ws.on("close", () => this.changed());
          this.wss.emit("connection", ws, req);
          ws.send(JSON.stringify(this.publicState(s.deviceId)));
          this.changed();
        });
      } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
    try {
      await new Promise((resolve, reject) => {
        this.http.once("error", reject);
        this.http.listen(this.port, this.host, resolve);
      });
    } catch (error) {
      this.serverError =
        error.code === "EADDRINUSE"
          ? `Port ${this.port} is in use. Close the other DropBridge instance and try again.`
          : `Cannot start on ${this.host}: ${error.code || error.message}`;
      this.http.close();
      this.changed();
      return;
    }
    this.actualPort = this.http.address().port;
    this.url = `http://${this.host}:${this.actualPort}`;
    this.running = true;
    this.serverError = "";
    this.networkWarning = "";
    if (Date.now() > this.pairExpires) {
      this.pairCode = String(randomInt(100000, 1000000));
      this.pairExpires = Date.now() + 5 * 60 * 1000;
    }
    await this.makeQR();
    this.timer = setInterval(
      () =>
        this.maintenance().catch((error) => {
          this.serverError = "Could not update local state: " + error.message;
          this.changed();
        }),
      15000,
    );
    this.timer.unref();
    this.changed();
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    for (const control of this.inflight.values()) control.abort();
    for (const control of this.downloads.values()) control.abort?.();
    for (const control of this.previews.values()) control.abort();
    for (const ws of this.wss?.clients || []) ws.terminate();
    this.wss?.close();
    if (this.http) {
      this.http.closeAllConnections();
      await new Promise((resolve) => this.http.close(resolve));
    }
    await Promise.allSettled([...this.handlers]);
    this.running = false;
    this.sessions.clear();
    this.pending.clear();
    for (const u of this.uploads.values())
      if (u.status === "Transferring") {
        u.status = "Paused";
        u.speed = 0;
      }
    await this.persist();
    this.changed();
  }
  async maintenance() {
    if (Date.now() > this.pairExpires) await this.rotatePairing();
    for (const [k, s] of this.sessions)
      if (s.expires < Date.now()) this.revokeSession(k);
    for (const [k, p] of this.pending)
      if (p.expires < Date.now()) this.pending.delete(k);
    for (const [k, v] of this.rate)
      if (Date.now() - v.at > 60000) this.rate.delete(k);
    for (const ws of this.wss?.clients || []) {
      if (!ws.alive) ws.terminate();
      else {
        ws.alive = false;
        ws.ping();
      }
    }
    if (
      !this.requestedHost &&
      !networkAdapters().some((a) => a.address === this.host)
    )
      this.networkWarning =
        "Your local address changed or Wi-Fi disconnected. Stop and restart the server; scan the new QR code.";
    let cleaned = false;
    for (const u of [...this.uploads.values()])
      if (Date.now() - u.updated > PARTIAL_MS && !this.inflight.has(u.id)) {
        await this.cancelUpload(u.id);
        cleaned = true;
      }
    if (cleaned) await this.persist();
    this.changed();
  }
  checkRequest(req) {
    if (req.headers.host !== `${this.host}:${this.actualPort}`)
      fail(403, "Unrecognized host. Use the address displayed on your PC.");
    if (req.headers.origin && req.headers.origin !== this.url)
      fail(403, "Cross-origin requests are not allowed.");
    if (req.headers["sec-fetch-site"] === "cross-site")
      fail(403, "Cross-site requests are not allowed.");
    const remote = req.socket.remoteAddress?.replace("::ffff:", "");
    if (remote !== "127.0.0.1" && !isPrivateIPv4(remote || ""))
      fail(403, "Private network connections only.");
  }
  auth(req) {
    const raw = cookie(req);
    const key = raw && hash(raw);
    const s = this.sessions.get(key);
    if (
      !s ||
      s.expires <= Date.now() ||
      !this.devices.some((d) => d.id === s.deviceId && !d.revoked)
    )
      fail(401, "Pair this device with your PC to continue.");
    return { ...s, key };
  }
  limit(req, name, max) {
    const k = req.socket.remoteAddress + ":" + name;
    let bucket = this.rate.get(k);
    if (!bucket || Date.now() - bucket.at > 60000) {
      bucket = { at: Date.now(), count: 0 };
      this.rate.set(k, bucket);
    }
    if (++bucket.count > max)
      fail(429, "Too many requests. Wait one minute and try again.");
  }
  async handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    this.checkRequest(req);
    const url = new URL(req.url, this.url);
    const pathname = url.pathname;
    if (pathname === "/api/info" && req.method === "GET")
      return json(res, { deviceName: this.settings.deviceName, running: true });
    if (pathname === "/api/pair" && req.method === "POST") {
      this.limit(req, "pair", 10);
      const body = await readJSON(req);
      if (Date.now() > this.pairExpires || !equal(body.code, this.pairCode))
        fail(
          403,
          "Pairing code expired or incorrect. Scan the current QR code on your PC.",
        );
      if (
        [...this.pending.values()].filter((p) => p.status === "Waiting")
          .length >= 20
      )
        fail(429, "Too many pairing requests. Review them on your PC.");
      const id = randomUUID(),
        ticket = token();
      const identity = (req.headers.cookie || "")
        .split(";")
        .find((p) => p.trim().startsWith("db_identity="))
        ?.trim()
        .slice(12);
      const known =
        identity && this.devices.find((d) => d.resumeHash === hash(identity));
      this.pending.set(id, {
        id,
        ticket,
        knownDeviceId: known?.id,
        name: String(body.name || "Browser device").slice(0, 60),
        ip: req.socket.remoteAddress,
        requested: Date.now(),
        expires: Date.now() + 120000,
        status: "Waiting",
      });
      this.changed();
      return json(res, { id, ticket }, 202);
    }
    if (pathname === "/api/pair/status" && req.method === "POST") {
      this.limit(req, "poll", 120);
      const body = await readJSON(req),
        p = this.pending.get(body.id);
      if (!p || p.expires < Date.now() || !equal(body.ticket, p.ticket))
        fail(410, "Pairing request expired. Scan again.");
      if (p.status === "Approved" && !this.sessions.has(hash(p.rawToken)))
        p.status = "Denied";
      if (p.status === "Approved") {
        const cookies = [
          `db_session=${p.rawToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`,
        ];
        if (p.rawIdentity)
          cookies.push(
            `db_identity=${p.rawIdentity}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          );
        res.setHeader("Set-Cookie", cookies);
        this.pending.delete(p.id);
        return json(res, { status: "Approved" });
      }
      return json(res, { status: p.status });
    }
    if (pathname.startsWith("/api/")) {
      const session = this.auth(req);
      this.limit(req, "api", 1200);
      if (pathname === "/api/state" && req.method === "GET")
        return json(res, this.publicState(session.deviceId));
      if (pathname === "/api/download/check" && req.method === "POST") {
        const body = await readJSON(req);
        if (
          !Array.isArray(body.ids) ||
          !body.ids.length ||
          body.ids.length > 200
        )
          fail(400, "Select 1–200 files.");
        for (const id of body.ids) await this.availableShare(id);
        if (this.downloads.size >= this.settings.maxConcurrent)
          fail(429, "Download slots are busy. Try shortly.");
        return json(res, { ok: true });
      }
      if (pathname === "/api/logout" && req.method === "POST") {
        this.revokeSession(session.key);
        res.setHeader(
          "Set-Cookie",
          "db_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return json(res, { ok: true });
      }
      if (pathname === "/api/uploads" && req.method === "POST") {
        const body = await readJSON(req);
        const name = safeFilename(body.name);
        if (
          !Number.isSafeInteger(body.size) ||
          body.size < 0 ||
          body.size > this.settings.maxFileGB * 1024 ** 3
        )
          fail(413, `File exceeds the ${this.settings.maxFileGB} GB limit.`);
        if (this.uploads.size >= 200)
          fail(
            429,
            "Too many unfinished transfers. Cancel or finish existing transfers.",
          );
        const space = await fsp.statfs(this.settings.receiveDir);
        if (
          Number(space.bavail) * Number(space.bsize) <
          body.size + 64 * 1024 * 1024
        )
          fail(507, "Not enough free disk space in your receiving folder.");
        const temporarySpace = await fsp.statfs(this.dataDir);
        if (
          Number(temporarySpace.bavail) * Number(temporarySpace.bsize) <
          body.size + 64 * 1024 * 1024
        )
          fail(507, "Not enough disk space for the temporary upload.");
        const device = this.devices.find((d) => d.id === session.deviceId);
        const u = {
          id: randomUUID(),
          name,
          originalName: body.name,
          size: body.size,
          offset: 0,
          modified: Number.isFinite(body.modified) ? body.modified : null,
          mime: String(body.mime || "").slice(0, 100),
          deviceId: device.id,
          device: device.name,
          direction: "receive",
          status: this.settings.autoAccept ? "Transferring" : "Waiting",
          speed: 0,
          created: Date.now(),
          updated: Date.now(),
        };
        await fsp.writeFile(this.partialPath(u.id), "", { flag: "wx" });
        this.uploads.set(u.id, u);
        await this.persist();
        this.changed();
        return json(res, u, 201);
      }
      const match = pathname.match(
        /^\/api\/uploads\/([a-f0-9-]{36})(?:\/(chunk|finish))?$/,
      );
      if (match) {
        const u = this.uploads.get(match[1]);
        if (!u || u.deviceId !== session.deviceId)
          fail(404, "Transfer not found.");
        if (req.method === "GET" && !match[2]) return json(res, u);
        if (req.method === "DELETE" && !match[2]) {
          await this.cancelUpload(u.id);
          return json(res, { ok: true });
        }
        if (u.status === "Waiting")
          fail(409, "Approve this incoming file on your PC.");
        if (req.method === "PUT" && match[2] === "chunk")
          return this.uploadChunk(req, res, u, session.key);
        if (req.method === "POST" && match[2] === "finish")
          return this.finishUpload(req, res, u, session.key);
      }
      if (pathname === "/api/zip" && req.method === "GET")
        return this.sendZIP(req, res, url, session);
      const file = pathname.match(
        /^\/api\/files\/([a-f0-9-]{36})\/(download|preview)$/,
      );
      if (file && req.method === "GET")
        return this.sendFile(req, res, file[1], file[2], session);
      fail(404, "Not found.");
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      fail(405, "Method not allowed.");
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      fail(400, "Invalid path.");
    }
    if (
      decoded.includes("..") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    )
      fail(403, "Invalid path.");
    const target = path.resolve(
      this.webDir,
      "." + (decoded === "/" ? "/index.html" : decoded),
    );
    if (!target.startsWith(path.resolve(this.webDir) + path.sep))
      fail(403, "Invalid path.");
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch {
      fail(404, "Not found.");
    }
    if (!stat.isFile()) fail(404, "Not found.");
    res.setHeader(
      "Content-Type",
      MIME[path.extname(target)] || "application/octet-stream",
    );
    res.setHeader("Content-Length", stat.size);
    if (req.method === "HEAD") return res.end();
    await pipeline(fs.createReadStream(target), res);
  }
  async approvePairing(id, accept) {
    const p = this.pending.get(id);
    if (!p || p.expires < Date.now()) fail(410, "Request expired.");
    p.status = accept ? "Approved" : "Denied";
    if (accept) {
      let device = this.devices.find((d) => d.id === p.knownDeviceId);
      if (device) {
        for (const [key, session] of this.sessions)
          if (session.deviceId === device.id) this.revokeSession(key);
        Object.assign(device, {
          name: p.name,
          ip: p.ip,
          approved: Date.now(),
          revoked: false,
        });
      } else {
        if (this.devices.length >= 500)
          this.devices = this.devices.filter((d) => !d.revoked);
        if (this.devices.length >= 500)
          fail(429, "Device limit reached. Revoke unused devices.");
        p.rawIdentity = token();
        device = {
          id: randomUUID(),
          name: p.name,
          ip: p.ip,
          approved: Date.now(),
          revoked: false,
          resumeHash: hash(p.rawIdentity),
        };
        this.devices.push(device);
      }
      p.rawToken = token();
      this.sessions.set(hash(p.rawToken), {
        deviceId: device.id,
        expires: Date.now() + SESSION_MS,
      });
      await this.persist();
    }
    this.changed();
  }
  revokeSession(key) {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    for (const ws of this.wss?.clients || [])
      if (ws.sessionKey === key) ws.close(4001, "Disconnected by PC");
    for (const [id, c] of this.inflight) if (c.sessionKey === key) c.abort();
    for (const d of this.downloads.values())
      if (d.sessionKey === key) d.abort?.();
    for (const c of this.previews.values()) if (c.sessionKey === key) c.abort();
    if (session) this.changed();
  }
  async revokeDevice(id) {
    const d = this.devices.find((d) => d.id === id);
    if (d) d.revoked = true;
    for (const [k, s] of this.sessions)
      if (s.deviceId === id) this.revokeSession(k);
    for (const p of this.pending.values())
      if (p.rawToken && this.sessions.get(hash(p.rawToken))?.deviceId === id)
        p.status = "Denied";
    await this.persist();
    this.changed();
  }
  async uploadChunk(req, res, u, sessionKey) {
    const offset = Number(req.headers["upload-offset"]),
      length = Number(req.headers["content-length"]),
      expected = req.headers["x-chunk-sha256"];
    if (!Number.isSafeInteger(offset) || offset !== u.offset)
      fail(409, "Offset changed. Resume from the server offset.");
    if (
      !Number.isSafeInteger(length) ||
      length <= 0 ||
      length > CHUNK_SIZE ||
      offset + length > u.size ||
      !/^[a-f0-9]{64}$/.test(expected || "")
    )
      fail(400, "Invalid chunk size or checksum.");
    if (
      this.inflight.has(u.id) ||
      this.inflight.size >= this.settings.maxConcurrent
    )
      fail(429, "Transfer slots are busy. Retry shortly.");
    const controller = new AbortController();
    controller.sessionKey = sessionKey;
    this.inflight.set(u.id, controller);
    let received = 0;
    const h = createHash("sha256"),
      started = Date.now();
    u.status = "Transferring";
    u.error = "";
    const meter = new Transform({
      transform: (chunk, _encoding, cb) => {
        received += chunk.length;
        if (received > length)
          return cb(new HttpError(413, "Chunk is too large."));
        h.update(chunk);
        u.liveOffset = offset + received;
        u.speed = received / Math.max((Date.now() - started) / 1000, 0.01);
        this.changed(false);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(
        req,
        meter,
        fs.createWriteStream(this.partialPath(u.id), {
          flags: "r+",
          start: offset,
        }),
        { signal: controller.signal },
      );
      if (received !== length || h.digest("hex") !== expected)
        fail(422, "Chunk checksum mismatch. Retry this transfer.");
      if (!this.sessions.has(sessionKey) || controller.signal.aborted)
        fail(401, "Device disconnected.");
      u.offset += received;
      u.liveOffset = u.offset;
      u.updated = Date.now();
      await this.persist();
      this.changed();
      json(res, { offset: u.offset });
    } catch (error) {
      await fsp.truncate(this.partialPath(u.id), offset).catch(() => {});
      u.offset = offset;
      u.liveOffset = offset;
      u.status = "Paused";
      u.speed = 0;
      u.error =
        error.status === 422
          ? error.message
          : "Connection interrupted. Reselect the original file and retry.";
      u.updated = Date.now();
      await this.persist();
      this.changed();
      if (!res.destroyed)
        json(res, { error: u.error, offset }, error.status || 409);
    } finally {
      this.inflight.delete(u.id);
    }
  }
  async finishUpload(req, res, u, sessionKey) {
    const body = await readJSON(req);
    if (u.offset !== u.size)
      fail(409, "File has missing bytes. Resume the upload.");
    if (!/^[a-f0-9]{64}$/.test(body.sha256 || ""))
      fail(400, "A SHA-256 checksum is required.");
    if (
      this.inflight.has(u.id) ||
      this.inflight.size >= this.settings.maxConcurrent
    )
      fail(429, "Transfer slots are busy.");
    const controller = new AbortController();
    controller.sessionKey = sessionKey;
    this.inflight.set(u.id, controller);
    let target;
    try {
      const actual = await fileHash(this.partialPath(u.id), controller.signal);
      if (actual !== body.sha256) {
        u.status = "Failed";
        u.error =
          "File integrity check failed. Cancel and send the original file again.";
        this.changed();
        await this.persist();
        fail(422, u.error);
      }
      if (!this.sessions.has(sessionKey) || controller.signal.aborted)
        fail(401, "Device disconnected.");
      const ext = path.extname(u.name),
        base = path.basename(u.name, ext);
      let fd;
      for (let n = 0; n < 10000; n++) {
        target = path.join(
          this.settings.receiveDir,
          n ? `${base} (${n})${ext}` : u.name,
        );
        try {
          fd = await fsp.open(target, "wx");
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      if (!fd) fail(409, "Too many files with this name. Choose another name.");
      try {
        await pipeline(
          fs.createReadStream(this.partialPath(u.id)),
          fd.createWriteStream(),
          { signal: controller.signal },
        );
      } catch (error) {
        await fd.close().catch(() => {});
        await fsp.unlink(target).catch(() => {});
        throw error;
      }
      if (u.modified && u.modified > 0)
        await fsp
          .utimes(target, new Date(), new Date(u.modified))
          .catch(() => {});
      const record = {
        ...u,
        name: path.basename(target),
        path: target,
        sha256: actual,
        status: "Completed",
        speed: 0,
        completed: Date.now(),
        error: "",
      };
      this.uploads.delete(u.id);
      this.history.unshift(record);
      this.history = this.history.slice(0, 500);
      await this.persist();
      await fsp.unlink(this.partialPath(u.id)).catch(() => {});
      this.emit("received", record);
      this.changed();
      json(res, { ...record, path: undefined });
    } catch (error) {
      u.status = "Failed";
      u.error =
        error.message ||
        "Could not save file. Retry after checking disk space.";
      u.speed = 0;
      await this.persist();
      this.changed();
      throw error;
    } finally {
      this.inflight.delete(u.id);
    }
  }
  async cancelUpload(id) {
    const u = this.uploads.get(id);
    if (!u) return;
    this.inflight.get(id)?.abort();
    // Wait until the chunk/finalization releases its handle before unlinking on Windows.
    const until = Date.now() + 10000;
    while (this.inflight.has(id) && Date.now() < until)
      await new Promise((r) => setTimeout(r, 25));
    if (this.inflight.has(id))
      fail(409, "Transfer is still closing. Try cancel again.");
    if (!this.uploads.has(id)) return;
    this.uploads.delete(id);
    await fsp.unlink(this.partialPath(id)).catch(() => {});
    this.history.unshift({
      ...u,
      status: "Canceled",
      speed: 0,
      completed: Date.now(),
    });
    this.history = this.history.slice(0, 500);
    await this.persist();
    this.changed();
  }
  async approveUpload(id) {
    const u = this.uploads.get(id);
    if (u) {
      u.status = "Transferring";
      await this.persist();
      this.changed();
    }
  }
  async addShares(paths) {
    if (
      !Array.isArray(paths) ||
      paths.length > 1000 ||
      this.shares.length + paths.length > 2000
    )
      fail(400, "Select up to 1,000 files; the share shelf holds 2,000.");
    for (const filename of paths) {
      if (typeof filename !== "string" || !path.isAbsolute(filename))
        fail(400, "Select a local file.");
      const resolved = await fsp.realpath(filename),
        stat = await fsp.stat(resolved);
      if (!stat.isFile())
        fail(400, "Folders cannot be shared. Select files inside the folder.");
      if (this.shares.some((s) => s.path === resolved)) continue;
      this.shares.push({
        id: randomUUID(),
        path: resolved,
        name: path.basename(resolved),
        size: stat.size,
        modified: stat.mtimeMs,
        created: Date.now(),
        mime:
          MIME[path.extname(resolved).toLowerCase()] ||
          "application/octet-stream",
      });
    }
    await this.persist();
    this.changed();
  }
  async removeShare(id) {
    this.shares = this.shares.filter((s) => s.id !== id);
    await this.persist();
    this.changed();
  }
  async availableShare(id) {
    const share = this.shares.find((s) => s.id === id);
    if (!share) fail(404, "This file is no longer shared.");
    try {
      const stat = await fsp.stat(share.path);
      if (
        !stat.isFile() ||
        stat.size !== share.size ||
        stat.mtimeMs !== share.modified
      )
        fail(409, "File changed on your PC. Remove it and share it again.");
    } catch (e) {
      if (e.status) throw e;
      fail(404, "File moved or removed on your PC.");
    }
    return share;
  }
  beginDownload(session, name, size) {
    if (this.downloads.size >= this.settings.maxConcurrent)
      fail(429, "Download slots are busy. Try again shortly.");
    const d = {
      id: randomUUID(),
      name,
      size,
      offset: 0,
      direction: "send",
      status: "Transferring",
      deviceId: session.deviceId,
      device: this.devices.find((d) => d.id === session.deviceId)?.name,
      created: Date.now(),
      speed: 0,
      sessionKey: session.key,
    };
    this.downloads.set(d.id, d);
    this.changed();
    return d;
  }
  downloadMeter(d) {
    return new Transform({
      transform: (chunk, _enc, cb) => {
        d.offset += chunk.length;
        d.speed = d.offset / Math.max((Date.now() - d.created) / 1000, 0.01);
        this.changed(false);
        cb(null, chunk);
      },
    });
  }
  async completeDownload(d, status) {
    this.downloads.delete(d.id);
    const { sessionKey, abort, ...record } = d;
    this.history.unshift({
      ...record,
      status,
      completed: Date.now(),
      speed: 0,
    });
    this.history = this.history.slice(0, 500);
    await this.persist();
    this.changed();
  }
  async sendFile(req, res, id, mode, session) {
    const share = await this.availableShare(id);
    const preview = mode === "preview";
    if (
      preview &&
      !/^image\/(png|jpeg|webp)$|^video\/(mp4|quicktime)$/.test(share.mime)
    )
      fail(415, "Preview not supported. Download this file to open it.");
    let start = 0,
      end = share.size - 1;
    if (req.headers.range && share.size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!m) fail(416, "Unsupported range.");
      if (!m[1]) {
        start = Math.max(0, share.size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2]) end = Math.min(end, Number(m[2]));
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= share.size
      ) {
        res.setHeader("Content-Range", `bytes */${share.size}`);
        fail(416, "Invalid range.");
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${share.size}`);
    }
    const size = share.size ? end - start + 1 : 0;
    const d = preview ? null : this.beginDownload(session, share.name, size);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader(
      "Content-Type",
      preview ? share.mime : "application/octet-stream",
    );
    res.setHeader("Content-Length", size);
    res.setHeader(
      "Content-Disposition",
      `${preview ? "inline" : "attachment"}; filename="${share.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(share.name).replace(/'/g, "%27")}`,
    );
    const controller = new AbortController();
    if (d) d.abort = () => controller.abort();
    const previewId = randomUUID();
    if (preview) {
      if (this.previews.size >= 12) fail(429, "Too many previews.");
      controller.sessionKey = session.key;
      this.previews.set(previewId, controller);
    }
    const source = fs.createReadStream(
      share.path,
      share.size ? { start, end } : {},
    );
    try {
      if (d)
        await pipeline(source, this.downloadMeter(d), res, {
          signal: controller.signal,
        });
      else await pipeline(source, res, { signal: controller.signal });
      if (d) await this.completeDownload(d, "Completed");
    } catch {
      if (d) await this.completeDownload(d, "Canceled");
      res.destroy();
    } finally {
      if (preview) this.previews.delete(previewId);
    }
  }
  async sendZIP(req, res, url, session) {
    const ids = [
      ...new Set(
        (url.searchParams.get("ids") || "").split(",").filter(Boolean),
      ),
    ];
    if (!ids.length || ids.length > 200)
      fail(400, "Select between 1 and 200 files for a ZIP.");
    const files = [];
    for (const id of ids) files.push(await this.availableShare(id));
    const d = this.beginDownload(
      session,
      `DropBridge · ${files.length} files.zip`,
      files.reduce((n, f) => n + f.size, 0),
    );
    d.zip = true;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="DropBridge-files.zip"',
    );
    const archive = archiver("zip", { zlib: { level: 0 }, forceZip64: true });
    const controller = new AbortController();
    d.abort = () => {
      archive.abort();
      controller.abort();
    };
    const used = new Set();
    for (const file of files) {
      const ext = path.extname(file.name),
        base = path.basename(file.name, ext);
      let name = file.name,
        n = 1;
      while (used.has(name.toLowerCase())) name = `${base} (${n++})${ext}`;
      used.add(name.toLowerCase());
      archive.file(file.path, { name, date: new Date(file.modified) });
    }
    const sent = pipeline(archive, this.downloadMeter(d), res, {
      signal: controller.signal,
    });
    try {
      await Promise.all([archive.finalize(), sent]);
      await this.completeDownload(d, "Completed");
    } catch {
      archive.abort();
      await this.completeDownload(d, "Canceled");
      res.destroy();
    }
  }
  async updateSettings(patch) {
    const allowed = [
      "deviceName",
      "receiveDir",
      "maxConcurrent",
      "maxFileGB",
      "notifications",
      "autoAccept",
      "theme",
      "launchAtLogin",
      "adapter",
    ];
    const next = { ...this.settings };
    for (const k of allowed) if (k in patch) next[k] = patch[k];
    if (
      typeof next.deviceName !== "string" ||
      !next.deviceName.trim() ||
      next.deviceName.length > 60
    )
      fail(400, "Device name must contain 1–60 characters.");
    if (
      !Number.isInteger(next.maxConcurrent) ||
      next.maxConcurrent < 1 ||
      next.maxConcurrent > 6
    )
      fail(400, "Choose 1–6 simultaneous transfers.");
    if (
      !Number.isInteger(next.maxFileGB) ||
      next.maxFileGB < 1 ||
      next.maxFileGB > 100
    )
      fail(400, "File limit must be 1–100 GB.");
    if (
      typeof next.receiveDir !== "string" ||
      !path.isAbsolute(next.receiveDir)
    )
      fail(400, "Choose an absolute receiving folder.");
    for (const k of ["notifications", "autoAccept", "launchAtLogin"])
      if (typeof next[k] !== "boolean") fail(400, "Invalid setting.");
    if (!["dark", "light", "system"].includes(next.theme))
      fail(400, "Invalid theme.");
    if (
      next.adapter &&
      !networkAdapters().some((a) => a.address === next.adapter)
    )
      fail(400, "Adapter is no longer available.");
    if (next.receiveDir !== this.settings.receiveDir && this.uploads.size)
      fail(
        409,
        "Finish or cancel incoming transfers before changing the receiving folder.",
      );
    await fsp.mkdir(next.receiveDir, { recursive: true });
    await fsp.access(next.receiveDir, fs.constants.W_OK);
    this.settings = next;
    await this.persist();
    this.changed();
  }
  async clearHistory() {
    this.history = [];
    await this.persist();
    this.changed();
  }
  knownPath(id, kind) {
    const item =
      kind === "share"
        ? this.shares.find((s) => s.id === id)
        : this.history.find(
            (s) =>
              s.id === id &&
              s.status === "Completed" &&
              s.direction === "receive",
          );
    if (!item?.path) fail(404, "File not found.");
    return item.path;
  }
  async storage() {
    const stat = await fsp.statfs(this.settings.receiveDir);
    return {
      free: Number(stat.bavail) * Number(stat.bsize),
      total: Number(stat.blocks) * Number(stat.bsize),
    };
  }
}
