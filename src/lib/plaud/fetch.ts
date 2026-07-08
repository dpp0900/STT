import { PLAUD_USER_AGENT } from "@/lib/plaud/servers";

const PLAUD_WEB_ORIGIN = "https://web.plaud.ai";

function browserHeaders(callerHeaders: HeadersInit | undefined): Headers {
  const headers = new Headers();
  headers.set("sec-ch-ua", '"Google Chrome";v="142", "Chromium";v="142", "Not?A_Brand";v="24"');
  headers.set("sec-ch-ua-mobile", "?0");
  headers.set("sec-ch-ua-platform", '"Windows"');
  headers.set("accept", "application/json, text/plain, */*");
  headers.set("user-agent", PLAUD_USER_AGENT);
  headers.set("origin", PLAUD_WEB_ORIGIN);
  headers.set("sec-fetch-site", "same-site");
  headers.set("sec-fetch-mode", "cors");
  headers.set("sec-fetch-dest", "empty");
  headers.set("referer", `${PLAUD_WEB_ORIGIN}/`);
  headers.set("accept-language", "en-US,en;q=0.9");

  if (callerHeaders) {
    new Headers(callerHeaders).forEach((value, key) => headers.set(key, value));
  }

  return headers;
}

export async function plaudFetch(
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: browserHeaders(init?.headers),
    cache: "no-store"
  });
}
