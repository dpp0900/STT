(function () {
  const PAGE_MARKER = "__plaudeStt";
  const BRIDGE_VERSION = 1;
  let current = null;

  function requestId() {
    return `plaude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function clearCurrent() {
    if (current?.timeout) clearTimeout(current.timeout);
    current = null;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[PAGE_MARKER] !== true) return;
    if (data.kind !== "connect-result") return;
    if (!current) return;
    if (data.requestId !== current.requestId && data.requestId !== "*") return;

    const pending = current;
    clearCurrent();
    if (data.ok) pending.resolve(data.payload);
    else pending.reject(new Error(data.error || "connect failed"));
  });

  const api = {
    version: BRIDGE_VERSION,
    connect() {
      return new Promise((resolve, reject) => {
        if (current) {
          reject(new Error("a connect request is already in flight"));
          return;
        }

        const id = requestId();
        const timeout = setTimeout(() => {
          if (current?.requestId === id) {
            clearCurrent();
            reject(new Error("timed out waiting for Plaud sign-in"));
          }
        }, 5 * 60 * 1000);

        current = { requestId: id, resolve, reject, timeout };
        window.postMessage(
          {
            [PAGE_MARKER]: true,
            kind: "connect",
            requestId: id
          },
          window.location.origin
        );
      });
    }
  };

  try {
    Object.defineProperty(window, "__riffadoConnector", {
      value: api,
      writable: false,
      configurable: true,
      enumerable: false
    });
  } catch {
    window.__riffadoConnector = api;
  }
})();
