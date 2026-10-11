import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DropBridgeService, CHUNK_SIZE } from "../server/service.mjs";
export const digest = (b) => createHash("sha256").update(b).digest("hex");
export async function fixture() {
  const base = path.resolve(".test-data");
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, "dropbridge-test-"));
  const options = {
    dataDir: path.join(root, "data"),
    receiveDir: path.join(root, "received"),
    webDir: path.resolve("dist"),
    host: "127.0.0.1",
    port: 0,
  };
  const service = await new DropBridgeService(options).init();
  await service.start();
  return {
    root,
    options,
    service,
    async close() {
      await service.stop();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 150,
      });
    },
  };
}
export async function request(
  s,
  route,
  { method = "GET", body, cookie = "", headers = {} } = {},
) {
  return fetch(s.url + "/api" + route, {
    method,
    headers: {
      Cookie: cookie,
      ...(body && !(body instanceof Uint8Array)
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
    body:
      body instanceof Uint8Array
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
}
export async function pair(s, priorCookie = "", name = "Test iPhone") {
  const response = await request(s, "/pair", {
    method: "POST",
    body: { code: s.pairCode, name },
    cookie: priorCookie,
  });
  assert.equal(response.status, 202);
  const pending = await response.json();
  await s.approvePairing(pending.id, true);
  const approved = await request(s, "/pair/status", {
    method: "POST",
    body: pending,
  });
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, "Approved");
  const cookies = approved.headers.getSetCookie().map((c) => c.split(";")[0]);
  const identity =
    cookies.find((c) => c.startsWith("db_identity=")) ||
    priorCookie
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("db_identity="));
  return [cookies.find((c) => c.startsWith("db_session=")), identity]
    .filter(Boolean)
    .join("; ");
}
export async function createUpload(
  s,
  cookie,
  name,
  bytes,
  modified = 1700000000000,
) {
  const response = await request(s, "/uploads", {
    method: "POST",
    cookie,
    body: { name, size: bytes.length, modified },
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}
export async function chunk(
  s,
  cookie,
  id,
  bytes,
  offset = 0,
  checksum = digest(bytes),
) {
  return request(s, `/uploads/${id}/chunk`, {
    method: "PUT",
    cookie,
    body: bytes,
    headers: {
      "Content-Type": "application/octet-stream",
      "Upload-Offset": String(offset),
      "X-Chunk-SHA256": checksum,
    },
  });
}
export async function upload(s, cookie, name, bytes) {
  const u = await createUpload(s, cookie, name, bytes);
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const response = await chunk(
      s,
      cookie,
      u.id,
      bytes.subarray(i, i + CHUNK_SIZE),
      i,
    );
    assert.equal(response.status, 200, await response.clone().text());
  }
  const response = await request(s, `/uploads/${u.id}/finish`, {
    method: "POST",
    cookie,
    body: { sha256: digest(bytes) },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
