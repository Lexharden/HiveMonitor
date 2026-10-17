/**
 * Detección de entorno (navegador vs Tauri) y almacenamiento local.
 * En navegador todo degrada con elegancia: sin Tauri no hay almacén nativo ni notificaciones del sistema.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const STORE_FILE = "hivemonitor.json";
let storePromise: Promise<import("@tauri-apps/plugin-store").Store> | undefined;

async function tauriStore() {
  storePromise ??= import("@tauri-apps/plugin-store").then(({ Store }) => Store.load(STORE_FILE));
  return storePromise;
}

/** Clave-valor persistente: store nativo en Tauri, localStorage en navegador. */
export const kv = {
  async get(key: string): Promise<string | null> {
    try {
      if (isTauri()) return ((await (await tauriStore()).get<string>(key)) ?? null) as string | null;
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string | null): Promise<void> {
    try {
      if (isTauri()) {
        const s = await tauriStore();
        if (value === null) await s.delete(key);
        else await s.set(key, value);
        await s.save();
      } else if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* almacenamiento no disponible: se ignora */
    }
  },
};

/** Abre una URL externa (navegador del sistema en Tauri). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export type Theme = "dark" | "light";

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0f1115" : "#f4f4f2");
}
