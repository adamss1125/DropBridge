import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import {
  DropBridgeService,
  CHUNK_SIZE,
  safeFilename,
} from "../server/service.mjs";
import { networkAdapters, isPrivateIPv4 } from "../server/network.mjs";
import {
  fixture,
  request,
  pair,
  upload,
  createUpload,
  chunk,
  digest,
} from "./helpers.mjs";

test("private address selection prefers physical Wi-Fi over virtual adapters", () => {
  const addr = (address) => [{ address, family: "IPv4", internal: false }];
  const list = networkAdapters({
    "vEthernet (WSL)": addr("172.20.1.2"),
    Ethernet: addr("192.168.1.3"),
    "Wi-Fi": addr("192.168.1.4"),
    Public: addr("8.8.8.8"),
  });
  assert.equal(list[0].name, "Wi-Fi");
  assert.equal(list[2].virtual, true);
  assert.equal(list.length, 3);
  assert.equal(isPrivateIPv4("172.31.4.1"), true);
  assert.equal(isPrivateIPv4("172.32.4.1"), false);
  assert.equal(isPrivateIPv4("10.0.0.999"), false);
});
test("filenames reject traversal and safely handle Windows reserved characters", () => {
  for (const name of [
    "../escape",
    "..\\escape",
    "/absolute",
    "a\0b",
    ".",
    "..",
    "",
  ])
    assert.throws(() => safeFilename(name));
  assert.equal(safeFilename("CON.txt"), "_CON.txt");
  assert.equal(safeFilename("photo?.heic"), "photo_.heic");
  assert.equal(safeFilename("žąsis.MOV"), "žąsis.MOV");
  assert.match(safeFilename("a".repeat(250) + ".mp4"), /\.mp4$/);
});
test("unauthorized requests cannot access state, downloads, uploads, or websocket", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const route of [
    "/state",
    "/files/00000000-0000-0000-0000-000000000000/download",
    "/zip?ids=x",
  ])
    assert.equal((await request(f.service, route)).status, 401);
  assert.equal(
    (
      await request(f.service, "/uploads", {
        method: "POST",
        body: { name: "a", size: 0 },
      })
    ).status,
    401,
  );
  const ws = new WebSocket(f.service.url.replace("http", "ws") + "/ws");
  const error = await new Promise((resolve) => ws.on("error", resolve));
  assert.match(error.message, /401/);
});
test("host, origin, and cross-site protections reject remote websites", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const hostStatus = await new Promise((resolve) => {
    const req = http.get(
      f.service.url + "/api/info",
      { headers: { Host: "evil.test" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", (e) => {
      throw e;
    });
  });
  assert.equal(hostStatus, 403);
  assert.equal(
    (
      await request(f.service, "/info", {
        headers: { Origin: "http://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(f.service, "/info", {
        headers: { "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request(f.service, "/info", { headers: { Origin: f.service.url } }))
      .status,
    200,
  );
});
test("pairing needs live code, a valid ticket, and explicit desktop approval", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const s = f.service;
  assert.equal(
    (await request(s, "/pair", { method: "POST", body: { code: "wrong" } }))
      .status,
    403,
  );
  const pending = await (
    await request(s, "/pair", {
      method: "POST",
      body: { code: s.pairCode, name: "Phone" },
    })
  ).json();
  assert.equal(
    (
      await request(s, "/pair/status", {
        method: "POST",
        body: { ...pending, ticket: "forged" },
      })
    ).status,
    410,
  );
  assert.equal(
    (
      await (
        await request(s, "/pair/status", { method: "POST", body: pending })
      ).json()
    ).status,
    "Waiting",
  );
  await s.approvePairing(pending.id, false);
  assert.equal(
    (
      await (
        await request(s, "/pair/status", { method: "POST", body: pending })
      ).json()
    ).status,
    "Denied",
  );
  s.pairExpires = 0;
  assert.equal(
    (await request(s, "/pair", { method: "POST", body: { code: s.pairCode } }))
      .status,
    403,
  );
});
test("approval issues HttpOnly expiring cookies and revocation immediately closes websocket", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const cookie = await pair(f.service);
  const ws = new WebSocket(f.service.url.replace("http", "ws") + "/ws", {
    headers: { Cookie: cookie, Origin: f.service.url },
  });
  const message = once(ws, "message");
  await once(ws, "open");
  const [data] = await message;
  const state = JSON.parse(data.toString());
  assert.equal(state.running, true);
  assert.equal(state.settings, undefined);
  const closed = once(ws, "close");
  await f.service.revokeDevice(f.service.devices[0].id);
  const [code] = await closed;
  assert.equal(code, 4001);
  assert.equal((await request(f.service, "/state", { cookie })).status, 401);
});
test("session expiry blocks access", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const cookie = await pair(f.service);
  for (const s of f.service.sessions.values()) s.expires = 0;
  assert.equal((await request(f.service, "/state", { cookie })).status, 401);
});
test("upload preserves bytes, Unicode filename, modification time and full SHA-256", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const cookie = await pair(f.service);
  const bytes = Buffer.from("Original bytes, metadata and extensions: 🦋");
  const r = await upload(f.service, cookie, "žąsis.HEIC", bytes);
  assert.equal(r.status, "Completed");
  assert.equal(r.sha256, digest(bytes));
  assert.equal(r.path, undefined);
  const saved = path.join(f.service.settings.receiveDir, "žąsis.HEIC");
  assert.deepEqual(await fs.readFile(saved), bytes);
  assert.ok(Math.abs((await fs.stat(saved)).mtimeMs - 1700000000000) < 10);
  assert.equal((await fs.readdir(f.service.partDir)).length, 0);
  assert.equal(f.service.history[0].path, saved);
});
test("duplicate filenames never overwrite existing bytes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service);
  await upload(f.service, c, "IMG_0001.JPG", Buffer.from("one"));
  const r = await upload(f.service, c, "IMG_0001.JPG", Buffer.from("two"));
  assert.equal(r.name, "IMG_0001 (1).JPG");
  assert.equal(
    await fs.readFile(
      path.join(f.service.settings.receiveDir, "IMG_0001.JPG"),
      "utf8",
    ),
    "one",
  );
});
test("empty file transfers and malformed/oversized metadata", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service);
  await upload(f.service, c, "empty.txt", Buffer.alloc(0));
  for (const body of [
    { name: "../escape", size: 1 },
    { name: "large.mov", size: 101 * 1024 ** 3 },
    { name: "a", size: -1 },
    { name: "a", size: 1.5 },
  ])
    assert.ok(
      (
        await request(f.service, "/uploads", {
          method: "POST",
          cookie: c,
          body,
        })
      ).status >= 400,
    );
});
test("wrong chunk checksum rolls back and correct retry resumes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service),
    data = Buffer.from("checksum");
  const u = await createUpload(f.service, c, "checksum.txt", data);
  assert.equal(
    (await chunk(f.service, c, u.id, data, 0, "0".repeat(64))).status,
    422,
  );
  assert.equal((await fs.stat(f.service.partialPath(u.id))).size, 0);
  assert.equal(f.service.uploads.get(u.id).offset, 0);
  assert.equal((await chunk(f.service, c, u.id, data)).status, 200);
  assert.equal(
    (
      await request(f.service, `/uploads/${u.id}/finish`, {
        method: "POST",
        cookie: c,
        body: { sha256: digest(data) },
      })
    ).status,
    200,
  );
});
test("final checksum mismatch prevents saving and offset mismatches reject", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service),
    data = Buffer.from("one");
  const u = await createUpload(f.service, c, "checksum.txt", data);
  assert.equal((await chunk(f.service, c, u.id, data, 1)).status, 409);
  await chunk(f.service, c, u.id, data);
  assert.equal(
    (
      await request(f.service, `/uploads/${u.id}/finish`, {
        method: "POST",
        cookie: c,
        body: { sha256: "0".repeat(64) },
      })
    ).status,
    422,
  );
  assert.equal((await fs.readdir(f.service.settings.receiveDir)).length, 0);
});
test("cancel removes partial bytes, records status, and keeps unrelated files", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service);
  const u = await createUpload(f.service, c, "cancel.mov", Buffer.alloc(10));
  await chunk(f.service, c, u.id, Buffer.alloc(5));
  assert.equal(
    (
      await request(f.service, `/uploads/${u.id}`, {
        method: "DELETE",
        cookie: c,
      })
    ).status,
    200,
  );
  assert.equal(f.service.uploads.size, 0);
  assert.equal((await fs.readdir(f.service.partDir)).length, 0);
  assert.equal(f.service.history[0].status, "Canceled");
});
test("an interrupted chunk is truncated to committed offset and resumes", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service);
  const u = await createUpload(
    f.service,
    c,
    "interrupted.bin",
    Buffer.alloc(CHUNK_SIZE),
  );
  await new Promise((resolve) => {
    const req = http.request(`${f.service.url}/api/uploads/${u.id}/chunk`, {
      method: "PUT",
      headers: {
        Cookie: c,
        "Content-Length": CHUNK_SIZE,
        "Upload-Offset": "0",
        "X-Chunk-SHA256": digest(Buffer.alloc(CHUNK_SIZE)),
      },
    });
    req.on("error", () => resolve());
    req.write(Buffer.alloc(65536));
    setTimeout(() => req.destroy(), 80);
  });
  while (f.service.inflight.size) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await fs.stat(f.service.partialPath(u.id))).size, 0);
  assert.equal(f.service.uploads.get(u.id).offset, 0);
  assert.equal(
    (await chunk(f.service, c, u.id, Buffer.alloc(CHUNK_SIZE))).status,
    200,
  );
});
test("manual transfer approval stops bytes until accepted", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service);
  await f.service.updateSettings({ autoAccept: false });
  const data = Buffer.from("approval");
  const u = await createUpload(f.service, c, "approved.txt", data);
  assert.equal(u.status, "Waiting");
  assert.equal((await chunk(f.service, c, u.id, data)).status, 409);
  await f.service.approveUpload(u.id);
  assert.equal((await chunk(f.service, c, u.id, data)).status, 200);
});
test("a second approved device cannot inspect or modify another device upload", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c1 = await pair(f.service),
    c2 = await pair(f.service, "", "Other device");
  const u = await createUpload(f.service, c1, "private.bin", Buffer.from("a"));
  assert.equal(
    (await request(f.service, `/uploads/${u.id}`, { cookie: c2 })).status,
    404,
  );
  assert.equal(
    (
      await request(f.service, `/uploads/${u.id}`, {
        method: "DELETE",
        cookie: c2,
      })
    ).status,
    404,
  );
  const state = await (
    await request(f.service, "/state", { cookie: c2 })
  ).json();
  assert.equal(state.transfers.length, 0);
});
test("shared downloads, byte ranges, ZIP, and filesystem confinement", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service);
  const filename = path.join(f.root, "shared.txt");
  await fs.writeFile(filename, "abcdefghij");
  await f.service.addShares([filename]);
  const id = f.service.shares[0].id;
  const normal = await request(f.service, `/files/${id}/download`, {
    cookie: c,
  });
  assert.equal(normal.status, 200);
  assert.equal(await normal.text(), "abcdefghij");
  assert.match(normal.headers.get("content-disposition"), /attachment/);
  const range = await request(f.service, `/files/${id}/download`, {
    cookie: c,
    headers: { Range: "bytes=2-5" },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "cdef");
  const suffix = await request(f.service, `/files/${id}/download`, {
    cookie: c,
    headers: { Range: "bytes=-3" },
  });
  assert.equal(await suffix.text(), "hij");
  assert.equal(
    (
      await request(f.service, `/files/${id}/download`, {
        cookie: c,
        headers: { Range: "bytes=999-" },
      })
    ).status,
    416,
  );
  const zip = await request(f.service, `/zip?ids=${id}`, { cookie: c });
  assert.equal(zip.status, 200);
  const zipBytes = Buffer.from(await zip.arrayBuffer());
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);
  assert.ok(zipBytes.includes(Buffer.from("shared.txt")));
  assert.ok(zipBytes.includes(Buffer.from("abcdefghij")));
  const state = await (
    await request(f.service, "/state", { cookie: c })
  ).json();
  assert.equal(state.shares[0].path, undefined);
  assert.equal(JSON.stringify(state).includes(f.root), false);
  assert.doesNotThrow(() => structuredClone(f.service.desktopState()));
  assert.equal(
    (await request(f.service, "/files/not-a-shared-id/download", { cookie: c }))
      .status,
    404,
  );
  assert.equal(
    (await fetch(f.service.url + "/%2e%2e%5cpackage.json")).status,
    403,
  );
  await fs.writeFile(filename, "changed");
  assert.equal(
    (await request(f.service, `/files/${id}/download`, { cookie: c })).status,
    409,
  );
});
test("restart remembers settings, shared files/history/partials and requires fresh approval", async (t) => {
  const f = await fixture();
  let s = f.service;
  t.after(async () => {
    await s.stop();
    await fs.rm(f.root, { recursive: true, force: true });
  });
  const c = await pair(s);
  await s.updateSettings({ deviceName: "My PC", maxConcurrent: 2 });
  await upload(s, c, "done.txt", Buffer.from("done"));
  const data = Buffer.from("resume after restart");
  const u = await createUpload(s, c, "resume.txt", data);
  await chunk(s, c, u.id, data);
  await s.stop();
  s = await new DropBridgeService(f.options).init();
  await s.start();
  assert.equal(s.settings.deviceName, "My PC");
  assert.equal(s.history[0].status, "Completed");
  assert.equal(s.uploads.get(u.id).offset, data.length);
  assert.equal((await request(s, "/state", { cookie: c })).status, 401);
  const reapproved = await pair(s, c);
  assert.equal(
    (await request(s, `/uploads/${u.id}`, { cookie: reapproved })).status,
    200,
  );
  assert.equal(
    (
      await request(s, `/uploads/${u.id}/finish`, {
        method: "POST",
        cookie: reapproved,
        body: { sha256: digest(data) },
      })
    ).status,
    200,
  );
  await s.clearHistory();
  assert.equal(
    await fs.readFile(path.join(s.settings.receiveDir, "done.txt"), "utf8"),
    "done",
  );
});
test("expired partials are cleaned and pairing attempts are rate limited", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service);
  const u = await createUpload(f.service, c, "stale.bin", Buffer.alloc(1));
  f.service.uploads.get(u.id).updated = 0;
  await f.service.maintenance();
  assert.equal(f.service.uploads.size, 0);
  assert.equal((await fs.readdir(f.service.partDir)).length, 0);
  for (let n = 0; n < 10; n++)
    await request(f.service, "/pair", {
      method: "POST",
      body: { code: "bad" },
    });
  assert.equal(
    (
      await request(f.service, "/pair", {
        method: "POST",
        body: { code: "bad" },
      })
    ).status,
    429,
  );
});
test("many photos with three concurrent workers preserve integrity and collision names", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const c = await pair(f.service);
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < 60) {
        const n = next++;
        const bytes = Buffer.alloc(32768, n);
        const r = await upload(f.service, c, `photo-${n % 10}.jpg`, bytes);
        assert.equal(r.sha256, digest(bytes));
      }
    }),
  );
  assert.equal(f.service.history.length, 60);
  assert.equal((await fs.readdir(f.service.settings.receiveDir)).length, 60);
  assert.equal(f.service.uploads.size, 0);
});
