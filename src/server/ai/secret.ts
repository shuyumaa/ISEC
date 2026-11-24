import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db";

/*
 * Encryption at rest for provider API keys (AES-256-GCM). The key is derived
 * from SESSION_SECRET, so a copy of the database alone can't reveal the API
 * key. Without SESSION_SECRET a random key is kept in the data folder instead
 * (weaker: it sits next to the database), and a warning is logged.
 */

function masterKey(): Buffer {
  const env = process.env.SESSION_SECRET;
  if (env) return Buffer.from(hkdfSync("sha256", env, "isec", "isec-ai-api-key", 32));
  const file = join(DATA_DIR, ".ai-key");
  if (!existsSync(file)) writeFileSync(file, randomBytes(32), { mode: 0o600 });
  console.warn("[isec] SESSION_SECRET not set — the AI API key is encrypted with a key stored in the data folder.");
  return readFileSync(file);
}

let key: Buffer | undefined;
const k = () => (key ??= masterKey());

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** Undefined when the key changed (e.g. SESSION_SECRET rotated) or the value was tampered with. */
export function open(sealed: string): string | undefined {
  try {
    const [v, iv, tag, body] = sealed.split(".");
    if (v !== "v1" || !iv || !tag || !body) return undefined;
    const d = createDecipheriv("aes-256-gcm", k(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** A separate secret for signing tool approvals sent through the browser. */
export const approvalSecret = () => Buffer.from(hkdfSync("sha256", k(), "isec", "isec-ai-tool-approval", 32)).toString("base64url");
