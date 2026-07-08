(function () {
  const POLL_INTERVAL_MS = 750;
  const POLL_TIMEOUT_MS = 5 * 60_000;
  const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  function unwrapJsonString(raw) {
    const value = String(raw || "").trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "string") return parsed;
      } catch {
        // Treat as a plain string.
      }
    }
    return value;
  }

  function stripBearer(value) {
    return value.trim().replace(/^bearer\s+/i, "");
  }

  function extractJwtCandidate(raw) {
    if (!raw) return null;
    const candidate = stripBearer(unwrapJsonString(raw));
    return JWT_RE.test(candidate) ? candidate : null;
  }

  function readPlaudToken() {
    try {
      const primary = extractJwtCandidate(window.localStorage.getItem("pld_tokenstr"));
      if (primary) return primary;

      let best = null;
      let bestLen = 0;
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key || !key.startsWith("pld_")) continue;
        if (key.endsWith(":workspaceList") || key.endsWith(":frillSsoToken")) continue;
        const candidate = extractJwtCandidate(window.localStorage.getItem(key));
        if (candidate && candidate.length > bestLen) {
          best = candidate;
          bestLen = candidate.length;
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  function decodeJwtRegion(token) {
    try {
      const [, payload] = token.split(".");
      const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const claims = JSON.parse(atob(padded));
      return typeof claims.region === "string" ? claims.region : null;
    } catch {
      return null;
    }
  }

  function apiBaseFromAwsRegion(region) {
    switch (region) {
      case "aws:us-west-2":
        return "https://api.plaud.ai";
      case "aws:eu-central-1":
        return "https://api-euc1.plaud.ai";
      case "aws:ap-southeast-1":
        return "https://api-apse1.plaud.ai";
      case "aws:ap-northeast-1":
        return "https://api-apne1.plaud.ai";
      default:
        return null;
    }
  }

  function hostToRegion(host) {
    if (host === "api.plaud.ai") return "global";
    if (host === "api-euc1.plaud.ai") return "euc1";
    if (host === "api-apse1.plaud.ai") return "apse1";
    if (host === "api-apne1.plaud.ai") return "apne1";
    return "unknown";
  }

  function normalizeApiBase(domain) {
    try {
      const url = new URL(domain);
      if (url.protocol !== "https:") return null;
      if (url.hostname !== "plaud.ai" && !url.hostname.endsWith(".plaud.ai")) return null;
      return `${url.protocol}//${url.hostname}`;
    } catch {
      return null;
    }
  }

  function readApiBaseFromWorkspaceList() {
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key || !key.endsWith(":workspaceList")) continue;
        const raw = window.localStorage.getItem(key);
        if (!raw) continue;
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        const domain = parsed[0]?.domain || parsed[0]?.api_domain;
        if (typeof domain !== "string") continue;
        const normalized = normalizeApiBase(domain);
        if (normalized) return normalized;
      }
    } catch {
      // Ignore localStorage drift.
    }
    return null;
  }

  function resolveApiBase(token) {
    const fromWorkspace = readApiBaseFromWorkspaceList();
    if (fromWorkspace) {
      return {
        apiBase: fromWorkspace,
        region: hostToRegion(new URL(fromWorkspace).hostname)
      };
    }

    const awsRegion = decodeJwtRegion(token);
    const fromJwt = awsRegion ? apiBaseFromAwsRegion(awsRegion) : null;
    if (fromJwt) {
      return {
        apiBase: fromJwt,
        region: hostToRegion(new URL(fromJwt).hostname)
      };
    }

    return { apiBase: "https://api.plaud.ai", region: "global" };
  }

  async function tryForward() {
    const token = readPlaudToken();
    if (!token) return false;
    const { apiBase, region } = resolveApiBase(token);
    try {
      await chrome.runtime.sendMessage({
        type: "plaud:token-captured",
        payload: {
          accessToken: token,
          apiBase,
          region,
          capturedAt: Date.now()
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  async function poll() {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await tryForward()) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    console.debug("[plaude-connector] timed out waiting for Plaud token");
  }

  void poll();
})();
