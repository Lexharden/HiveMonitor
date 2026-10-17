/**
 * Prueba visual con Chrome/Edge headless (CDP): registra un usuario demo, crea una organización y
 * un canal mock, y captura pantallas de las vistas principales.
 * Uso: bun scripts/screenshot.ts <outDir> [baseUrl]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? ".shots";
const base = process.argv[3] ?? "http://localhost:3000";
mkdirSync(out, { recursive: true });

const candidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];
const exe = candidates.find((p) => Bun.file(p).size > 0);
if (!exe) throw new Error("No se encontró Edge/Chrome");

const port = 9333;
const proc = spawn(
  exe,
  [
    `--remote-debugging-port=${port}`,
    "--headless=new",
    "--disable-gpu",
    `--user-data-dir=${join(process.cwd(), out, ".profile")}`,
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitJson(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(url)).json();
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error("CDP no disponible");
}
const targets = (await waitJson(`http://127.0.0.1:${port}/json`)) as { type: string; webSocketDebuggerUrl: string }[];
const ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
const logs: string[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
  if (m.method === "Runtime.consoleAPICalled")
    logs.push(`${m.params.type}: ${m.params.args.map((a: any) => a.value ?? a.description).join(" ")}`);
  if (m.method === "Log.entryAdded" && /Content Security Policy|CSP|Refused/i.test(m.params.entry.text))
    logs.push(`CSP: ${m.params.entry.text.slice(0, 200)}`);
  if (m.method === "Runtime.exceptionThrown")
    logs.push(`EXC: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
};
const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJs = async (expr: string) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.result?.value;
};
const shot = async (name: string) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.result.data, "base64"));
  console.log("captura:", name);
};
const goto = async (path: string, wait = 1500) => {
  await send("Page.navigate", { url: base + path });
  await Bun.sleep(wait);
};

await send("Page.enable");
await send("Runtime.enable");

await goto("/login", 4000);
await shot("01-login");

const email = `demo${Date.now()}@test.dev`;
await goto("/register");
const reg = await evalJs(
  `fetch('/api/auth/sign-up/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Demo',email:'${email}',password:'correct-horse-battery'})}).then(r=>r.status)`,
);
console.log("registro:", reg);
if (process.env.DATABASE_URL) Bun.spawnSync(["bun", join(import.meta.dir, "make-superadmin.ts"), email], { env: process.env });
const org = await evalJs(
  `fetch('/api/auth/organization/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Demo Org',slug:'demo-${Date.now()}'})}).then(r=>r.json()).then(j=>j.id)`,
);
console.log("org:", org);
for (const [platform, ch, seed] of [
  ["tiktok", "streamer_tt", 3],
  ["twitch", "streamer_tw", 9],
] as const) {
  await evalJs(
    `fetch('/api/t/${org}/connections',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({platform:'${platform}',channelId:'${ch}',config:{mode:'mock',intervalMs:400,seed:${seed}}})}).then(r=>r.status)`,
  );
}

await goto("/", 9000);
await shot("02-dashboard");
await goto("/chat", 4000);
await shot("03-chat");
await goto("/events", 3000);
await shot("04-events");
await goto("/integrations", 2000);
await shot("05-integrations");
// Cockpit: meta + un momento marcado, y tres tamaños (monitor, tablet horizontal y tablet vertical)
await evalJs(
  `fetch('/api/t/${org}/goal',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Nuevo micrófono',targetUsd:50})}).then(r=>r.status)`,
);
await evalJs(
  `fetch('/api/t/${org}/markers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'Jugada épica'})}).then(r=>r.status)`,
);
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await evalJs(`localStorage.setItem('cockpit_preview', '1')`);
await goto("/cockpit", 9000);
await shot("12-cockpit-monitor");
await send("Log.enable");
console.log(
  "iframe tras clic en Twitch:",
  await evalJs(
    `(() => { const b = [...document.querySelectorAll('[role=tab]')].find((x) => x.textContent.includes('streamer_tw')); b?.click(); return new Promise((r) => setTimeout(() => r(document.querySelector('iframe')?.src ?? 'SIN IFRAME'), 1500)); })()`,
  ),
);
await Bun.sleep(6000);
await shot("12b-cockpit-twitch-preview");
await send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false });
await goto("/cockpit", 4000);
await shot("13-cockpit-tablet-horizontal");
await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 1180, deviceScaleFactor: 1, mobile: true });
await goto("/cockpit", 4000);
await shot("14-cockpit-tablet-vertical");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

await goto("/alerts", 2500);
await shot("08-alerts");
await goto("/members", 2500);
await shot("09-members");
await goto("/settings", 2000);
await shot("10-settings");
await goto("/admin", 3000);
await shot("11-admin");
await goto("/history", 3500);
await shot("07-history");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await goto("/", 4000);
await shot("06-dashboard-mobile");

console.log("consola:", logs.slice(0, 15).join("\n") || "(sin mensajes)");
ws.close();
proc.kill();
process.exit(0);
