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

export function createLogger(config: Pick<Config, "LOG_LEVEL" | "NODE_ENV">): Logger {
  return pino({
    level: config.NODE_ENV === "test" ? "silent" : config.LOG_LEVEL,
    redact: { paths: REDACT, censor: "[redacted]" },
    base: { app: "hivemonitor" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
