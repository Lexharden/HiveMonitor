import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Formato del blob cifrado: [versión de clave (1 byte)] [nonce 12] [tag 16] [ciphertext].
 * AES-256-GCM. El byte de versión permite rotar ENCRYPTION_KEY sin romper datos viejos.
 */
export interface Encryptor {
  readonly keyVersion: number;
  encrypt(plain: string | Uint8Array): Uint8Array;
  decrypt(blob: Uint8Array): string;
}

export function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY debe ser de 32 bytes en base64 (openssl rand -base64 32)");
  }
  return key;
}

/** `keys` mapea versión → clave; la versión más alta se usa para cifrar. */
export function createEncryptor(keys: Map<number, Buffer>): Encryptor {
  const current = Math.max(...keys.keys());
  const key = keys.get(current)!;
  return {
    keyVersion: current,
    encrypt(plain) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const data = typeof plain === "string" ? Buffer.from(plain, "utf8") : Buffer.from(plain);
      const ct = Buffer.concat([cipher.update(data), cipher.final()]);
      return Buffer.concat([Buffer.from([current]), nonce, cipher.getAuthTag(), ct]);
    },
    decrypt(blob) {
      const buf = Buffer.from(blob);
      if (buf.length < 1 + 12 + 16) throw new Error("Blob cifrado inválido");
      const version = buf[0]!;
      const k = keys.get(version);
      if (!k) throw new Error(`Clave de cifrado v${version} no disponible`);
      const decipher = createDecipheriv("aes-256-gcm", k, buf.subarray(1, 13));
      decipher.setAuthTag(buf.subarray(13, 29));
      return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8");
    },
  };
}

export function createEncryptorFromEnv(b64: string): Encryptor {
  return createEncryptor(new Map([[1, parseKey(b64)]]));
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
