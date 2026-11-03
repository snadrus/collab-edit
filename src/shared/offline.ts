/**
 * "You're offline" chip like Docs/Sheets: shows while the browser is offline, hides on reconnect.
 * Edits stay in this tab meanwhile; peers and saving catch up once the connection is back.
 */
export function mountOfflineChip(doc: Document = document): HTMLElement {
  const existing = doc.getElementById("offline-chip");
  if (existing) return existing;
  const chip = doc.createElement("div");
  chip.id = "offline-chip";
  chip.setAttribute("role", "status");
  chip.setAttribute("aria-live", "polite");
  chip.dataset.testid = "offline-chip";
  chip.textContent = "You're offline. Edits stay in this tab; they sync and can be saved when you reconnect.";
  chip.style.cssText =
    "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:80;max-width:calc(100% - 32px);" +
    "background:#323232;color:#fff;border-radius:8px;padding:10px 16px;font:14px/1.4 Roboto,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)";
  const sync = () => {
    chip.hidden = doc.defaultView?.navigator.onLine !== false;
  };
  doc.defaultView?.addEventListener("online", sync);
  doc.defaultView?.addEventListener("offline", sync);
  sync();
  doc.body.append(chip);
  return chip;
}
