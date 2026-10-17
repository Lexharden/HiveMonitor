import pino, { type Logger } from "pino";
import type { Config } from "./config.ts";

export type { Logger };

/** Claves que nunca deben aparecer en los logs. */
const REDACT = [
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "secret",
  "authorization",
  "cookie",
  "credentials",
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.password",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.credentials",
];

export interface ErrorEntry {
  at: string;
  level: "error" | "fatal";
  msg: string;
  detail?: string;
}

/** Últimos errores del servidor para la vista superadmin (solo en memoria; mensaje y texto del error, sin objetos). */
export const recentErrors: ErrorEntry[] = [];
const MAX_ERRORS = 50;

export function createLogger(config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">): Logger {
  return pino({
    level: config.NODE_ENV === "test" && !process.env.HIVE_TEST_LOGS ? "silent" : config.LOG_LEVEL,
    redact: { paths: REDACT, censor: "[redacted]" },
    base: { app: "hivemonitor" },
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method, level) {
        if (level >= 50) {
          const [first, second] = args as unknown as [unknown, unknown];
          const msg = typeof first === "string" ? first : typeof second === "string" ? second : "error";
          const err = (first as { err?: { message?: string } } | undefined)?.err;
          recentErrors.push({ at: new Date().toISOString(), level: level >= 60 ? "fatal" : "error", msg: msg.slice(0, 200), detail: typeof err?.message === "string" ? err.message.slice(0, 300) : undefined });
          if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
        }
        return method.apply(this, args);
      },
    },
  });
}
