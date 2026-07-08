(function () {
  const PAGE_MARKER = "__plaudeStt";

  function injectBridge() {
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page-bridge.js");
      script.async = false;
      script.dataset.plaudeSttInjected = "1";
      (document.head || document.documentElement).appendChild(script);
      script.onload = () => script.remove();
    } catch (error) {
      console.error("[plaude-connector] failed to inject bridge:", error);
    }
  }

  injectBridge();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[PAGE_MARKER] !== true || data.kind !== "connect") return;
    if (typeof data.requestId !== "string") return;

    chrome.runtime
      .sendMessage({ type: "bridge:request-connect" })
      .then((response) => {
        if (response?.ok) return;
        window.postMessage(
          {
            [PAGE_MARKER]: true,
            kind: "connect-result",
            requestId: data.requestId,
            ok: false,
            error: response?.error || "background unreachable"
          },
          window.location.origin
        );
      })
      .catch((error) => {
        window.postMessage(
          {
            [PAGE_MARKER]: true,
            kind: "connect-result",
            requestId: data.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          },
          window.location.origin
        );
      });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "plaud:token-captured") return false;
    window.postMessage(
      {
        [PAGE_MARKER]: true,
        kind: "connect-result",
        requestId: "*",
        ok: true,
        payload: message.payload
      },
      window.location.origin
    );
    sendResponse({ ok: true });
    return false;
  });
})();
