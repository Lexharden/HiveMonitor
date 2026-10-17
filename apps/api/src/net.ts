import { isIP } from "node:net";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

/** Normaliza `::ffff:1.2.3.4` a `1.2.3.4`. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip.toLowerCase();
}

export function ipInList(ip: string, list: readonly string[]): boolean {
  const addr = normalizeIp(ip);
  for (const entry of list) {
    if (entry.includes("/")) {
      const [net, bitsStr] = entry.split("/") as [string, string];
      const bits = Number(bitsStr);
      if (isIP(net) === 4 && isIP(addr) === 4 && bits >= 0 && bits <= 32) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if ((ipv4ToInt(addr) & mask) === (ipv4ToInt(net) & mask)) return true;
      }
    } else if (normalizeIp(entry) === addr) {
      return true;
    }
  }
  return false;
}

/**
 * IP real del cliente. Solo se confía en X-Forwarded-For si la conexión directa
 * proviene de un proxy de confianza; se recorre de derecha a izquierda y se toma
 * la primera dirección que no sea de confianza.
 */
export function clientIp(remote: string | undefined, forwardedFor: string | null | undefined, trusted: readonly string[]): string {
  const direct = remote ? normalizeIp(remote) : "unknown";
  if (!forwardedFor || direct === "unknown" || !ipInList(direct, trusted)) return direct;
  const hops = forwardedFor
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i]!);
    if (!ipInList(hop, trusted)) return hop;
  }
  return hops[0] ? normalizeIp(hops[0]) : direct;
}
