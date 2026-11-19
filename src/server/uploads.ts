import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FormError } from "./forms";

/*
 * Admin image uploads (player photos, team logos, trophy photos, news images).
 * The type is decided from the file's own bytes, never from its name or the
 * browser-supplied MIME type, and files get random names.
 */
export const UPLOAD_DIR = resolve(process.env.DATA_DIR ?? "./data", "uploads");
mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX = 5 * 1024 * 1024;
export const UPLOAD_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

function sniff(b: Uint8Array): "png" | "jpg" | "webp" | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return undefined;
}

/** Returns the stored file name, or undefined when no file was chosen. */
export async function saveUpload(form: FormData, field: string, label: string): Promise<string | undefined> {
  const file = form.get(field);
  if (!(file instanceof File) || file.size === 0) return undefined;
  if (file.size > MAX) throw new FormError(`${label} must be 5 MB or smaller.`, field);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = sniff(bytes);
  if (!ext) throw new FormError(`${label} must be a PNG, JPEG or WebP image.`, field);
  const name = `${randomUUID()}.${ext}`;
  await writeFile(join(UPLOAD_DIR, name), bytes);
  return name;
}

export async function removeUpload(name: string | undefined) {
  if (!name || !UPLOAD_NAME.test(name)) return;
  await unlink(join(UPLOAD_DIR, name)).catch(() => {});
}
