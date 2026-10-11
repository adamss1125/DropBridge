# Real iPhone / Safari manual checklist

These checks have not been performed on a physical iPhone during development. Record iPhone model, iOS version, PC network adapter, network layout, receiving folder, and results before calling the release device-tested.

## Pairing and access

- Start the production Windows app and scan its QR with Camera. Safari should open the LAN URL with the pairing code filled in.
- Request a connection; Windows must show the expected device name/IP. Reject once and confirm no access, then approve a new request.
- Test stale/incorrect codes, a second phone, and disconnect/revoke during an upload and download. The revoked browser must need fresh approval.
- Check Windows restart: prior session must be invalid; renewed approval should restore that browser's own partials using its identity cookie.

## iPhone → Windows

- Use Photos & Videos to select JPEG, HEIC and MOV/MP4. Select documents and a ZIP from Files separately. Test Unicode names, zero-byte files, duplicates, and mixed batches.
- Test 100+ photos and a 1 GB+ video. Observe live progress and speed; confirm completed files appear immediately in the desktop receiving list and configured folder.
- Confirm bytes with an original file already present in Files, a known SHA-256 on the source computer, and the received SHA-256 in transfer history. Photos may export/convert before Safari returns a File; compare the actual exported file when possible.
- Pause/retry, cancel mid-upload, briefly disable Wi-Fi, lock the phone, switch apps, refresh Safari, and stop/restart the Windows server. Reselect the same original file after refresh. Expect interruptions on suspension; verify partial offsets resume or clear errors explain recovery.
- Test auto-accept off: each file waits for Windows approval. Cancel waiting files. Test a small file-size limit and a receiving folder without sufficient space/permissions.
- Verify duplicate filenames do not overwrite. Check modification time where Safari provides it. Check the transferred HEIC/MOV is playable in an appropriate viewer; Windows codec support is separate from byte integrity.

## Windows → iPhone

- Drag photos/videos/documents into the desktop sharing shelf; verify immediate availability on Safari.
- Download a single file; confirm Safari's download manager finishes and it opens in Files. Test 1 GB+ downloads and interruption behavior (Safari controls resume support).
- Select several files and download ZIP; extract it in Files and confirm contents and collision-safe archive names.
- View JPEG/PNG previews. Test MP4/MOV where Safari supports the codec. Unsupported previews should still allow downloads.
- Open a saved supported image/video and use Share → Save Image/Save Video if offered. The app must never claim it can silently save to Photos.
- Remove or modify a shared PC file and confirm a helpful download error. Unpaired devices must not access file/ZIP endpoints.

## Network, install, layout

- Verify normal Windows Firewall Private-network approval and blocking. Follow the connection help without disabling the Firewall.
- Test different Wi-Fi networks, guest isolation, VPN interference, changed IP address, multiple adapters, computer sleep, and Server Stop.
- Test portrait/landscape, safe-area insets, small screens, large text, comfortable tap targets, long filenames, and many queue items.
- Run portable and installed builds without VS Code. Test folder choice, persisted settings, desktop notifications, file/folder opening, clearing history, and optional launch with Windows.

Local HTTP is deliberately unencrypted. Home Screen installation/offline PWA operation is not promised for the LAN HTTP origin. Open the current QR URL in Safari for the supported workflow.
