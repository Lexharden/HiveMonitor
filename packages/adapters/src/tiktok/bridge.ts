import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TikTokClientFactory, TikTokClientLike } from "./index.ts";

/**
 * Cliente de TikTok basado en `apps/tiktok-bridge` (Rust + `piratetok-live-rs`): sin servicio de firma ni API key.
 * Lanza un proceso por canal, lee un evento JSON por línea y lo traduce a la forma que consume `TikTokAdapter`.
 * Cerrar el proceso (stdin + SIGTERM) equivale a desconectar.
 */
export interface BridgeOptions {
  /** Ruta del ejecutable `tiktok-bridge`. */
  bridgePath: string;
  maxRetries?: number;
  proxy?: string;
  cookies?: string;
  /** Inyectable para pruebas. */
  spawn?: (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;
}

// El clasificador del adaptador reconoce los errores por `name`; se fija de forma explícita para que
// sobreviva a cualquier minificado del binario (que renombra las clases).
class UserOfflineError extends Error {
  override name = "UserOfflineError";
}
class InvalidUniqueIdError extends Error {
  override name = "InvalidUniqueIdError";
}
class SignatureRateLimitError extends Error {
  override name = "SignatureRateLimitError";
  retryAfter = 120; // segundos
}

type Json = Record<string, any>;

const EXIT_ERRORS: Record<number, () => Error> = {
  10: () => new UserOfflineError("el canal no está en directo"),
  11: () => new InvalidUniqueIdError("el usuario de TikTok no existe"),
  12: () => new SignatureRateLimitError("TikTok bloqueó o limitó la conexión"),
};

function errorFor(kind: string | undefined, message: string): Error {
  if (kind === "offline") return new UserOfflineError(message);
  if (kind === "not_found") return new InvalidUniqueIdError(message);
  if (kind === "blocked") return new SignatureRateLimitError(message);
  return new Error(message);
}

/** Forma "legacy" del usuario (la que entiende `actorOf` del adaptador). */
const legacyUser = (u: Json | null | undefined) =>
  u ? { userId: u.id, uniqueId: u.handle ?? u.id, nickname: u.name, profilePicture: { urls: u.avatar ? [u.avatar] : [] } } : undefined;

export function createBridgeClientFactory(opts: BridgeOptions): TikTokClientFactory {
  const spawn = opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }));

  return (uniqueId): TikTokClientLike => {
    const handlers = new Map<string, ((d: any) => void)[]>();
    const fire = (event: string, data: unknown) => {
      for (const h of handlers.get(event) ?? []) {
        try {
          h(data);
        } catch {
          /* un oyente roto no tira el puente */
        }
      }
    };
    let proc: ChildProcessWithoutNullStreams | undefined;
    let stopping = false;
    let ended = false;

    const translate = (m: Json) => {
      switch (m.t) {
        case "chat":
          fire("chat", { comment: m.text, msgId: m.id, user: legacyUser(m.user) });
          break;
        case "gift": {
          const count = Math.max(1, Number(m.count) || 1);
          // El puente ya agregó la racha: llega un único evento final con el total
          fire("gift", {
            user: legacyUser(m.user),
            msgId: m.id,
            repeatCount: count,
            repeatEnd: true,
            giftDetails: { giftType: 2, giftName: m.name ?? undefined, diamondCount: Math.round((Number(m.diamonds) || 0) / count) },
          });
          break;
        }
        case "like":
          fire("like", { likeCount: m.count, msgId: m.id, user: legacyUser(m.user) });
          break;
        case "follow":
          fire("follow", { msgId: m.id, user: legacyUser(m.user) });
          break;
        case "share":
          fire("share", { msgId: m.id, user: legacyUser(m.user) });
          break;
        case "viewers":
          fire("roomUser", { viewerCount: m.count });
          break;
        case "ended":
          ended = true;
          fire("streamEnd", {});
          break;
      }
    };

    return {
      on(event, listener) {
        handlers.set(event, [...(handlers.get(event) ?? []), listener]);
        return this;
      },

      connect() {
        return new Promise<void>((resolve, reject) => {
          const args = [uniqueId.replace(/^@/, "")];
          if (opts.maxRetries !== undefined) args.push("--max-retries", String(opts.maxRetries));
          if (opts.proxy) args.push("--proxy", opts.proxy);
          if (opts.cookies) args.push("--cookies", opts.cookies);

          let p: ChildProcessWithoutNullStreams;
          try {
            p = spawn(opts.bridgePath, args);
          } catch (err) {
            return reject(new Error(`no se pudo iniciar tiktok-bridge: ${(err as Error).message}`));
          }
          proc = p;
          let settled = false;
          let buf = "";
          let failure: Error | undefined;
          let stderrTail = "";

          p.stderr.on("data", (c: Buffer) => (stderrTail = (stderrTail + c.toString()).slice(-300)));
          p.on("error", (err) => {
            if (!settled) {
              settled = true;
              reject(new Error(`no se pudo iniciar tiktok-bridge (${opts.bridgePath}): ${err.message}`));
            }
          });
          p.stdout.on("data", (chunk: Buffer) => {
            buf += chunk.toString();
            let i: number;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i).trim();
              buf = buf.slice(i + 1);
              if (!line) continue;
              let m: Json;
              try {
                m = JSON.parse(line);
              } catch {
                continue; // ruido que no es JSON
              }
              if (m.t === "connected" && !settled) {
                settled = true;
                resolve();
              } else if (m.t === "error") failure = errorFor(m.kind, String(m.message ?? "error"));
              else translate(m);
            }
          });
          p.on("close", (code) => {
            proc = undefined;
            if (!settled) {
              settled = true;
              reject(failure ?? EXIT_ERRORS[code ?? -1]?.() ?? new Error(`tiktok-bridge terminó (código ${code}) ${stderrTail}`.trim()));
              return;
            }
            if (!stopping && !ended) fire("disconnected", { code });
          });
        });
      },

      async disconnect() {
        stopping = true;
        const p = proc;
        proc = undefined;
        if (!p) return;
        // Cerrar stdin le indica al puente que termine; SIGTERM por si acaso
        p.stdin.end();
        p.kill();
        await new Promise<void>((r) => {
          const t = setTimeout(() => (p.kill("SIGKILL"), r()), 2000);
          p.once("close", () => (clearTimeout(t), r()));
        });
      },
    };
  };
}
