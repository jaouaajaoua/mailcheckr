import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function key32(secret: string): Buffer { return createHash("sha256").update(secret).digest(); }

/** AES-256-GCM application-layer encryption for stored email values (PRD §10.1). */
export function encryptValue(plaintext: string, encryptionKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key32(encryptionKey), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${enc.toString("base64url")}`;
}
export function decryptValue(payload: string, encryptionKey: string): string {
  const [, ivB, tagB, encB] = payload.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key32(encryptionKey), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encB, "base64url")), decipher.final()]).toString("utf8");
}
/** Keyed HMAC digest for duplicate lookup — never an unsalted plain hash (PRD §7.5). */
export function hmacDigest(value: string, hmacKey: string): string {
  return createHmac("sha256", hmacKey).update(value).digest("hex");
}
export function sha256Hex(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a); const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
