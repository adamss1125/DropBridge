import os from "node:os";

export function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  return (
    p.length === 4 &&
    p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (p[0] === 10 ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31))
  );
}
export function networkAdapters(interfaces = os.networkInterfaces()) {
  const adapters = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const a of addresses || []) {
      if (a.family !== "IPv4" || a.internal || !isPrivateIPv4(a.address))
        continue;
      const virtual =
        /virtual|vmware|vethernet|hyper-v|wsl|docker|loopback|vpn|tailscale|zerotier|hamachi|tunnel|tap|wireguard/i.test(
          name,
        );
      const score =
        (virtual ? -100 : 10) +
        (/wi-fi|wifi|wireless|wlan/i.test(name)
          ? 30
          : /ethernet/i.test(name)
            ? 20
            : 0);
      adapters.push({ name, address: a.address, virtual, score });
    }
  }
  return adapters.sort((a, b) => b.score - a.score);
}
