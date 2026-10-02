// Entry: the popup UI (pairing client).
//
// The person at the client PC types the gateway address and the one-shot
// pairing code the company operator read to them. The popup forwards both to
// the service worker (chrome.runtime.sendMessage); the worker does the
// exchange and stores the bridge token in chrome.storage.local. The token
// never appears in the UI and never passes through the popup's DOM.

const statusElement = document.getElementById("status") as HTMLElement;
const pairingElement = document.getElementById("pairing") as HTMLElement;
const pairedElement = document.getElementById("paired") as HTMLElement;
const originInput = document.getElementById("origin") as HTMLInputElement;
const codeInput = document.getElementById("code") as HTMLInputElement;
const pairButton = document.getElementById("pair") as HTMLButtonElement;
const pairError = document.getElementById("pair-error") as HTMLElement;
const deviceElement = document.getElementById("device") as HTMLElement;
const capabilitiesElement = document.getElementById("capabilities") as HTMLElement;
const allowlistElement = document.getElementById("allowlist") as HTMLElement;
const connectButton = document.getElementById("connect") as HTMLButtonElement;
const disconnectButton = document.getElementById("disconnect") as HTMLButtonElement;
const unpairButton = document.getElementById("unpair") as HTMLButtonElement;

function send(message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      resolve((response ?? {}) as Record<string, unknown>);
    });
  });
}

async function refreshStatus(): Promise<void> {
  const status = await send({ type: "bridge-get-status" });
  const phase = typeof status.phase === "string" ? status.phase : "unknown";
  statusElement.textContent = `status: ${phase}`;
  statusElement.className = phase === "ready" ? "status-ok" : phase === "closed" ? "status-bad" : "muted";
  const paired = status.paired === true;
  pairingElement.hidden = paired;
  pairedElement.hidden = !paired;
  if (!paired) return;
  deviceElement.textContent = `device ${String(status.deviceId ?? "")} · extension ${String(status.extVersion ?? "")}`;
  capabilitiesElement.textContent = Array.isArray(status.capabilities) ? status.capabilities.join(", ") : "";
  if (Array.isArray(status.allowlist)) {
    allowlistElement.replaceChildren(
      ...status.allowlist.map((domain) => {
        const item = document.createElement("li");
        item.textContent = String(domain);
        return item;
      }),
    );
  }
  const failure = typeof status.lastHandshakeFailure === "string" ? status.lastHandshakeFailure : "";
  statusElement.textContent = failure ? `status: ${phase} (${failure})` : `status: ${phase}`;
}

pairButton.addEventListener("click", async () => {
  pairError.textContent = "";
  pairButton.disabled = true;
  try {
    const response = await send({ type: "bridge-pair", code: codeInput.value, origin: originInput.value });
    if (response.ok === true) {
      codeInput.value = "";
    } else {
      pairError.textContent = String(response.error ?? "pairing failed");
    }
  } finally {
    pairButton.disabled = false;
    await refreshStatus();
  }
});

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  try {
    await send({ type: "bridge-connect" });
  } finally {
    connectButton.disabled = false;
    await refreshStatus();
  }
});

disconnectButton.addEventListener("click", async () => {
  await send({ type: "bridge-disconnect" });
  await refreshStatus();
});

unpairButton.addEventListener("click", async () => {
  await send({ type: "bridge-unpair" });
  await refreshStatus();
});

void refreshStatus();

export {};
