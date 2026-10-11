# DropBridge implementation plan

This project is isolated from the existing MoneyOS application.

1. Foundation: isolated Electron main/preload, React desktop and separately composed mobile views, internal Node HTTP service bound to one private LAN address.
2. Transfers: bounded 4 MiB upload chunks with offsets, streaming downloads/ZIP, collision-safe native saves, SHA-256 chunk and final verification, resumable partials, cancellation and retry.
3. Pairing: five-minute QR/code, explicit desktop approval, HttpOnly session cookies, expiring tokens, revocation, authenticated WebSocket, host/origin validation and rate limits.
4. Polish: real history, progress, speed, native file/folder actions, notifications, preferences, network adapter selection and connection guidance.
5. Verification: protocol/security integration tests, generated 1 GiB transfer, batch/restart/interruption tests, browser/Electron checks, Windows packaging and manual Safari checklist.

Boundaries: local HTTP is unencrypted. Browser downloads stream through Safari's download manager; the page cannot prove that iOS saved a download or silently write to Photos. Safari suspension can interrupt uploads. A successful server stream means bytes handed to the connection, not a confirmed client disk save. Paired sessions expire after 24 hours and are invalidated on application restart.
