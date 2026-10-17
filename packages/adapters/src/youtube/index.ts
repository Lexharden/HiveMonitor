import { NotImplementedError, type AdapterFactory } from "@hivemonitor/core";

/**
 * Adaptador de YouTube Live: stub. Ver docs/youtube-notes.md para las notas de cuota
 * de la API antes de implementarlo.
 */
export const youtubeAdapterFactory: AdapterFactory = () => ({
  platform: "youtube",
  async connect() {
    throw new NotImplementedError("El adaptador de YouTube");
  },
  async disconnect() {},
  status: () => "offline",
});
