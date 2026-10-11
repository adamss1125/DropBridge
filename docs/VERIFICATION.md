# Verification record — 11 October 2026

## Completed checks

- TypeScript checking and Vite production build passed.
- All **20 protocol/security integration tests** passed on Windows with real HTTP, WebSocket, and filesystem operations.
- Unauthorized state/download/upload/WebSocket access, exact Host and Origin validation, cross-site rejection, pairing approval/decline, bad/expired codes, session expiry, device revocation, and device-specific upload ownership passed.
- Unicode filenames, Windows name sanitization, traversal rejection, original bytes/extensions, available modification timestamps, collision-safe saves, empty files, size guards, chunk checksum rollback, complete checksum rejection, partial cleanup, cancel, interrupted chunk recovery, and manual incoming-file approval passed.
- Restart restored settings/history/partials, invalidated sessions, and allowed the same browser identity to resume only after fresh code and desktop approval. Clearing history preserved completed files.
- Three concurrent workers transferred **60 generated photo files** with repeated names and matching checksums.
- A generated **1 GiB (1,073,741,824 bytes)** file was uploaded in 4 MiB chunks, checked on disk, and streamed back. All three SHA-256 checks matched: `273afd22517d7d90a0e59b9b18e67b003599d22f84a6b51c26d80585fa979eb4`. The combined Node client/server test process grew from about **87 MiB to 153 MiB RSS**, far below the file size. The test passed including cleanup in about 52 seconds on the local host; this is not a Wi-Fi throughput measurement.
- Chrome automation with a mobile viewport passed real pairing approval, multiple uploads, duplicate names, checksums, a saved single download, a saved/examined ZIP, image preview, revocation, and no horizontal overflow at **320, 390, and 768 px**.
- Actual Electron launch passed context isolation, sandbox, disabled Node integration, production custom-protocol assets, native clipboard copying, sharing, a persisted setting, and server stop/start. Browser uploads/downloads also passed against the **actual Electron-hosted private LAN address**, approved through the real desktop UI.
- The **packaged `release/win-unpacked/DropBridge.exe`** passed the same desktop and real LAN transfer checks, without the development runtime or VS Code. No page errors were reported.
- The **standalone portable executable** passed self-extraction, production UI rendering, native bridge access, internal private LAN server startup, and clean shutdown. It was inspected through a temporary local debug port and then closed. This does not leave the debugging port running.
- Windows packaging completed successfully: **portable** `release/DropBridge-1.0.0-x64-portable.exe` (94,936,905 bytes), **installer** `release/DropBridge-1.0.0-x64-installer.exe` (95,147,643 bytes), and the runnable unpacked directory. These are unsigned personal builds; installation itself was not performed. SHA-256 hashes are saved in `release/SHA256SUMS.txt`.
- Production dependency audit reported **zero vulnerabilities** at verification time. The latest installed packaging toolchain still reports eight moderate development-only advisories through its legacy logging/formatting dependency. Those build dependencies are excluded from the packaged app. A proposed automatic downgrade introduced worse advisories; the latest builder was restored and production dependencies were rechecked.

## Environment findings and fixes

The restricted Windows temporary folder denied rename operations, so fixtures use isolated workspace directories. Restricted Chrome processes could receive bytes but could not save browser downloads; rerunning the same verification outside that process sandbox saved and validated them successfully. These were environment restrictions, not proof of iPhone behavior.

Verification found and fixed a shutdown race that could leave a final download-history write in flight, and a clipboard control that needed a restricted native action instead of denied browser clipboard permission. Paired streams are awaited/closed before shutdown. Interrupted writes roll back to the committed offset. A failed response after a completed upload can be reconciled from history on retry.

The Windows packaging tool's cache encountered a directory-rename access error after verifying/extracting NSIS. Installer generation was retried using the already verified extracted tool directory through the builder's supported override.

## Still requires manual testing

No physical iPhone was used. Safari file-picker behavior, HEIC/MOV codecs, Photos sharing, suspension/locking, real Wi-Fi throughput, Windows Firewall allowance, network isolation, actual DHCP changes, desktop notification delivery, and launch-with-Windows must be checked on the user's devices. The NSIS installer is built but installation itself is not automatically performed. Use [the iPhone checklist](IPHONE-QA.md) and [connection guide](CONNECTION.md).

Local HTTP is unencrypted. Passing checksums and authorization tests does not establish network confidentiality, HTTPS security, or production-grade hardening.
