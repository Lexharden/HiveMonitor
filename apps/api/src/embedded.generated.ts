/**
 * Recursos embebidos en el binario (frontend y migraciones). Este archivo es un STUB: `scripts/build-binary.ts`
 * lo sustituye temporalmente durante la compilación y lo restaura después. Fuera del binario no hay nada embebido.
 */
export interface Embedded {
  /** ruta pública (p. ej. `index.html`, `_app/immutable/x.js`) → ruta del archivo embebido */
  web: Record<string, string> | null;
  migrations: { name: string; sql: string }[] | null;
  version: string;
}

const embedded: Embedded = { web: null, migrations: null, version: "dev" };
export default embedded;
