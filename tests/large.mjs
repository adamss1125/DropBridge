import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { CHUNK_SIZE } from "../server/service.mjs";
import { fixture, pair, request, chunk } from "./helpers.mjs";
test(
  "generated 1 GiB upload and download verify bytes with bounded memory",
  { timeout: 300000 },
  async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const s = f.service,
      c = await pair(s);
    const size = 1024 ** 3;
    const bytes = Buffer.alloc(CHUNK_SIZE);
    for (let n = 0; n < bytes.length; n++) bytes[n] = (n * 31 + 17) % 251;
    const response = await request(s, "/uploads", {
      method: "POST",
      cookie: c,
      body: { name: "generated-1GiB.bin", size },
    });
    assert.equal(response.status, 201);
    const u = await response.json();
    const expected = createHash("sha256");
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      expected.update(bytes);
      const r = await chunk(s, c, u.id, bytes, offset);
      assert.equal(r.status, 200);
      await r.json();
      peak = Math.max(peak, process.memoryUsage().rss);
      if (offset % (256 * 1024 ** 2) === 0)
        console.log(`Uploaded ${offset / 1024 ** 2} MiB`);
    }
    const digest = expected.digest("hex");
    const finished = await request(s, `/uploads/${u.id}/finish`, {
      method: "POST",
      cookie: c,
      body: { sha256: digest },
    });
    assert.equal(finished.status, 200, await finished.clone().text());
    const record = s.history[0];
    const actual = createHash("sha256");
    for await (const b of fs.createReadStream(record.path)) actual.update(b);
    assert.equal(actual.digest("hex"), digest);
    await s.addShares([record.path]);
    const down = await request(s, `/files/${s.shares[0].id}/download`, {
      cookie: c,
    });
    const downloaded = createHash("sha256");
    let received = 0;
    for await (const b of down.body) {
      downloaded.update(b);
      received += b.length;
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    assert.equal(received, size);
    assert.equal(downloaded.digest("hex"), digest);
    assert.ok(
      peak - baseline < 400 * 1024 ** 2,
      `Memory growth too high: ${(peak - baseline) / 1024 ** 2} MiB`,
    );
    console.log(
      JSON.stringify({
        bytes: received,
        sha256: digest,
        baselineMiB: Math.round(baseline / 1024 ** 2),
        peakMiB: Math.round(peak / 1024 ** 2),
      }),
    );
  },
);
