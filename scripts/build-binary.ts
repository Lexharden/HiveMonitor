/**
 * Compila el servidor en un binario único con el frontend y las migraciones embebidos.
 *
 *   bun scripts/build-binary.ts                     # binario para esta máquina → dist/
 *   bun scripts/build-binary.ts --targets linux-x64,linux-arm64,windows-x64
 *   bun scripts/build-binary.ts --skip-web          # reutiliza apps/web/build ya generado
 *
 * Mecanismo: se genera `apps/api/src/embedded.generated.ts` con `import … with { type: "file" | "text" }`
 * (Bun incrusta esos archivos en el ejecutable), se compila y se RESTAURA el stub original.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const apiSrc = join(root, "apps/api/src");
const webBuild = join(root, "apps/web/build");
const migrationsDir = join(root, "packages/db/migrations");
const generated = join(apiSrc, "embedded.generated.ts");
const outDir = join(root, "dist");

const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const skipWeb = args.includes("--skip-web");

const hostTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const targets = (flag("targets") ?? hostTarget).split(",").map((t) => t.trim());

function run(cmd: string[], cwd = root) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`falló: ${cmd.join(" ")}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function version(): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root }).stdout.toString().trim();
  return sha ? `${pkg.version}+${sha}` : pkg.version;
}

const original = readFileSync(generated, "utf8");
try {
  if (!skipWeb) run(["bun", "--filter", "@hivemonitor/web", "build"]);

  const web = walk(webBuild).map((p) => relative(webBuild, p).replaceAll("\\", "/"));
  const migrations = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const rel = (p: string) => relative(apiSrc, p).replaceAll("\\", "/");

  const code = [
    `// GENERADO por scripts/build-binary.ts — no editar ni commitear`,
    ...web.map((f, i) => `import w${i} from "${rel(join(webBuild, f))}" with { type: "file" };`),
    ...migrations.map((f, i) => `import m${i} from "${rel(join(migrationsDir, f))}" with { type: "text" };`),
    `export interface Embedded { web: Record<string, string> | null; migrations: { name: string; sql: string }[] | null; version: string }`,
    `const embedded: Embedded = {`,
    `  web: { ${web.map((f, i) => `${JSON.stringify(f)}: w${i}`).join(", ")} },`,
    `  migrations: [${migrations.map((f, i) => `{ name: ${JSON.stringify(f)}, sql: m${i} }`).join(", ")}],`,
    `  version: ${JSON.stringify(version())},`,
    `};`,
    `export default embedded;`,
    ``,
  ].join("\n");
  writeFileSync(generated, code);

  mkdirSync(outDir, { recursive: true });
  for (const t of targets) {
    const exe = t.startsWith("windows") ? ".exe" : "";
    const out = join(outDir, `hivemonitor-${t}${exe}`);
    console.log(`\n→ compilando ${t}`);
    run(["bun", "build", "--compile", "--minify", `--target=bun-${t}`, "--outfile", out, join(apiSrc, "index.ts")]);
    console.log(`  ${out} (${(statSync(out).size / 1048576).toFixed(0)} MB)`);
  }
  console.log(`\nincrustados: ${web.length} archivos web, ${migrations.length} migraciones · versión ${version()}`);
} finally {
  writeFileSync(generated, original); // restaura el stub
}
