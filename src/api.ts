import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Transfer } from "./types";

export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api" + url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = await response.json();
  if (!response.ok)
    throw new APIError(data.error || "Request failed.", response.status);
  return data;
}
export interface UploadJob {
  key: string;
  file: File;
  id?: string;
  status: string;
  offset: number;
  speed: number;
  error?: string;
  controller?: AbortController;
}
const delay = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Paused", "AbortError"));
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Paused", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });

function sendChunk(
  job: UploadJob,
  start: number,
  bytes: Uint8Array,
  checksum: string,
  signal: AbortSignal,
  update: () => void,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const xhr = new XMLHttpRequest();
    const began = performance.now();
    xhr.open("PUT", `/api/uploads/${job.id}/chunk`);
    xhr.timeout = 120000;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("Upload-Offset", String(start));
    xhr.setRequestHeader("X-Chunk-SHA256", checksum);
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.upload.onprogress = (e) => {
      job.offset = start + e.loaded;
      job.speed = e.loaded / Math.max((performance.now() - began) / 1000, 0.01);
      update();
    };
    xhr.onload = () => {
      cleanup();
      try {
        resolve({ status: xhr.status, data: JSON.parse(xhr.responseText) });
      } catch {
        reject(
          new Error(
            "The PC returned an unreadable response. Retry the transfer.",
          ),
        );
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(
        new Error(
          "Connection interrupted. Keep Safari open, reconnect, and retry.",
        ),
      );
    };
    xhr.ontimeout = () => {
      cleanup();
      reject(
        new Error("This chunk timed out. Retry when your Wi-Fi is stable."),
      );
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Paused", "AbortError"));
    };
    xhr.send(bytes as unknown as XMLHttpRequestBodyInit);
  });
}

export async function uploadFile(
  job: UploadJob,
  chunkSize: number,
  update: () => void,
) {
  const controller = new AbortController();
  job.controller = controller;
  job.status = "Transferring";
  job.error = "";
  update();
  let transfer: Transfer;
  try {
    if (job.id) {
      try {
        transfer = await api(
          "/uploads/" + job.id,
          undefined,
          "GET",
          controller.signal,
        );
      } catch (error) {
        if (error instanceof APIError && error.status === 404) {
          const state = await api(
            "/state",
            undefined,
            "GET",
            controller.signal,
          );
          const completed = state.transfers.find(
            (t: Transfer) => t.id === job.id && t.status === "Completed",
          );
          if (completed) {
            job.status = "Completed";
            job.offset = job.file.size;
            job.speed = 0;
            return;
          }
        }
        throw error;
      }
    } else {
      transfer = await api(
        "/uploads",
        {
          name: job.file.name,
          size: job.file.size,
          modified: job.file.lastModified,
          mime: job.file.type,
        },
        "POST",
        controller.signal,
      );
      job.id = transfer.id;
    }
    while (transfer.status === "Waiting") {
      job.status = "Waiting for PC approval";
      update();
      await delay(1500, controller.signal);
      transfer = await api(
        "/uploads/" + job.id,
        undefined,
        "GET",
        controller.signal,
      );
    }
    job.status = "Transferring";
    job.offset = transfer.offset;
    update();
    const fullHash = sha256.create();
    // Each slice is bounded. Hash the retained prefix too, so a resumed file is verified in full.
    for (let start = 0; start < job.file.size; start += chunkSize) {
      controller.signal.throwIfAborted();
      const bytes = new Uint8Array(
        await job.file.slice(start, start + chunkSize).arrayBuffer(),
      );
      fullHash.update(bytes);
      if (start + bytes.length <= transfer.offset) continue;
      if (start < transfer.offset)
        throw new Error(
          "The retained offset is invalid. Cancel and send this file again.",
        );
      const chunkHash = bytesToHex(sha256(bytes));
      let response: { status: number; data: any } | undefined;
      const started = performance.now();
      for (let retry = 0; retry < 6; retry++) {
        response = await sendChunk(
          job,
          start,
          bytes,
          chunkHash,
          controller.signal,
          update,
        );
        if (response.status !== 429) break;
        await delay(600 + retry * 300, controller.signal);
      }
      const data = response!.data;
      if (response!.status !== 200)
        throw new APIError(data.error, response!.status);
      job.offset = data.offset;
      job.speed =
        bytes.length / Math.max((performance.now() - started) / 1000, 0.01);
      update();
    }
    job.status = "Verifying";
    update();
    let result: Transfer | undefined;
    const digest = bytesToHex(fullHash.digest());
    for (let retry = 0; retry < 6; retry++) {
      try {
        result = await api(
          "/uploads/" + job.id + "/finish",
          { sha256: digest },
          "POST",
          controller.signal,
        );
        break;
      } catch (e) {
        if (e instanceof APIError && e.status === 429) {
          await delay(800, controller.signal);
          continue;
        }
        throw e;
      }
    }
    if (!result) throw new Error("PC is busy verifying files. Retry shortly.");
    job.status = "Completed";
    job.offset = job.file.size;
    job.speed = 0;
  } catch (error) {
    if (job.status !== "Canceled") {
      job.status = controller.signal.aborted ? "Paused" : "Failed";
      job.error = controller.signal.aborted
        ? "Paused. Tap retry to continue."
        : error instanceof Error
          ? error.message
          : "Connection interrupted. Retry when connected.";
    }
    job.speed = 0;
  } finally {
    job.controller = undefined;
    update();
  }
}
