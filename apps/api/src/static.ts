import { createHash } from "node:crypto";
import { extname, join, normalize, sep } from "node:path";

export interface StaticAsset {
  body: BodyInit;
  type: string;
}

/** Origen de los archivos del frontend: directorio en disco o mapa embebido en el binario. */
export interface StaticSource {
  get(path: string): Promise<StaticAsset | null>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};
export const contentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";

export function dirSource(root: string): StaticSource {
  const base = normalize(root);
  return {
    async get(path) {
      const full = normalize(join(base, path));
      if (full !== base && !full.startsWith(base + sep)) return null; // path traversal
      const file = Bun.file(full);
      if (!(await file.exists()) || (file.size === 0 && !extname(full))) return null;
      return { body: file, type: contentType(full) };
    },
  };
}

/** Hashes sha256 de los `<script>` en línea, para permitirlos en la CSP sin `unsafe-inline`. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    if (m[1]?.trim()) out.push(`'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  }
  return out;
}

/**
 * Sirve el SPA: archivos con caché larga si están versionados (`/_app/immutable/`),
 * `index.html` como fallback de rutas del cliente y CSP con hashes de los scripts en línea.
 */
export function createStaticHandler(source: StaticSource, baseCsp: (scriptHashes: string[]) => string) {
  let indexCache: { html: string; csp: string } | undefined;

  async function index() {
    if (indexCache) return indexCache;
    const asset = await source.get("index.html");
    if (!asset) return null;
    const html = await new Response(asset.body).text();
    indexCache = { html, csp: baseCsp(inlineScriptHashes(html)) };
    return indexCache;
  }

  return async (req: Request): Promise<Response | null> => {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const path = decodeURIComponent(new URL(req.url).pathname);
    if (path !== "/" && !path.endsWith("/")) {
      const asset = await source.get(path.slice(1));
      if (asset) {
        const immutable = path.includes("/_app/immutable/");
        return new Response(asset.body, {
          headers: {
            "content-type": asset.type,
            "cache-control": immutable ? "public, max-age=31536000, immutable" : path === "/service-worker.js" ? "no-cache" : "public, max-age=300",
          },
        });
      }
      if (extname(path)) return null; // archivo inexistente: 404 real, no el SPA
    }
    const idx = await index();
    if (!idx) return null;
    return new Response(idx.html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "content-security-policy": idx.csp },
    });
  };
}
