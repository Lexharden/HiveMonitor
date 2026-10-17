import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { EVENT_PERMISSION, type BusMessage, type Permission } from "@hivemonitor/core";
import { audit } from "../audit.ts";
import type { AppDeps, AppEnv, TenantContext } from "../context.ts";
import { requireTenant } from "../middleware.ts";

const MAX_STREAMS_PER_USER = 8;
const STREAM_LIFETIME_MS = 30 * 60_000; // el cliente reconecta y se reevalúan los permisos
const HEARTBEAT_MS = 15_000;

/** Un mensaje del bus es visible si el usuario tiene el permiso del tipo de evento. */
export function canSee(perms: ReadonlySet<Permission>, m: BusMessage): boolean {
  if (m.kind === "status" || m.kind === "alert" || m.kind === "heartbeat" || m.kind === "marker") return perms.has("stream.view");
  return perms.has(EVENT_PERMISSION[m.event.type]);
}

const wsMessageSchema = z.object({
  type: z.literal("moderate"),
  id: z.string().max(64).optional(),
  connectionId: z.string(),
  action: z.enum(["ban", "timeout", "delete", "unban"]),
  targetId: z.string().max(256).optional(),
  messageId: z.string().max(256).optional(),
  durationSec: z.number().int().positive().max(1_209_600).optional(),
  reason: z.string().max(500).optional(),
});

export function realtimeRoutes(deps: AppDeps) {
  const r = new Hono<AppEnv>();
  const open = new Map<string, number>();

  /**
   * SSE por tenant. Primero un `snapshot` (estado + eventos recientes), luego mensajes
   * en vivo filtrados por los permisos del usuario conectado.
   */
  r.get("/stream", requireTenant(deps, "stream.view"), (c) => {
    const t = c.get("tenant");
    const count = open.get(t.userId) ?? 0;
    if (count >= MAX_STREAMS_PER_USER) return c.json({ error: "too_many_streams" }, 429);
    open.set(t.userId, count + 1);

    c.header("X-Accel-Buffering", "no"); // nginx: sin buffering
    c.header("Cache-Control", "no-cache, no-transform");

    return streamSSE(c, async (stream) => {
      const { ingest, bus } = deps;
      const visibleRecent = ingest.pipeline.recent(t.tenantId).filter((e) => t.permissions.has(EVENT_PERMISSION[e.type]));
      await stream.writeSSE({
        event: "snapshot",
        data: JSON.stringify({
          connections: ingest.supervisor.list(t.tenantId),
          channels: ingest.pipeline.liveState(t.tenantId),
          recent: visibleRecent,
          permissions: [...t.permissions],
        }),
      });

      const unsubscribe = bus.subscribe(t.tenantId, (m) => {
        if (!canSee(t.permissions, m)) return;
        stream
          .writeSSE(
            m.kind === "event"
              ? { id: m.event.id, event: "event", data: JSON.stringify(m.event) }
              : m.kind === "alert"
                ? { id: m.alert.id, event: "alert", data: JSON.stringify(m.alert) }
                : m.kind === "marker"
                  ? { id: m.marker.id, event: "marker", data: JSON.stringify(m.marker) }
                  : m.kind === "heartbeat"
                    ? { event: "heartbeat", data: JSON.stringify(m.heartbeat) }
                    : { event: "status", data: JSON.stringify({ platform: m.platform, channelId: m.channelId, ...m.change }) },
          )
          .catch(() => {});
      });

      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        let closed = false;
        const hb = setInterval(() => stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), HEARTBEAT_MS);
        const life = setTimeout(() => {
          void stream.writeSSE({ event: "reconnect", data: "lifetime" }).finally(() => finish());
        }, STREAM_LIFETIME_MS);
        finish = () => {
          if (closed) return;
          closed = true;
          clearInterval(hb);
          clearTimeout(life);
          unsubscribe();
          open.set(t.userId, Math.max(0, (open.get(t.userId) ?? 1) - 1));
          resolve();
        };
      });
      stream.onAbort(() => finish());
      await done;
    });
  });

  /**
   * WebSocket para acciones bidireccionales (moderación). Los eventos en vivo van por SSE.
   * Auth del cliente Tauri: subprotocolo `bearer.<token>` (se convierte en cabecera Authorization
   * antes de llegar aquí, ver app.ts) o cookie de sesión en la web.
   */
  r.get(
    "/ws",
    requireTenant(deps, "stream.view"),
    upgradeWebSocket((c) => {
      const t = (c as unknown as { get(k: "tenant"): TenantContext }).get("tenant");
      const ip = (c as unknown as { get(k: "ip"): string }).get("ip");
      const recent: number[] = [];
      return {
        onMessage: async (evt, ws) => {
          const now = Date.now();
          while (recent.length && recent[0]! < now - 10_000) recent.shift();
          if (recent.length >= 20) return ws.send(JSON.stringify({ type: "error", error: "rate_limited" }));
          recent.push(now);

          let json: unknown;
          try {
            json = JSON.parse(typeof evt.data === "string" ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer));
          } catch {
            return ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
          }
          if ((json as { type?: string })?.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
          const msg = wsMessageSchema.safeParse(json);
          if (!msg.success) return ws.send(JSON.stringify({ type: "error", error: "invalid_message" }));
          const m = msg.data;
          const ack = (ok: boolean, error?: string) => ws.send(JSON.stringify({ type: "ack", id: m.id, ok, error }));

          if (!t.permissions.has("chat.moderate")) return ack(false, "forbidden");
          try {
            await deps.ingest.supervisor.moderate(m.connectionId, t.tenantId, {
              action: m.action,
              targetId: m.targetId,
              messageId: m.messageId,
              durationSec: m.durationSec,
              reason: m.reason,
            });
            await audit(deps.appDb, {
              tenantId: t.tenantId,
              actorUserId: t.userId,
              action: `moderation.${m.action}`,
              target: m.targetId ?? m.messageId,
              meta: { connectionId: m.connectionId, reason: m.reason, durationSec: m.durationSec },
              ip,
            });
            ack(true);
          } catch (err) {
            ack(false, (err as Error).message === "moderation_not_supported" ? "not_supported" : "failed");
          }
        },
      };
    }),
  );

  return r;
}
