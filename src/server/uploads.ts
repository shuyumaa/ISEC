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
mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

const MAX = 5 * 1024 * 1024;
export const UPLOAD_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

function sniff(b: Uint8Array): "png" | "jpg" | "webp" | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "webp";
  return undefined;
}

/*
 * Metadata stripping: photos often carry GPS coordinates, camera serials and
 * author names (EXIF/XMP/IPTC). Only the image data is kept. Malformed files
 * are rejected rather than stored as-is.
 */
function stripPng(b: Uint8Array): Uint8Array {
  const drop = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
  const out: Uint8Array[] = [b.subarray(0, 8)];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 12 <= b.length) {
    const len = v.getUint32(i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > b.length) throw new Error("truncated");
    if (!drop.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error("bad marker");
    const marker = b[i + 1];
    // Start of scan: the rest is entropy-coded image data.
    if (marker === 0xda) {
      out.push(b.subarray(i));
      return Buffer.concat(out);
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    const end = i + 2 + len;
    if (end > b.length) throw new Error("truncated");
    // Drop APP1 (EXIF/XMP), APP3–APP15 (vendor, IPTC) and comments; keep APP0 (JFIF) and APP2 (ICC colour).
    const metadata = (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2) || marker === 0xfe;
    if (!metadata) out.push(b.subarray(i, end));
    i = end;
  }
  throw new Error("no image data");
}

function stripWebp(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 12;
  while (i + 8 <= b.length) {
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    const len = v.getUint32(i + 4, true);
    const end = i + 8 + len + (len & 1);
    if (i + 8 + len > b.length) throw new Error("truncated");
    if (type !== "EXIF" && type !== "XMP ") {
      const chunk = Buffer.from(b.subarray(i, Math.min(end, b.length)));
      if (type === "VP8X") chunk[8] &= ~(0x08 | 0x04); // clear EXIF and XMP flags
      out.push(chunk);
    }
    i = end;
  }
  const body = Buffer.concat(out);
  const head = Buffer.from(b.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

const strip = { png: stripPng, jpg: stripJpeg, webp: stripWebp };

/** Returns the stored file name, or undefined when no file was chosen. */
export async function saveUpload(form: FormData, field: string, label: string): Promise<string | undefined> {
  const file = form.get(field);
  if (!(file instanceof File) || file.size === 0) return undefined;
  if (file.size > MAX) throw new FormError(`${label} must be 5 MB or smaller.`, field);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = sniff(bytes);
  if (!ext) throw new FormError(`${label} must be a PNG, JPEG or WebP image.`, field);
  let clean: Uint8Array;
  try {
    clean = strip[ext](bytes);
  } catch {
    throw new FormError(`${label} looks damaged; re-export it and try again.`, field);
  }
  const name = `${randomUUID()}.${ext}`;
  await writeFile(join(UPLOAD_DIR, name), clean, { mode: 0o600 });
  return name;
}

export async function removeUpload(name: string | undefined) {
  if (!name || !UPLOAD_NAME.test(name)) return;
  await unlink(join(UPLOAD_DIR, name)).catch(() => {});
}
