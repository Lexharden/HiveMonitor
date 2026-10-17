import type { Client, NormalizedEvent } from "@hivemonitor/client";

type Socket = Awaited<ReturnType<ReturnType<Client["tenant"]>["socket"]>>;
type Chat = Extract<NormalizedEvent, { type: "chat" }>;
export type ModAction = "timeout" | "ban" | "delete";

/** Moderación por WebSocket con la conexión reutilizada (se abre al primer uso y se reabre si se cae). */
export function createModerator(client: Client, orgId: string, connectionOf: (m: Chat) => string | undefined) {
  let socket: Promise<Socket> | null = null;
  return async (m: Chat, action: ModAction): Promise<boolean> => {
    const connectionId = connectionOf(m);
    if (!connectionId) return false;
    try {
      socket ??= client.tenant(orgId).socket();
      const ws = await socket;
      const r = await ws.moderate({
        connectionId,
        action,
        targetId: m.actor?.id,
        messageId: m.payload.messageId,
        durationSec: action === "timeout" ? 600 : undefined,
      });
      return r.ok;
    } catch {
      socket = null;
      return false;
    }
  };
}
