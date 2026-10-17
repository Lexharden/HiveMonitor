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

// --- Notificaciones --------------------------------------------------------------
export type NotifyState = "granted" | "denied" | "default" | "unsupported";

/** Estado del permiso de notificaciones: sistema (Tauri) o navegador (Notification API / PWA). */
export async function notifyState(): Promise<NotifyState> {
  try {
    if (isTauri()) {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      return (await isPermissionGranted()) ? "granted" : "default";
    }
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  } catch {
    return "unsupported";
  }
}

export async function requestNotify(): Promise<NotifyState> {
  try {
    if (isTauri()) {
      const { requestPermission } = await import("@tauri-apps/plugin-notification");
      return (await requestPermission()) === "granted" ? "granted" : "denied";
    }
    if (typeof Notification === "undefined") return "unsupported";
    return await Notification.requestPermission();
  } catch {
    return "unsupported";
  }
}

/** Notificación nativa si hay permiso; si no, no hace nada (el aviso en pantalla ya existe). */
export async function notify(title: string, body: string): Promise<void> {
  try {
    if ((await notifyState()) !== "granted") return;
    if (isTauri()) {
      const { sendNotification } = await import("@tauri-apps/plugin-notification");
      sendNotification({ title, body });
    } else new Notification(title, { body, icon: "/icons/icon-256.png" });
  } catch {
    /* sin soporte */
  }
}

// --- Inicio automático (solo escritorio) ---------------------------------------------
export async function autostartSupported(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    await import("@tauri-apps/plugin-autostart");
    return !/android|iphone|ipad/i.test(navigator.userAgent);
  } catch {
    return false;
  }
}
export async function autostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}
export async function setAutostart(on: boolean): Promise<void> {
  const m = await import("@tauri-apps/plugin-autostart");
  if (on) await m.enable();
  else await m.disable();
}
