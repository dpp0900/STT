let pending = null;
const BRIDGE_TTL_MS = 5 * 60 * 1000;

function isStale(state) {
  return Date.now() - state.startedAt > BRIDGE_TTL_MS;
}

async function clearPriorBridge() {
  if (!pending) return;
  try {
    if (pending.plaudTabId !== undefined) {
      await chrome.tabs.remove(pending.plaudTabId);
    }
  } catch {
    // Tab may already be gone.
  }
  pending = null;
}

async function startBridge(bridgeTabId) {
  await clearPriorBridge();
  const tab = await chrome.tabs.create({
    url: "https://web.plaud.ai/",
    active: true
  });
  pending = {
    bridgeTabId,
    plaudTabId: tab.id,
    startedAt: Date.now()
  };
}

async function deliverToken(payload) {
  if (!pending) return;
  if (isStale(pending)) {
    pending = null;
    return;
  }

  const { bridgeTabId, plaudTabId } = pending;
  try {
    await chrome.tabs.sendMessage(bridgeTabId, {
      type: "plaud:token-captured",
      payload
    });
  } catch (error) {
    console.warn("[plaude-connector] bridge tab unreachable:", error);
  }

  if (plaudTabId !== undefined) {
    try {
      await chrome.tabs.remove(plaudTabId);
    } catch {
      // The user may have closed it already.
    }
  }
  pending = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "bridge:request-connect") {
    const tabId = message.bridgeTabId ?? sender.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "could not determine originating tab" });
      return false;
    }
    startBridge(tabId).then(
      () => sendResponse({ ok: true }),
      (error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
    );
    return true;
  }

  if (message?.type === "plaud:token-captured") {
    deliverToken(message.payload).then(
      () => sendResponse({ ok: true }),
      (error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
    );
    return true;
  }

  if (message?.type === "bridge:cancel") {
    clearPriorBridge().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

chrome.runtime.onStartup.addListener(() => {
  if (pending && isStale(pending)) pending = null;
});
