import { useEffect, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Copy,
  FolderOpen,
  HardDrive,
  History,
  LayoutGrid,
  Monitor,
  Power,
  QrCode,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Smartphone,
  Unplug,
  Upload,
  Wifi,
  X,
} from "lucide-react";
import { Empty, FileIcon, size, TransferRow } from "./components";
import type { DesktopState, Settings } from "./types";

const nav = [
  { label: "Dashboard", icon: LayoutGrid },
  { label: "Received", icon: ArrowDownLeft },
  { label: "Send Files", icon: ArrowUpRight },
  { label: "Devices", icon: Smartphone },
  { label: "Transfer History", icon: History },
  { label: "Settings", icon: SettingsIcon },
];
export function Desktop() {
  const [state, setState] = useState<DesktopState>();
  const [page, setPage] = useState("Dashboard");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [drag, setDrag] = useState(false);
  const [help, setHelp] = useState(false);
  const [storage, setStorage] = useState<{ free: number; total: number }>();
  const [filter, setFilter] = useState("");
  const [now, setNow] = useState(Date.now());
  const bridge = window.dropbridge!;
  const act = async (action: string, payload?: unknown) => {
    try {
      const result = await bridge.invoke(action, payload);
      if (result?.settings) setState(result);
      setError("");
      return result;
    } catch (e) {
      setError(
        (e as Error).message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    }
  };
  useEffect(() => {
    bridge
      .invoke("state")
      .then(setState)
      .catch((e) => setError(e.message));
    const unsub = bridge.onState(setState);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!state) return;
    bridge
      .invoke("storage")
      .then(setStorage)
      .catch(() => {});
  }, [state?.settings.receiveDir, state?.totalReceived]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 2600);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const actionFile = (action: string, id: string) =>
    act(action, action === "open" || action === "reveal" ? { id } : id);
  const copy = async () => {
    try {
      await bridge.invoke("copyAddress");
      setToast("Local address copied");
    } catch {
      setError("Copy the local address displayed below the QR code.");
    }
  };
  if (!state)
    return (
      <div className="loading">
        <div className="brand-symbol">↗</div>
        <p>Opening your local bridge…</p>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  const connected = state.devices.filter((d) => d.connected && !d.revoked);
  const active = [...state.uploads, ...state.downloads];
  const recent = [...active, ...state.history].slice(0, 6);
  const dropzone = (
    <div
      className={`dropzone ${drag ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDrag(false);
        try {
          await bridge.dropped(Array.from(e.dataTransfer.files));
          setToast("Files are ready for your devices");
        } catch (e) {
          setError((e as Error).message);
        }
      }}
    >
      <div className="drop-icon">
        <ArrowUpFromLine size={30} strokeWidth={1.6} />
      </div>
      <h2>Drop it here. Find it there.</h2>
      <p>
        Drag photos, videos, or documents to share
        <br />
        with your connected devices.
      </p>
      <button className="primary" onClick={() => act("chooseFiles")}>
        <Upload size={16} />
        Choose files
      </button>
      <span className="drop-footnote">
        Original quality. Any file type. Your Wi-Fi.
      </span>
    </div>
  );
  const pairCard = (
    <section className="card pairing-card">
      <div className="section-title">
        <h2>
          <QrCode size={17} />
          Connect a device
        </h2>
        <button
          className="icon-button"
          title="New pairing code"
          aria-label="New pairing code"
          onClick={() => act("rotate")}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {state.running && state.qr ? (
        <>
          <div className="qr-wrap">
            <img
              src={state.qr}
              alt="Scan this QR code on your phone to open DropBridge"
            />
          </div>
          <p>
            Scan with your phone’s camera.
            <br />
            Approve the connection on this PC.
          </p>
          <div className="pair-code">
            <span>PAIRING CODE</span>
            <strong>
              {state.pairCode.slice(0, 3)} {state.pairCode.slice(3)}
            </strong>
            <small>
              Refreshes in{" "}
              {Math.max(0, Math.ceil((state.pairExpires - now) / 1000))}s
            </small>
          </div>
          <button className="address" onClick={copy} title="Copy local address">
            {state.url}
            <Copy size={13} />
          </button>
        </>
      ) : (
        <div className="pair-offline">
          <Wifi size={34} />
          <h3>Bridge is offline</h3>
          <p>Connect to private Wi-Fi or Ethernet, then start your server.</p>
          <button className="primary" onClick={() => act("start")}>
            <Power size={16} />
            Start server
          </button>
        </div>
      )}
      <div className="quiet-note">
        <ShieldCheck size={14} />
        Local network only · HTTP is unencrypted
      </div>
    </section>
  );
  const historyList = (records = recent) =>
    records.length ? (
      <div className="transfer-list">
        {records.map((t) => (
          <TransferRow key={t.id} transfer={t} actions={actionFile} />
        ))}
      </div>
    ) : (
      <Empty title="Your first transfer starts here">
        Send something from your phone, or choose files to share from this PC.
      </Empty>
    );
  const shares = (
    <section className="card">
      <div className="section-title">
        <h2>
          Ready to download <span className="count">{state.shares.length}</span>
        </h2>
        <button className="text-button" onClick={() => act("chooseFiles")}>
          Add files <Upload size={14} />
        </button>
      </div>
      {state.shares.length ? (
        state.shares.map((f) => (
          <div className="transfer-row" key={f.id}>
            <FileIcon name={f.name} />
            <div className="transfer-main">
              <strong>{f.name}</strong>
              <div className="file-meta">
                {size(f.size)} · Available to paired devices
              </div>
            </div>
            <button
              className="icon-button"
              aria-label={`Show ${f.name} in folder`}
              onClick={() => act("reveal", { id: f.id, kind: "share" })}
            >
              <FolderOpen size={17} />
            </button>
            <button
              className="icon-button"
              aria-label={`Remove ${f.name} from sharing`}
              onClick={() => act("removeShare", f.id)}
            >
              <X size={17} />
            </button>
          </div>
        ))
      ) : (
        <div className="sub-empty">
          Files you choose above will appear on your phone.
        </div>
      )}
    </section>
  );
  const warning = state.serverError || state.networkWarning;
  return (
    <div className="desktop-shell" data-theme={state.settings.theme}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">↗</div>
          <div>
            DropBridge<small>MADE TO CONNECT</small>
          </div>
        </div>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav>
          {nav.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={page === label ? "nav-active" : ""}
              onClick={() => setPage(label)}
            >
              <Icon size={18} />
              {label}
              {label === "Received" &&
                active.filter((t) => t.direction === "receive").length > 0 && (
                  <span className="nav-badge">
                    {active.filter((t) => t.direction === "receive").length}
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="help-button" onClick={() => setHelp(true)}>
            <CircleHelp size={17} />
            Connection help
            <ChevronRight size={14} />
          </button>
          <div className="host-card">
            <Monitor size={21} />
            <div>
              <strong>{state.deviceName}</strong>
              <small>
                <span className={`dot ${state.running ? "online" : ""}`} />
                {state.running ? "Bridge is online" : "Server stopped"}
              </small>
            </div>
          </div>
          <div className="version">DropBridge 1.0 · Made for your network</div>
        </div>
      </aside>
      <main className="desktop-main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>{page}</strong>
          </div>
          <button
            className={`server-pill ${state.running ? "online" : ""}`}
            onClick={() => act(state.running ? "stop" : "start")}
          >
            <span className="dot" />
            {state.running ? "Local server online" : "Start local server"}
            <Power size={13} />
          </button>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {page === "Dashboard"
                  ? "LESS FRICTION. MORE FLOW."
                  : "YOUR LOCAL BRIDGE"}
              </span>
              <h1>
                {page === "Dashboard" ? "A little closer, together." : page}
              </h1>
              <p>
                {page === "Dashboard"
                  ? "Your files, moving freely between your devices."
                  : page === "Received"
                    ? "Everything sent to this PC, saved in your receiving folder."
                    : page === "Send Files"
                      ? "Share files from your PC. Download them on any paired device."
                      : page === "Devices"
                        ? "You decide who crosses the bridge."
                        : page === "Transfer History"
                          ? "A record of the files that crossed your network."
                          : "Make DropBridge feel at home."}
              </p>
            </div>
            {["Received", "Transfer History"].includes(page) && (
              <button className="secondary" onClick={() => act("openFolder")}>
                <FolderOpen size={16} />
                Receiving folder
              </button>
            )}
          </div>
          {warning && (
            <div className="notice warning">
              <Wifi size={17} />
              <span>{warning}</span>
              <button className="text-button" onClick={() => setHelp(true)}>
                Get help
              </button>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {state.pending.map((p) => (
            <div className="approval-card" key={p.id}>
              <div className="device-avatar">
                <Smartphone size={21} />
              </div>
              <div>
                <strong>{p.name} wants to connect</strong>
                <p>{p.ip} · Only approve devices you recognize.</p>
              </div>
              <button
                className="secondary"
                onClick={() => act("approve", { id: p.id, accept: false })}
              >
                Decline
              </button>
              <button
                className="primary"
                onClick={() => act("approve", { id: p.id, accept: true })}
              >
                <Check size={16} />
                Approve
              </button>
            </div>
          ))}
          {page === "Dashboard" && (
            <>
              <div className="dashboard-grid">
                <div className="dashboard-left">
                  <section className="connection-card">
                    <div className="device-avatar">
                      <Smartphone size={26} strokeWidth={1.6} />
                    </div>
                    <div>
                      <span className="eyebrow">
                        {connected.length
                          ? "CONNECTED & READY"
                          : "READY WHEN YOU ARE"}
                      </span>
                      <h2>
                        {connected.length
                          ? connected[0].name
                          : "Bring your devices together"}
                      </h2>
                      <p>
                        {connected.length
                          ? `${connected.length} device${connected.length > 1 ? "s" : ""} connected on your network`
                          : "Scan the QR code to connect your phone."}
                      </p>
                    </div>
                    {connected.length ? (
                      <span className="connection-check">
                        <CheckCircle2 size={21} />
                      </span>
                    ) : (
                      <Wifi size={24} className="muted" />
                    )}
                  </section>
                  {dropzone}
                  <div className="stats-grid">
                    <div className="card stat">
                      <span>
                        <ArrowDownLeft size={15} />
                        RECEIVED
                      </span>
                      <strong>{size(state.totalReceived)}</strong>
                      <small>Across retained transfer history</small>
                    </div>
                    <div className="card stat">
                      <span>
                        <HardDrive size={15} />
                        AVAILABLE STORAGE
                      </span>
                      <strong>
                        {storage ? size(storage.free) : "Checking…"}
                      </strong>
                      <small>In your receiving drive</small>
                    </div>
                  </div>
                </div>
                {pairCard}
              </div>
              <section className="card recent-card">
                <div className="section-title">
                  <h2>
                    Recent transfers{" "}
                    <span className="count">{recent.length}</span>
                  </h2>
                  <button
                    className="text-button"
                    onClick={() => setPage("Transfer History")}
                  >
                    View all <ChevronRight size={14} />
                  </button>
                </div>
                {historyList()}
              </section>
              {state.shares.length > 0 && shares}
            </>
          )}
          {page === "Send Files" && (
            <>
              {dropzone}
              {shares}
              <section className="card">
                <div className="section-title">
                  <h2>Download activity</h2>
                </div>
                {historyList(
                  [
                    ...state.downloads,
                    ...state.history.filter((t) => t.direction === "send"),
                  ].slice(0, 15),
                )}
                <p className="panel-footnote">
                  Completed means the server sent the bytes. Your device’s
                  browser manages saving them.
                </p>
              </section>
            </>
          )}
          {page === "Received" && (
            <>
              <section className="card receive-location">
                <FolderOpen size={23} />
                <div>
                  <strong>Incoming files save automatically here</strong>
                  <p>{state.settings.receiveDir}</p>
                </div>
                <button
                  className="secondary"
                  onClick={() => act("chooseFolder")}
                >
                  Change folder
                </button>
              </section>
              <section className="card">
                {historyList([
                  ...state.uploads,
                  ...state.history.filter((t) => t.direction === "receive"),
                ])}
              </section>
            </>
          )}
          {page === "Devices" && (
            <div className="devices-layout">
              <section className="card">
                <div className="section-title">
                  <h2>Approved devices</h2>
                </div>
                {state.devices.filter((d) => !d.revoked).length ? (
                  state.devices
                    .filter((d) => !d.revoked)
                    .map((d) => (
                      <div className="device-row" key={d.id}>
                        <div className="device-avatar">
                          <Smartphone size={22} />
                        </div>
                        <div>
                          <strong>{d.name}</strong>
                          <small>
                            {d.ip} ·{" "}
                            {d.connected
                              ? "Connected"
                              : "Offline or session expired"}
                          </small>
                        </div>
                        <span
                          className={`dot ${d.connected ? "online" : ""}`}
                        />
                        <button
                          className="secondary"
                          onClick={() => act("revoke", d.id)}
                        >
                          <Unplug size={14} />
                          Disconnect & revoke
                        </button>
                      </div>
                    ))
                ) : (
                  <Empty title="A bridge for all your devices">
                    iPhone, Android, Mac, and Windows. All they need is a
                    browser.
                  </Empty>
                )}
                <p className="panel-footnote">
                  Access expires after 24 hours and on app restart. Reconnecting
                  requires your current code and approval.
                </p>
              </section>
              {pairCard}
            </div>
          )}
          {page === "Transfer History" && (
            <>
              <div className="history-toolbar">
                <input
                  aria-label="Search transfer history"
                  placeholder="Search filename or device…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <button
                  className="secondary"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Clear transfer history? Saved files will remain on your PC.",
                      )
                    )
                      act("clearHistory");
                  }}
                >
                  Clear history
                </button>
              </div>
              <section className="card">
                {historyList(
                  [...active, ...state.history].filter((t) =>
                    `${t.name} ${t.device}`
                      .toLowerCase()
                      .includes(filter.toLowerCase()),
                  ),
                )}
              </section>
            </>
          )}
          {page === "Settings" && (
            <SettingsPanel settings={state.settings} state={state} act={act} />
          )}
          <footer className="page-footer">
            <ShieldCheck size={13} />
            Direct over your Wi-Fi. No account. No cloud.
            <span>HTTP transfers are not encrypted.</span>
          </footer>
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="help-modal card"
            role="dialog"
            aria-modal="true"
            aria-label="Connection help"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-title">
              <h2>Get your devices connected</h2>
              <button
                className="icon-button"
                aria-label="Close help"
                onClick={() => setHelp(false)}
              >
                <X size={18} />
              </button>
            </div>
            <ol>
              <li>
                <strong>Use the same private Wi-Fi.</strong> Your PC can use
                Ethernet on the same router. Guest networks often block devices
                from seeing one another.
              </li>
              <li>
                <strong>Allow DropBridge in Windows Firewall.</strong> Choose
                Private networks when Windows prompts. In Windows Security →
                Firewall → Allow an app, allow the packaged DropBridge app on
                Private networks only.
              </li>
              <li>
                <strong>Check the address.</strong> Use the current QR or{" "}
                {state.url || "the address shown after starting the server"}.
                VPNs can interfere; select your Wi-Fi or Ethernet adapter in
                Settings.
              </li>
              <li>
                <strong>Keep the bridge open.</strong> Keep your PC awake and
                DropBridge running. Keep Safari visible and your phone unlocked
                during uploads.
              </li>
              <li>
                <strong>If the address changed:</strong> stop the server, choose
                the current adapter, start it again, and scan the new QR.
                Reapprove the device.
              </li>
            </ol>
            <p className="notice warning">
              Use a trusted private network. Local HTTP does not encrypt file
              contents or pairing credentials in transit.
            </p>
            <button className="primary" onClick={() => setHelp(false)}>
              Got it
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

function SettingsPanel({
  settings,
  state,
  act,
}: {
  settings: Settings;
  state: DesktopState;
  act: (action: string, payload?: unknown) => Promise<any>;
}) {
  const [name, setName] = useState(settings.deviceName);
  const save = (patch: Partial<Settings>) => act("settings", patch);
  return (
    <div className="settings-layout">
      <section className="card settings-card">
        <h2>Your PC</h2>
        <div className="setting-row">
          <div>
            <strong>Device name</strong>
            <p>Shown on your phone and other devices.</p>
          </div>
          <div className="setting-input">
            <input
              aria-label="Device name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              className="secondary"
              onClick={() => save({ deviceName: name.trim() })}
            >
              Save
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>Receiving folder</strong>
            <p className="folder-path">{settings.receiveDir}</p>
          </div>
          <button className="secondary" onClick={() => act("chooseFolder")}>
            Choose folder
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>Network adapter</strong>
            <p>Stop and start the server after changing this.</p>
          </div>
          <select
            aria-label="Network adapter"
            value={settings.adapter}
            onChange={(e) => save({ adapter: e.target.value })}
          >
            <option value="">Automatic · Wi-Fi / Ethernet</option>
            {state.adapters.map((a) => (
              <option key={a.address} value={a.address}>
                {a.name} · {a.address}
                {a.virtual ? " (virtual)" : ""}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="card settings-card">
        <h2>Transfers & preferences</h2>
        <div className="setting-row">
          <div>
            <strong>Simultaneous transfers</strong>
            <p>Keep your network comfortable.</p>
          </div>
          <select
            aria-label="Simultaneous transfers"
            value={settings.maxConcurrent}
            onChange={(e) => save({ maxConcurrent: +e.target.value })}
          >
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <div>
            <strong>Maximum file size</strong>
            <p>Applies to each incoming file.</p>
          </div>
          <select
            aria-label="Maximum file size"
            value={settings.maxFileGB}
            onChange={(e) => save({ maxFileGB: +e.target.value })}
          >
            {[1, 5, 10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} GB
              </option>
            ))}
          </select>
        </div>
        {[
          {
            key: "autoAccept" as const,
            label: "Auto-accept from approved devices",
            note: "When off, approve each incoming file on this PC.",
          },
          {
            key: "notifications" as const,
            label: "Desktop notifications",
            note: "A little heads-up when a file arrives.",
          },
          {
            key: "launchAtLogin" as const,
            label: "Launch with Windows",
            note: "Available after packaging and installation.",
          },
        ].map((item) => (
          <div className="setting-row" key={item.key}>
            <div>
              <strong>{item.label}</strong>
              <p>{item.note}</p>
            </div>
            <button
              role="switch"
              aria-checked={settings[item.key]}
              aria-label={item.label}
              className={`toggle ${settings[item.key] ? "on" : ""}`}
              onClick={() => save({ [item.key]: !settings[item.key] })}
            >
              <span />
            </button>
          </div>
        ))}
        <div className="setting-row">
          <div>
            <strong>Appearance</strong>
            <p>Choose your favorite shade of calm.</p>
          </div>
          <select
            aria-label="Appearance"
            value={settings.theme}
            onChange={(e) => save({ theme: e.target.value })}
          >
            <option value="dark">Premium dark</option>
            <option value="light">Light</option>
            <option value="system">Follow system</option>
          </select>
        </div>
      </section>
      <div className="notice warning">
        <ShieldCheck size={20} />
        <span>
          Files stay on your local network. HTTP is unencrypted; use trusted
          private Wi-Fi. New devices always require approval.
        </span>
      </div>
    </div>
  );
}
