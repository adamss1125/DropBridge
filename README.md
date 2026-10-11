# DropBridge

A working Windows desktop app for direct local file transfers with iPhone Safari, Android, Mac, and other computers. Built with Electron, React, TypeScript, Vite, Tailwind, Node HTTP, and WebSockets. No account, subscription, cloud storage, remote fonts, telemetry, or paid API. MoneyOS is untouched; this project lives in its own directory.

## Open the Windows app

The production artifacts are in `release/`:

- `DropBridge-1.0.0-x64-portable.exe`: double-click to run without installing.
- `DropBridge-1.0.0-x64-installer.exe`: installer with destination selection and shortcuts.
- `win-unpacked/DropBridge.exe`: unpacked executable; keep this entire folder together.

These personal builds are unsigned. Windows may show an unknown-publisher/SmartScreen prompt. Verify the file came from your own build before running it. No signing subscription is needed for personal use.

## First transfer

1. Connect Windows and your phone to the same **trusted private Wi-Fi**. Ethernet on the same router also works.
2. Open DropBridge and keep your PC awake. The app starts its internal server on one private LAN address, normally port **47831**.
3. If Windows Firewall asks, allow **Private networks**. Do not enable Public network access or configure router port forwarding.
4. Scan the QR using the iPhone camera. Open the address in Safari.
5. Tap **Connect to my PC**. The QR fills the five-minute pairing code. Approve the device in the Windows app.
6. Tap **Send Photos & Videos** or **Send Files**, select multiple items, and keep Safari visible and your phone unlocked.
7. Received files save to `Downloads/DropBridge` by default. Use **Received** to open a file or reveal it in Explorer. Settings lets you choose another folder.

To send the other way, choose files or drag them onto DropBridge on Windows. They appear under **From your PC** on Safari. Tap **Download**, or select files and download a streaming ZIP. Safari saves to its download location in Files. Open a saved image/video and use the iOS Share sheet to save to Photos where supported. The web page cannot silently write to Photos. HEIC and MOV playback depends on the receiving device, but their original selected bytes are transferred unchanged.

The Photos picker may export or convert a photo before Safari provides it. DropBridge preserves the file that Safari actually supplies, its extension, embedded metadata, and available last-modified timestamp; it cannot recover metadata iOS omitted. Original filenames are retained where valid on Windows; forbidden Windows characters are replaced and duplicates get `(1)`, `(2)`, etc.

## Transfers and recovery

- Uploads use **4 MiB chunks**, SHA-256 checks per chunk, and a complete file checksum before saving. Hashing works on local HTTP without relying on browser secure-context APIs.
- The default limit is **20 GB per file** and three simultaneous transfers. Settings allows 1–100 GB and 1–6 transfers.
- Upload hashing, writes, downloads, and ZIPs use bounded memory. ZIP selection is limited to 200 files per archive; the sharing shelf holds 2,000 files.
- Pause/retry/cancel are available on the sending page. Interrupted uploads retain verified offsets for 24 hours. After page refresh, reselect the same original file (name, size, modification timestamp). After PC restart, scan again and approve; the same browser's HttpOnly device-identity cookie lets it recover its own partials.
- Safari suspension, locking, switching networks, or closing the app can pause transfers. Keep the page open. Retry recomputes the file hash in small slices and sends only missing bytes.
- Cancel removes the temporary file. Stale partials are cleaned after 24 hours. Completed files remain when history is cleared. History retains the latest 500 events.
- Temporary chunks live in the app's data folder; final saves stream into the selected folder. Allow enough space for both temporary and final copies (roughly twice the incoming size if both folders share one drive).
- A completed download means the server handed the stream to the connection. Safari's download manager confirms the device-side save. ZIP progress shows bytes streamed and is approximate because headers add a small overhead.
- Only explicitly selected PC files are available for download. Removing one from the share shelf leaves the original intact. If it changes or moves, share it again.

## Privacy and security

**Local HTTP is unencrypted. File contents, pairing codes, and session credentials can be observed or modified by someone monitoring an untrusted network.** This version is intended for trusted private Wi-Fi. It does not claim network confidentiality or production-grade encryption. Checksums detect accidental corruption, not a malicious network attacker.

New devices always need a five-minute code **and explicit desktop approval**. Session cookies are random, HttpOnly, SameSite=Strict, expire after 24 hours, and are invalidated on server stop/app restart. A separate persistent HttpOnly identity cookie identifies resumable uploads; it grants no access without renewed pairing approval. Devices can be revoked immediately, including active upload/download streams. Turning off auto-accept requires approval for each incoming file as well.

The server validates its exact Host and Origin, rejects cross-site requests and non-private source addresses, limits pairing attempts and body/chunk sizes, confines filenames and static paths, and exposes only a share-by-ID API. It binds one selected private IPv4 interface rather than all interfaces. Internet-facing/public adapters are not selected. VPN/virtual adapters are deprioritized; choose a physical adapter in Settings when necessary.

Electron uses context isolation, a sandboxed renderer, disabled Node integration, a local custom protocol with CSP, denied renderer permissions, a narrow validated IPC bridge, and blocked navigation/new windows. Executable/script file types are revealed in Explorer rather than automatically launched by the Open action. Always review unfamiliar received files before opening them.

## Connection troubleshooting

Use the in-app **Connection help**, or follow [the detailed guide](docs/CONNECTION.md). Check same-network access, guest/client isolation, Windows Private network profile, app-specific Firewall allowance, VPN interference, current IP/adapter, PC sleep, and whether the server is running. Do not disable the Firewall globally.

## Development and packaging

Requires Node.js 22.12+ or a compatible newer version on Windows, and internet access **only to install/build dependencies**.

```powershell
cd "C:\Users\darkg\Desktop\vibecoding apps\MoneyOS\dropbridge"
npm ci
npm run build
npm run dev
```

`dev` runs the Vite desktop UI, watches production browser assets, and launches Electron with its internal transfer service. No separate external backend is needed. `npm start` runs the last production UI build in Electron.

```powershell
npm test
npm run test:large
node scripts/verify-ui.mjs
npm run package
node scripts/verify-portable.mjs
```

`verify-ui.mjs` uses installed Chrome (edit the path if necessary) and actual Electron. It creates isolated `.test-data` folders. To test the packaged app, set `DROPBRIDGE_EXECUTABLE` to the absolute unpacked executable path before running that script. `verify-portable.mjs` opens the actual portable executable with a temporary localhost debugging port, checks its UI/server, and closes it; it must run after packaging. Production packaging emits an x64 installer, portable executable, and unpacked directory. `npm run package:dir` emits only the unpacked build. The application data is normally `%APPDATA%/dropbridge`; deleting it resets preferences, trust metadata, history, and unfinished uploads, but leaves completed files in your receiving folder.

Launch with Windows is opt-in and supported in the packaged app through Electron's login-item setting. An installed build is the recommended choice for startup; a portable executable must stay at a stable location.

## Verification

See [verification results](docs/VERIFICATION.md) and the [real iPhone checklist](docs/IPHONE-QA.md). Automated tests simulate browser protocol behavior and use a mobile viewport in Chrome; they do **not** establish real iPhone Safari compatibility, actual Wi-Fi throughput, or your Firewall configuration. Real-device testing remains necessary.

The implementation follows Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security), [native file-drop API](https://www.electronjs.org/docs/latest/api/web-utils), Node's [stream APIs](https://nodejs.org/api/stream.html), and [Windows packaging documentation](https://www.electron.build/win/).
