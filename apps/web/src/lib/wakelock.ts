/**
 * Mantiene la pantalla encendida (tablet como segundo monitor). Usa la Screen Wake Lock API; el sistema la libera
 * al ocultar la pestaña, así que se vuelve a pedir al regresar.
 */
interface Sentinel {
  release(): Promise<void>;
}

export const wakeLockSupported = () => typeof navigator !== "undefined" && "wakeLock" in navigator;

export function createWakeLock() {
  let sentinel: Sentinel | null = null;
  let wanted = false;

  const acquire = async () => {
    try {
      sentinel = await (navigator as unknown as { wakeLock: { request(t: "screen"): Promise<Sentinel> } }).wakeLock.request("screen");
    } catch {
      sentinel = null; // sin permiso o batería baja: se ignora
    }
  };
  const onVisible = () => {
    if (wanted && document.visibilityState === "visible" && !sentinel) void acquire();
  };

  return {
    async enable(): Promise<boolean> {
      if (!wakeLockSupported()) return false;
      wanted = true;
      document.addEventListener("visibilitychange", onVisible);
      await acquire();
      return sentinel !== null;
    },
    async disable() {
      wanted = false;
      document.removeEventListener("visibilitychange", onVisible);
      const s = sentinel;
      sentinel = null;
      await s?.release().catch(() => {});
    },
  };
}
