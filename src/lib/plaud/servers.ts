export const PLAUD_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

export const PLAUD_SERVERS = {
  global: "https://api.plaud.ai",
  eu: "https://api-euc1.plaud.ai",
  apac: "https://api-apse1.plaud.ai",
  apne1: "https://api-apne1.plaud.ai"
} as const;

export const DEFAULT_PLAUD_API_BASE = PLAUD_SERVERS.global;

export function isValidPlaudApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "plaud.ai" || parsed.hostname.endsWith(".plaud.ai"))
    );
  } catch {
    return false;
  }
}

export function normalizePlaudApiBase(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.hostname}`;
}
