import {
  ArrowDownLeft,
  ArrowUpRight,
  File,
  FileArchive,
  FileImage,
  FileText,
  Film,
  FolderOpen,
  Check,
  X,
  RotateCcw,
  Pause,
  ExternalLink,
} from "lucide-react";
import type { Transfer } from "./types";
export function size(bytes: number) {
  if (bytes === 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}
export function FileIcon({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  const ext = name.split(".").pop()?.toLowerCase();
  const Icon = /^(jpg|jpeg|png|heic|webp|gif)$/.test(ext || "")
    ? FileImage
    : /^(mov|mp4|mkv|avi)$/.test(ext || "")
      ? Film
      : /^(zip|rar|7z|gz)$/.test(ext || "")
        ? FileArchive
        : /^(pdf|docx?|txt|xlsx?)$/.test(ext || "")
          ? FileText
          : File;
  return (
    <span className={`file-icon ${className}`}>
      <Icon size={21} strokeWidth={1.6} />
    </span>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-mark">
        <ArrowDownLeft size={24} />
      </span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}
export function TransferRow({
  transfer: t,
  actions,
  mobile = false,
}: {
  transfer: Transfer;
  actions?: (action: string, id: string) => void;
  mobile?: boolean;
}) {
  const progress = t.size
    ? Math.min(100, Math.round(((t.liveOffset ?? t.offset) / t.size) * 100))
    : t.status === "Completed"
      ? 100
      : 0;
  const active =
    ["Transferring", "Waiting", "Paused", "Failed"].includes(t.status) &&
    !t.completed;
  return (
    <div className={`transfer-row ${t.status.toLowerCase()}`}>
      <FileIcon name={t.name} />
      <div className="transfer-main">
        <strong title={t.name}>{t.name}</strong>
        <div className="file-meta">
          <span>{size(t.size)}</span>
          <span>·</span>
          <span>
            {t.direction === "receive" ? (
              <ArrowDownLeft size={12} />
            ) : (
              <ArrowUpRight size={12} />
            )}
            {t.device || "Your device"}
          </span>
          {t.sha256 && (
            <span className="verified" title={`SHA-256: ${t.sha256}`}>
              <Check size={11} /> Verified
            </span>
          )}
        </div>
        {active && (
          <>
            <div className="progress-track">
              <span style={{ width: `${progress}%` }} />
            </div>
            <small>
              {t.error ||
                (t.status === "Transferring"
                  ? `${progress}% · ${size(t.speed)}/s`
                  : t.status === "Waiting"
                    ? "Waiting for approval"
                    : "Reselect the original file on the sending device to resume.")}
            </small>
          </>
        )}
      </div>
      <span className={`status-label ${t.status.toLowerCase()}`}>
        {t.status === "Completed" ? <Check size={14} /> : null}
        {t.status}
      </span>
      {actions && (
        <div className="row-actions">
          {t.status === "Waiting" && (
            <button
              className="icon-button"
              title="Accept file"
              aria-label="Accept file"
              onClick={() => actions("approveUpload", t.id)}
            >
              <Check size={16} />
            </button>
          )}
          {active && (
            <button
              className="icon-button"
              title="Cancel transfer"
              aria-label="Cancel transfer"
              onClick={() => actions("cancel", t.id)}
            >
              <X size={16} />
            </button>
          )}
          {t.status === "Completed" && t.direction === "receive" && !mobile && (
            <>
              <button
                className="icon-button"
                title="Open file"
                aria-label="Open file"
                onClick={() => actions("open", t.id)}
              >
                <ExternalLink size={16} />
              </button>
              <button
                className="icon-button"
                title="Show in folder"
                aria-label="Show in folder"
                onClick={() => actions("reveal", t.id)}
              >
                <FolderOpen size={17} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
export const Icons = { RotateCcw, Pause, X };
