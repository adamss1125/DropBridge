export interface Transfer {
  id: string;
  name: string;
  originalName?: string;
  size: number;
  offset: number;
  liveOffset?: number;
  modified?: number;
  mime?: string;
  device: string;
  deviceId: string;
  direction: "receive" | "send";
  status:
    "Waiting" | "Transferring" | "Paused" | "Completed" | "Failed" | "Canceled";
  speed: number;
  created: number;
  completed?: number;
  error?: string;
  sha256?: string;
  path?: string;
  zip?: boolean;
}
export interface SharedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  path?: string;
  created: number;
  modified: number;
}
export interface Settings {
  deviceName: string;
  receiveDir: string;
  maxConcurrent: number;
  maxFileGB: number;
  notifications: boolean;
  autoAccept: boolean;
  theme: string;
  launchAtLogin: boolean;
  adapter: string;
}
export interface PublicState {
  running: boolean;
  deviceName: string;
  maxConcurrent: number;
  maxFileGB: number;
  chunkSize: number;
  shares: SharedFile[];
  transfers: Transfer[];
  downloads: Transfer[];
  totalReceived: number;
}
export interface DesktopState extends PublicState {
  settings: Settings;
  url: string;
  host: string;
  port: number;
  qr: string;
  pairCode: string;
  pairExpires: number;
  devices: {
    id: string;
    name: string;
    ip: string;
    connected: boolean;
    approved: number;
    revoked: boolean;
  }[];
  pending: { id: string; name: string; ip: string; requested: number }[];
  adapters: { name: string; address: string; virtual: boolean }[];
  networkWarning: string;
  serverError: string;
  uploads: Transfer[];
  history: Transfer[];
}
declare global {
  interface Window {
    dropbridge?: {
      invoke: (action: string, payload?: unknown) => Promise<any>;
      dropped: (files: File[]) => Promise<DesktopState>;
      onState: (callback: (state: DesktopState) => void) => () => void;
    };
  }
}
