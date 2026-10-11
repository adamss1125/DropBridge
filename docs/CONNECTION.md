# Connection guide

1. Set Windows Settings → Network & internet → your current network → Network profile to **Private** only when you trust the network.
2. Open DropBridge. The online indicator, LAN address, current adapter, and QR must be visible. If no private adapter exists, connect to your router and start the server.
3. On your phone, join the same router/network. Cellular alone cannot reach the PC. The PC can use wired Ethernet on that router.
4. Open the displayed `http://<PC IP>:47831` in Safari. The port is required. Scan the current QR whenever the address changes.
5. If the page times out, check Windows Security → Firewall & network protection → Allow an app through firewall → Change settings → Allow another app. Select the actual installed DropBridge executable and allow it on **Private** networks. For development, the actual executable is `dropbridge/node_modules/electron/dist/electron.exe`.
6. Guest Wi-Fi, hotel/campus isolation, access-point client isolation, VPNs, or separate VLANs can prevent device-to-device access even with the same network name. Use a trusted home network, disable only an interfering VPN, or ask the network owner about client isolation. Do not disable the Firewall.
7. If multiple adapters appear, stop the server, select the physical Wi-Fi/Ethernet address in Settings, and start again. Automatic selection favors Wi-Fi, then Ethernet and excludes virtual adapters from automatic hosting.
8. If Wi-Fi disconnects or DHCP changes your address, the desktop reports the missing address. Stop/restart and scan the refreshed QR. Your browser needs new approval after server restart. Known browser identity can still recover partial uploads after approval.
9. Pairing codes refresh every five minutes. Requests wait up to two minutes for desktop approval. Ten requests per source per minute are allowed. If rate-limited, wait a minute.
10. Keep Windows awake, DropBridge open, Safari visible, and the iPhone unlocked while uploading. Server Stop revokes sessions and interrupts current streams. Cancel discards an incomplete upload; Retry resumes verified bytes.

No router port forwarding, UPnP configuration, cloud relay, or automatic Firewall rule changes are made. The server supports private IPv4 Wi-Fi/Ethernet networks; IPv6-only and public-only networks need a private IPv4 network for this version.
