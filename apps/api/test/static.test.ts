import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler, dirSource, inlineScriptHashes } from "../src/static.ts";

let dir: string;
let handle: ReturnType<typeof createStaticHandler>;
const get = (p: string) => handle(new Request(`http://x${p}`));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-web-"));
  await mkdir(join(dir, "_app/immutable"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<html><script>window.a=1</script><script src='/x.js'></script></html>");
  await writeFile(join(dir, "_app/immutable/app.js"), "console.log(1)");
  await writeFile(join(dir, "secret.txt"), "no");
  handle = createStaticHandler(dirSource(join(dir, "_app")), () => "unused");
  handle = createStaticHandler(dirSource(dir), (h) => `script-src 'self' ${h.join(" ")}`);
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

describe("servidor estático del SPA", () => {
  test("rutas del cliente devuelven index.html con CSP que incluye el hash del script en línea", async () => {
    const r = (await get("/dashboard/x"))!;
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-security-policy")).toMatch(/sha256-/);
    expect(r.headers.get("cache-control")).toBe("no-cache");
  });
  test("los assets versionados llevan caché inmutable", async () => {
    const r = (await get("/_app/immutable/app.js"))!;
    expect(r.headers.get("cache-control")).toContain("immutable");
    expect(r.headers.get("content-type")).toContain("javascript");
  });
  test("un archivo inexistente con extensión no cae al SPA", async () => {
    expect(await get("/nope.js")).toBeNull();
  });
  test("no permite path traversal ni métodos que no sean GET", async () => {
    expect(await get("/..%2f..%2fetc/passwd.txt")).toBeNull();
    expect(await handle(new Request("http://x/", { method: "POST" }))).toBeNull();
  });
  test("solo se hashean scripts en línea, no los externos", () => {
    expect(inlineScriptHashes("<script>a</script><script src=\"/a.js\"></script>")).toHaveLength(1);
  });
});
