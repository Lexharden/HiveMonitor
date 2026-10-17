import type { Helix } from "./helix.ts";
import { subscribeAll, unsubscribeAll } from "./subscribe.ts";
import type { EventSubAttachment, EventSubListener, EventSubTransport } from "./types.ts";

export const TWITCH_WS_URL = "wss://eventsub.wss.twitch.tv/ws";

export interface WsTransportOptions {
  helix: Helix;
  url?: string;
  /** Inyectable para pruebas. */
  WebSocketImpl?: typeof WebSocket;
  /** Tiempo máximo para recibir `session_welcome` (Twitch exige crear las suscripciones en 10 s). */
  welcomeTimeoutMs?: number;
}

/**
 * Transporte EventSub por WebSocket: pensado para desarrollo local (no requiere URL pública).
 * Una conexión por canal, con el token de usuario. Gestiona keepalive, `session_reconnect` y deduplicación.
 */
export function createWebSocketTransport(opts: WsTransportOptions): EventSubTransport {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const url = opts.url ?? TWITCH_WS_URL;

  return {
    async attach({ broadcasterId, userToken, scopes, listener }): Promise<EventSubAttachment> {
      let ws: WebSocket | undefined;
      let subIds: string[] = [];
      let closedByUs = false;
      let keepaliveMs = 15_000;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const seen = new Set<string>();

      const armWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        // Twitch recomienda tolerar el keepalive + margen
        watchdog = setTimeout(() => fail("sin actividad de EventSub (keepalive vencido)"), keepaliveMs * 1.5 + 2000);
      };
      const fail = (reason: string) => {
        if (closedByUs) return;
        closedByUs = true;
        if (watchdog) clearTimeout(watchdog);
        try {
          ws?.close();
        } catch {
          /* ya cerrado */
        }
        listener.onClosed(reason);
      };

      function open(target: string, onWelcome: (sessionId: string) => void, isReconnect: boolean): WebSocket {
        const sock = new WS(target);
        sock.onmessage = (ev) => {
          let msg: any;
          try {
            msg = JSON.parse(String(ev.data));
          } catch {
            return;
          }
          armWatchdog();
          const meta = msg.metadata ?? {};
          if (meta.message_id) {
            if (seen.has(meta.message_id)) return;
            seen.add(meta.message_id);
            if (seen.size > 500) seen.delete(seen.values().next().value as string);
          }
          switch (meta.message_type) {
            case "session_welcome":
              if (msg.payload?.session?.keepalive_timeout_seconds) keepaliveMs = msg.payload.session.keepalive_timeout_seconds * 1000;
              if (isReconnect) {
                // La sesión nueva hereda las suscripciones: se cierra la antigua
                const old = ws;
                ws = sock;
                old?.close();
              } else ws = sock;
              armWatchdog();
              onWelcome(String(msg.payload.session.id));
              break;
            case "session_reconnect":
              open(String(msg.payload.session.reconnect_url), () => {}, true);
              break;
            case "notification":
              listener.onNotification({
                type: String(meta.subscription_type),
                version: String(meta.subscription_version ?? "1"),
                event: msg.payload.event ?? {},
                messageId: String(meta.message_id),
                timestamp: meta.message_timestamp,
              });
              break;
            case "revocation":
              listener.onRevoked(String(msg.payload?.subscription?.type ?? "?"), String(msg.payload?.subscription?.status ?? "revoked"));
              break;
          }
        };
        sock.onclose = () => {
          if (sock === ws) fail("conexión EventSub cerrada");
        };
        sock.onerror = () => {
          if (sock === ws || !ws) fail("error en la conexión EventSub");
        };
        return sock;
      }

      const sessionId = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          closedByUs = true;
          try {
            ws?.close();
          } catch {
            /* nada */
          }
          reject(new Error("EventSub no respondió (session_welcome)"));
        }, opts.welcomeTimeoutMs ?? 10_000);
        const s = open(url, (id) => (clearTimeout(timer), resolve(id)), false);
        s.onerror = () => (clearTimeout(timer), closedByUs || reject(new Error("no se pudo abrir el WebSocket de EventSub")));
        ws = s;
      });

      const token = await userToken();
      const result = await subscribeAll(opts.helix, token, { method: "websocket", session_id: sessionId }, broadcasterId, scopes);
      subIds = result.ids;

      return {
        async detach() {
          closedByUs = true;
          if (watchdog) clearTimeout(watchdog);
          try {
            ws?.close();
          } catch {
            /* nada */
          }
          // Las suscripciones de WebSocket mueren con la sesión; se borran por limpieza
          await unsubscribeAll(opts.helix, await userToken().catch(() => token), subIds).catch(() => {});
        },
      };
    },
  };
}

export type { EventSubListener };
