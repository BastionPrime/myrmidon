// Entry: the person-facing side of the confirmation primitive (part D).
//
// The background worker opens this extension page when an action the gateway
// marked `confirmation: "human"` is about to run. The page shows one line (the
// action and its target, both built by the worker, never by the target page)
// and two answers. It is an extension page: it cannot be reached or scripted by
// the site the action runs on.

const params = new URLSearchParams(window.location.search);
const requestId = params.get("requestId") ?? "";
const summary = params.get("summary") ?? "";

function answer(confirmed: boolean): void {
  chrome.runtime.sendMessage({ type: "bridge-confirm-answer", requestId, confirmed });
  window.close();
}

function render(): void {
  const line = document.getElementById("summary");
  if (line) line.textContent = summary;
  const confirm = document.getElementById("confirm");
  const refuse = document.getElementById("refuse");
  confirm?.addEventListener("click", () => answer(true));
  refuse?.addEventListener("click", () => answer(false));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", render);
} else {
  render();
}

export { answer, render };