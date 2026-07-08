import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SECRET_FILE = join(process.cwd(), "data", "app-secret");

export async function getRawSecret(): Promise<Buffer> {
  const fromEnv = process.env.PLAUDE_APP_SECRET;
  if (fromEnv) {
    if (/^[a-f0-9]{64}$/i.test(fromEnv)) return Buffer.from(fromEnv, "hex");
    const base64 = Buffer.from(fromEnv, "base64");
    if (base64.length === 32) return base64;
    return Buffer.from(fromEnv.padEnd(32, "#").slice(0, 32), "utf8");
  }

  try {
    return Buffer.from((await readFile(SECRET_FILE, "utf8")).trim(), "base64");
  } catch {
    const secret = randomBytes(32);
    await mkdir(dirname(SECRET_FILE), { recursive: true });
    await writeFile(SECRET_FILE, secret.toString("base64"), { mode: 0o600 });
    return secret;
  }
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getRawSecret();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export async function decryptSecret(ciphertext: string): Promise<string> {
  const [version, ivB64, tagB64, encryptedB64] = ciphertext.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !encryptedB64) {
    throw new Error("Unsupported encrypted secret format");
  }
  const key = await getRawSecret();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}
