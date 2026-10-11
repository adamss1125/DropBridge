import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Download,
  FileUp,
  ImagePlus,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Unplug,
  Wifi,
  X,
} from "lucide-react";
import { api, APIError, uploadFile, type UploadJob } from "./api";
import { Empty, FileIcon, size, TransferRow } from "./components";
import type { PublicState, SharedFile } from "./types";

export function Mobile() {
  const [state, setState] = useState<PublicState>();
  const [hostName, setHostName] = useState("your PC");
  const [connection, setConnection] = useState("Connecting");
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("pair") || "",
  );
  const [name, setName] = useState(
    /iPhone|iPad/i.test(navigator.userAgent)
      ? "My iPhone"
      : /Android/i.test(navigator.userAgent)
        ? "My Android"
        : /Macintosh/i.test(navigator.userAgent)
          ? "My Mac"
          : "My browser",
  );
  const [pairing, setPairing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<SharedFile>();
  const [previewError, setPreviewError] = useState(false);
  const [, setTick] = useState(0);
  const jobs = useRef<UploadJob[]>([]);
  const photos = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const socket = useRef<WebSocket | undefined>(undefined);
  const alive = useRef(false);
  const pollCancel = useRef<AbortController | undefined>(undefined);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const update = useCallback(() => setTick((n) => n + 1), []);
  const connect = useCallback(async () => {
    try {
      const next = await api<PublicState>("/state");
      if (!alive.current) return;
      setState(next);
      setHostName(next.deviceName);
      setAuthorized(true);
      setConnection("Connected");
      setError("");
      socket.current?.close();
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      socket.current = ws;
      ws.onmessage = (event) => {
        if (alive.current) {
          const next = JSON.parse(event.data);
          setState(next);
          setHostName(next.deviceName);
          setConnection("Connected");
        }
      };
      ws.onerror = () => {
        if (alive.current) setConnection("Reconnecting");
      };
      ws.onclose = (event) => {
        if (!alive.current || socket.current !== ws) return;
        if (event.code === 4001) {
          setAuthorized(false);
          setConnection("Pair again");
          jobs.current.forEach((j) => j.controller?.abort());
          setNotice(
            "Your access expired or was revoked. Request approval again.",
          );
        } else {
          setConnection("Reconnecting");
          reconnectTimer.current = setTimeout(() => connect(), 3000);
        }
      };
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof APIError && e.status === 401) {
        setAuthorized(false);
        setConnection("Pair your device");
      } else {
        setConnection("Offline");
        setError(
          "Cannot reach your PC. Use the same Wi-Fi, keep DropBridge open, and scan the current QR code if its address changed.",
        );
        reconnectTimer.current = setTimeout(() => connect(), 5000);
      }
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    api("/info")
      .then((info) => {
        if (alive.current) setHostName(info.deviceName);
      })
      .catch(() => {});
    connect();
    if (location.hash) history.replaceState(null, "", location.pathname);
    const online = () => connect();
    window.addEventListener("online", online);
    return () => {
      alive.current = false;
      socket.current?.close();
      clearTimeout(reconnectTimer.current);
      pollCancel.current?.abort();
      jobs.current.forEach((j) => j.controller?.abort());
      window.removeEventListener("online", online);
    };
  }, []);
  const pump = useCallback(() => {
    if (!authorized || !state) return;
    const running = jobs.current.filter((j) =>
      ["Transferring", "Verifying", "Waiting for PC approval"].includes(
        j.status,
      ),
    ).length;
    const queued = jobs.current
      .filter((j) => j.status === "Queued")
      .slice(0, Math.max(0, state.maxConcurrent - running));
    queued.forEach((job) => {
      job.status = "Transferring";
      uploadFile(job, state.chunkSize, update).finally(update);
    });
  }, [authorized, state?.maxConcurrent, state?.chunkSize, update]);
  useEffect(() => {
    pump();
  });
  const pair = async () => {
    setPairing(true);
    setError("");
    setNotice("");
    const controller = new AbortController();
    pollCancel.current?.abort();
    pollCancel.current = controller;
    try {
      const request = await api(
        "/pair",
        { code: code.replace(/\s/g, ""), name },
        "POST",
        controller.signal,
      );
      setNotice("Approve this device in DropBridge on your PC.");
      for (let n = 0; n < 80 && !controller.signal.aborted; n++) {
        await new Promise((r) => setTimeout(r, 1500));
        if (controller.signal.aborted) break;
        const result = await api(
          "/pair/status",
          request,
          "POST",
          controller.signal,
        );
        if (result.status === "Approved") {
          setNotice("");
          await connect();
          return;
        }
        if (result.status === "Denied")
          throw new Error(
            "Your PC declined this request. Try again if this was your device.",
          );
      }
      if (!controller.signal.aborted)
        throw new Error("Approval timed out. Request a fresh connection.");
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (alive.current) setPairing(false);
    }
  };
  const choose = (list: FileList | null) => {
    if (!list || !state) return;
    for (const file of Array.from(list)) {
      if (file.size > state.maxFileGB * 1024 ** 3) {
        setError(
          `${file.name} exceeds the ${state.maxFileGB} GB per-file limit.`,
        );
        continue;
      }
      const existing = jobs.current.find(
        (j) =>
          j.file.name === file.name &&
          j.file.size === file.size &&
          j.file.lastModified === file.lastModified &&
          ["Paused", "Failed"].includes(j.status),
      );
      if (existing) {
        existing.file = file;
        existing.status = "Queued";
        existing.error = "";
        continue;
      }
      const resumable = state.transfers.find(
        (t) =>
          !t.completed &&
          ["Paused", "Transferring", "Waiting"].includes(t.status) &&
          (t.originalName || t.name) === file.name &&
          t.size === file.size &&
          t.modified === file.lastModified &&
          !jobs.current.some((j) => j.id === t.id),
      );
      jobs.current.push({
        key: `${Date.now()}-${Math.random()}`,
        file,
        id: resumable?.id,
        offset: resumable?.offset || 0,
        speed: 0,
        status: "Queued",
      });
    }
    update();
    if (photos.current) photos.current.value = "";
    if (files.current) files.current.value = "";
  };
  const cancel = async (job: UploadJob) => {
    job.controller?.abort();
    job.status = "Canceled";
    update();
    if (job.id) {
      try {
        await api("/uploads/" + job.id, undefined, "DELETE");
      } catch (e) {
        job.status = "Failed";
        job.error = `Could not cancel on PC: ${(e as Error).message}`;
        update();
      }
    }
  };
  const download = async (ids: string[], zip = false) => {
    setError("");
    try {
      await api("/download/check", { ids });
      const a = document.createElement("a");
      a.href = zip
        ? "/api/zip?ids=" + ids.join(",")
        : `/api/files/${ids[0]}/download`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setNotice(
        "Download requested. Safari manages progress and saves to Files. Open the saved photo or video and use Share to save to Photos where supported.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const disconnect = async () => {
    try {
      await api("/logout", {});
      socket.current?.close();
      setAuthorized(false);
      setState(undefined);
      jobs.current.forEach((j) => j.controller?.abort());
      setConnection("Pair your device");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        <div className="brand">
          <div className="brand-symbol">↗</div>
          <span>DropBridge</span>
        </div>
        {authorized && (
          <button
            className="icon-button"
            title="Disconnect"
            aria-label="Disconnect"
            onClick={disconnect}
          >
            <Unplug size={18} />
          </button>
        )}
      </header>
      <main className="mobile-main">
        {error && (
          <div className="notice error" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {!authorized ? (
          <section className="mobile-pair">
            <div className="pair-hero">
              <Smartphone size={34} strokeWidth={1.5} />
              <Monitor size={34} strokeWidth={1.5} />
            </div>
            <span className="eyebrow">WELCOME TO YOUR BRIDGE</span>
            <h1>
              A short hop.
              <br />A simpler way.
            </h1>
            <p>
              Connect to <strong>{hostName}</strong> and move your files
              directly over Wi-Fi.
            </p>
            <label>
              Your device name
              <input
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label>
              Pairing code
              <input
                className="code-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000 000"
                value={code}
                maxLength={7}
                onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
              />
            </label>
            <button
              className="primary full-width"
              disabled={pairing || code.replace(/\s/g, "").length !== 6}
              onClick={pair}
            >
              {pairing ? "Waiting for PC approval…" : "Connect to my PC"}
              {!pairing && <ArrowUpRight size={18} />}
            </button>
            {pairing && (
              <button
                className="text-button centered"
                onClick={() => {
                  pollCancel.current?.abort();
                  setPairing(false);
                  setNotice("");
                }}
              >
                Cancel request
              </button>
            )}
            <p className="mobile-pair-hint">
              Find the code in the Windows app, or scan its current QR code.
              Both devices must be on the same private network.
            </p>
            <div className="quiet-note">
              <ShieldCheck size={15} />
              HTTP is unencrypted. Use trusted Wi-Fi.
            </div>
          </section>
        ) : (
          <>
            <div className="mobile-connected">
              <div className="device-avatar">
                <Monitor size={20} />
              </div>
              <div>
                <small>
                  {connection === "Connected"
                    ? "CONNECTED TO"
                    : connection.toUpperCase()}
                </small>
                <strong>{hostName}</strong>
              </div>
              <span
                className={`dot ${connection === "Connected" ? "online" : ""}`}
              />
            </div>
            {connection !== "Connected" && (
              <div className="notice warning">
                <Wifi size={17} />
                <span>
                  Connection interrupted. Keep your PC awake and both devices on
                  the same Wi-Fi.
                </span>
                <button
                  className="icon-button"
                  aria-label="Reconnect"
                  onClick={connect}
                >
                  <RefreshCw size={17} />
                </button>
              </div>
            )}
            <div className="mobile-heading">
              <span className="eyebrow">FROM HERE TO THERE</span>
              <h1>Make the jump.</h1>
              <p>Your favorite moments. Your important files.</p>
            </div>
            <input
              ref={photos}
              className="hidden-input"
              type="file"
              multiple
              accept="image/*,video/*"
              onChange={(e) => choose(e.target.files)}
            />
            <input
              ref={files}
              className="hidden-input"
              type="file"
              multiple
              onChange={(e) => choose(e.target.files)}
            />
            <button
              className="mobile-send-photos"
              onClick={() => photos.current?.click()}
            >
              <div className="photo-button-icon">
                <ImagePlus size={30} strokeWidth={1.6} />
              </div>
              <div>
                <strong>Send Photos & Videos</strong>
                <small>Choose a few. Or the whole adventure.</small>
              </div>
              <ArrowUpRight size={23} />
            </button>
            <button
              className="mobile-send-files"
              onClick={() => files.current?.click()}
            >
              <FileUp size={23} />
              <strong>Send Files</strong>
              <ArrowUpRight size={20} />
            </button>
            <p className="keep-open">
              <Wifi size={12} />
              Keep this page open and your phone unlocked while sending.
            </p>
            {jobs.current.length > 0 && (
              <section className="card mobile-jobs">
                <div className="section-title">
                  <h2>
                    Your uploads{" "}
                    <span className="count">{jobs.current.length}</span>
                  </h2>
                  <button
                    className="text-button"
                    onClick={() => {
                      jobs.current = jobs.current.filter(
                        (j) => !["Completed", "Canceled"].includes(j.status),
                      );
                      update();
                    }}
                  >
                    Clear finished
                  </button>
                </div>
                {jobs.current.map((job) => (
                  <div className="upload-job" key={job.key}>
                    <div className="upload-job-top">
                      <FileIcon name={job.file.name} />
                      <div>
                        <strong>{job.file.name}</strong>
                        <small>
                          {size(job.file.size)} · {job.status}
                        </small>
                      </div>
                      <div className="row-actions">
                        {["Failed", "Paused"].includes(job.status) && (
                          <button
                            className="icon-button"
                            aria-label={`Retry ${job.file.name}`}
                            onClick={() => {
                              job.status = "Queued";
                              job.error = "";
                              update();
                            }}
                          >
                            <RotateCcw size={18} />
                          </button>
                        )}
                        {job.status === "Transferring" && (
                          <button
                            className="icon-button"
                            aria-label={`Pause ${job.file.name}`}
                            onClick={() => job.controller?.abort()}
                          >
                            <Pause size={17} />
                          </button>
                        )}
                        {!["Completed", "Canceled"].includes(job.status) && (
                          <button
                            className="icon-button"
                            aria-label={`Cancel ${job.file.name}`}
                            onClick={() => cancel(job)}
                          >
                            <X size={18} />
                          </button>
                        )}
                        {job.status === "Completed" && (
                          <Check className="success" size={19} />
                        )}
                      </div>
                    </div>
                    <div className="progress-track">
                      <span
                        style={{
                          width: `${job.file.size ? Math.min(100, (job.offset / job.file.size) * 100) : job.status === "Completed" ? 100 : 0}%`,
                        }}
                      />
                    </div>
                    <small className={job.error ? "failure" : ""}>
                      {job.error ||
                        `${Math.round(job.file.size ? (job.offset / job.file.size) * 100 : job.status === "Completed" ? 100 : 0)}%${job.speed ? ` · ${size(job.speed)}/s` : ""}`}
                    </small>
                  </div>
                ))}
              </section>
            )}
            <section className="mobile-downloads">
              <div className="section-title">
                <h2>
                  From your PC{" "}
                  <span className="count">{state?.shares.length || 0}</span>
                </h2>
                {!!state?.shares.length && (
                  <button
                    className="text-button"
                    onClick={() =>
                      setSelected(
                        selected.size
                          ? new Set()
                          : new Set(
                              state.shares.slice(0, 200).map((f) => f.id),
                            ),
                      )
                    }
                  >
                    {selected.size ? "Deselect" : "Select all"}
                  </button>
                )}
              </div>
              {state?.shares.length ? (
                <>
                  <div className="mobile-file-grid">
                    {state.shares.map((f) => (
                      <article
                        className={`mobile-file-card ${selected.has(f.id) ? "selected" : ""}`}
                        key={f.id}
                      >
                        <div className="file-preview">
                          {/^(image\/(jpeg|png|webp)|video\/(mp4|quicktime))$/.test(
                            f.mime,
                          ) ? (
                            <button
                              className="preview-trigger"
                              aria-label={`Preview ${f.name}`}
                              onClick={() => {
                                setPreview(f);
                                setPreviewError(false);
                              }}
                            >
                              {f.mime.startsWith("image/") ? (
                                <img
                                  src={`/api/files/${f.id}/preview`}
                                  alt={f.name}
                                  loading="lazy"
                                />
                              ) : (
                                <>
                                  <FileIcon name={f.name} className="large" />
                                  <span className="play-preview">
                                    <Play size={18} />
                                  </span>
                                </>
                              )}
                            </button>
                          ) : (
                            <FileIcon name={f.name} className="large" />
                          )}
                          <button
                            className={`select-file ${selected.has(f.id) ? "checked" : ""}`}
                            aria-label={`${selected.has(f.id) ? "Deselect" : "Select"} ${f.name}`}
                            aria-pressed={selected.has(f.id)}
                            onClick={() => toggle(f.id)}
                          >
                            {selected.has(f.id) && <Check size={14} />}
                          </button>
                        </div>
                        <strong title={f.name}>{f.name}</strong>
                        <small>{size(f.size)}</small>
                        <button
                          className="download-button"
                          onClick={() => download([f.id])}
                        >
                          <Download size={15} />
                          Download
                        </button>
                      </article>
                    ))}
                  </div>
                  {selected.size > 0 && (
                    <button
                      className="primary full-width zip-button"
                      onClick={() => download([...selected], true)}
                    >
                      <Download size={17} />
                      Download {selected.size} as ZIP
                    </button>
                  )}
                </>
              ) : (
                <div className="card">
                  <Empty title="Your PC’s files will land here">
                    Drag files into DropBridge on Windows, then download them
                    here.
                  </Empty>
                </div>
              )}
            </section>
            {!!state?.downloads.length && (
              <section className="card">
                <div className="section-title">
                  <h2>Sending to your browser</h2>
                </div>
                {state.downloads.map((t) => (
                  <TransferRow key={t.id} transfer={t} mobile />
                ))}
                <p className="panel-footnote">
                  Safari manages saving and its own download progress.
                </p>
              </section>
            )}
            <section className="card mobile-recent">
              <div className="section-title">
                <h2>Recent transfers</h2>
                <ChevronDown size={15} className="muted" />
              </div>
              {state?.transfers.length ? (
                state.transfers
                  .filter((t) => !jobs.current.some((j) => j.id === t.id))
                  .slice(0, 10)
                  .map((t) => <TransferRow key={t.id} transfer={t} mobile />)
              ) : (
                <div className="sub-empty">
                  A clean slate. Send your first file.
                </div>
              )}
              {state?.transfers.some(
                (t) => ["Paused", "Failed"].includes(t.status) && !t.completed,
              ) && (
                <p className="panel-footnote">
                  To resume after a refresh, select the same original file
                  again. Partial uploads are kept for 24 hours.
                </p>
              )}
            </section>
            <div className="mobile-safari-note">
              <ShieldCheck size={18} />
              <p>
                Your files stay between your devices. No cloud.
                <br />
                <span>HTTP is unencrypted. Use trusted private Wi-Fi.</span>
              </p>
            </div>
          </>
        )}
      </main>
      {preview && (
        <div className="modal-backdrop" onClick={() => setPreview(undefined)}>
          <section
            className="card preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${preview.name}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPreview(undefined);
            }}
          >
            <div className="section-title">
              <h2>{preview.name}</h2>
              <button
                autoFocus
                className="icon-button"
                aria-label="Close preview"
                onClick={() => setPreview(undefined)}
              >
                <X size={20} />
              </button>
            </div>
            {previewError ? (
              <p className="panel-footnote">
                This device cannot preview this format or the file is
                unavailable. Download it to open in a compatible app.
              </p>
            ) : preview.mime.startsWith("video/") ? (
              <video
                controls
                playsInline
                preload="metadata"
                src={`/api/files/${preview.id}/preview`}
                onError={() => setPreviewError(true)}
              />
            ) : (
              <img
                src={`/api/files/${preview.id}/preview`}
                alt={preview.name}
                onError={() => setPreviewError(true)}
              />
            )}
            <button
              className="primary full-width"
              onClick={() => download([preview.id])}
            >
              <Download size={17} />
              Download original
            </button>
          </section>
        </div>
      )}
      <footer className="mobile-footer">
        A little bridge. A lot less friction.
      </footer>
    </div>
  );
}
