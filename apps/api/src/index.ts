/**
 * Punto de entrada del binario único: `hivemonitor [serve|healthcheck|migrate|make-superadmin|version|help]`.
 * Sin argumentos arranca el servidor. Los subcomandos permiten operar sin Bun ni el repositorio
 * (p. ej. `docker compose exec app /app/hivemonitor make-superadmin correo@dominio.com`).
 */
import embedded from "./embedded.generated.ts";

const [cmd = "serve", ...args] = process.argv.slice(2);

const HELP = `HiveMonitor ${embedded.version}

Uso: hivemonitor [comando]

  serve                          Arranca el servidor (por defecto)
  healthcheck                    Comprueba /readyz en el puerto local (código de salida 0/1; para HEALTHCHECK)
  migrate                        Aplica las migraciones pendientes y sale (usa DATABASE_URL)
  make-superadmin <correo>       Marca a un usuario existente como superadmin (--revoke para quitarlo)
  version                        Muestra la versión

La configuración es por variables de entorno (ver .env.example).`;

async function healthcheck(): Promise<number> {
  const port = process.env.PORT ?? "3000";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? 0 : 1;
  } catch {
    return 1;
  }
}

async function migrateCmd(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL es obligatoria");
    return 1;
  }
  const { migrate } = await import("@hivemonitor/db");
  const applied = await migrate(url, {
    files: embedded.migrations ?? undefined,
    appRolePassword: process.env.DATABASE_APP_PASSWORD,
    log: console.log,
  });
  console.log(applied.length ? `${applied.length} migraciones aplicadas` : "sin migraciones pendientes");
  return 0;
}

async function superadminCmd(): Promise<number> {
  const email = args.find((a) => !a.startsWith("--"));
  const revoke = args.includes("--revoke");
  const url = process.env.DATABASE_URL;
  if (!email || !url) {
    console.error("Uso: DATABASE_URL=… hivemonitor make-superadmin <correo> [--revoke]");
    return 1;
  }
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 1 });
  try {
    const rows = await sql`update "user" set is_superadmin = ${!revoke} where lower(email) = lower(${email}) returning id`;
    if (rows.length === 0) {
      console.error(`No existe un usuario con el correo ${email}. Regístrate primero.`);
      return 1;
    }
    console.log(`${email}: superadmin = ${!revoke}`);
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

switch (cmd) {
  case "serve":
    await import("./server.ts");
    break;
  case "healthcheck":
    process.exit(await healthcheck());
    break;
  case "migrate":
    process.exit(await migrateCmd());
    break;
  case "make-superadmin":
    process.exit(await superadminCmd());
    break;
  case "version":
  case "--version":
    console.log(embedded.version);
    process.exit(0);
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    process.exit(0);
    break;
  default:
    console.error(`Comando desconocido: ${cmd}\n\n${HELP}`);
    process.exit(2);
}
