/**
 * FiPen @-mentions UI: the "Notify <name>?" sidebar and the person card. All data and sending come from
 * FiPerson (`fiperson/people` details, `fiperson/notify` notify); nothing is sent without the user's click.
 */
import { details, personUrl } from "fiperson/people";
import { notify, notifyChannelLabel } from "fiperson/notify";
import { cachedIdentity } from "fiperson/view";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}
function avatar(cls: string, url: string): HTMLElement {
  const box = el("span", cls);
  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  box.append(img);
  return box;
}

/** Sidebar offering to notify a just-mentioned person. Returns the panel. */
export function openNotifyPanel(address: string, opts: { docTitle: () => string; docUrl: () => string; toast: (s: string) => void }): HTMLElement | null {
  const d = details(address);
  if (!d) return null;
  document.querySelector("#notify-panel")?.remove();
  const panel = el("aside");
  panel.id = "notify-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", `Notify ${d.name}`);
  const title = el("h3");
  title.append(avatar("np-av", d.iconUrl), el("span", "", `Notify ${d.name}?`));
  const via = el("p", "np-via", d.contact ? `Sends a ${notifyChannelLabel(cachedIdentity(d.address)) ?? d.contactLabel} message from you, with a link to this document.` : `${d.name} has no notification contact yet. You can copy the link and send it yourself.`);
  const msg = el("textarea") as HTMLTextAreaElement;
  msg.dataset.testid = "notify-message";
  msg.value = `I mentioned you in “${opts.docTitle() || "a document"}”`;
  const status = el("p", "np-status");
  status.setAttribute("role", "status");
  const actions = el("div", "np-actions");
  const later = el("button", "", "Not now");
  later.type = "button";
  later.dataset.testid = "notify-dismiss";
  const copy = el("button", "", "Copy link");
  copy.type = "button";
  copy.dataset.testid = "notify-copy";
  const send = el("button", "np-send", "Notify");
  send.type = "button";
  send.dataset.testid = "notify-send";
  send.hidden = !d.contact;
  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => opts.toast("Link copied"),
      () => opts.toast("Copy failed"),
    );
  };
  later.addEventListener("click", () => panel.remove());
  copy.addEventListener("click", () => copyText(`${msg.value.trim()}\n${opts.docUrl()}`));
  send.addEventListener("click", () => {
    send.disabled = true;
    status.removeAttribute("data-ok");
    status.textContent = "Sending…";
    // notify() opens Connect Slack synchronously when needed (we are inside the click).
    void notify(cachedIdentity(d.address), msg.value, opts.docUrl()).then((r) => {
      send.disabled = false;
      if (r.ok) {
        status.dataset.ok = "1";
        status.textContent = `Sent to ${d.name} on Slack.`;
        send.hidden = true;
        later.textContent = "Close";
        setTimeout(() => panel.isConnected && panel.remove(), 4000);
      } else {
        status.dataset.ok = "0";
        status.textContent = r.message;
      }
    });
  });
  actions.append(later, copy, send);
  panel.append(title, via, msg, status, actions);
  // Keep focus in the document so typing continues after the chip (Google Docs); the user clicks in to edit.
  document.body.append(panel);
  return panel;
}

/** Card for a mention chip. Name/avatar open the /person/ page. */
export function openPersonCardAt(x: number, y: number, address: string | undefined, label: string, onNotify: (address: string) => void): HTMLElement {
  document.querySelector("#person-card")?.remove();
  const card = el("div");
  card.id = "person-card";
  card.setAttribute("role", "dialog");
  const d = address ? details(address) : null;
  const head = el("div", "pc-head");
  if (d) {
    const link = el("a", "pc-name", d.name) as HTMLAnchorElement;
    link.href = personUrl(d.address);
    link.target = "_blank";
    link.dataset.testid = "person-card-name";
    const av = el("a") as HTMLAnchorElement;
    av.href = link.href;
    av.target = "_blank";
    av.append(avatar("pc-av", d.iconUrl));
    const text = el("div");
    text.append(link, el("small", "", d.shortAddress));
    if (d.sharedClubs.length) text.append(el("small", "", d.sharedClubs.join(" · ")));
    if (d.contactLabel) text.append(el("small", "", d.contactLabel));
    head.append(av, text);
    card.append(head);
    if (d.bio) card.append(el("div", "", d.bio));
    const actions = el("div", "pc-actions");
    const view = el("a", "", "View profile") as HTMLAnchorElement;
    view.href = personUrl(d.address);
    view.target = "_blank";
    view.dataset.testid = "person-card-view";
    const ping = el("button", "", "Notify");
    ping.type = "button";
    ping.dataset.testid = "person-card-notify";
    ping.addEventListener("click", () => (card.remove(), onNotify(d.address)));
    actions.append(view, ping);
    card.append(actions);
  } else {
    head.append(el("strong", "", label), el("small", "", "No wallet linked to this mention."));
    card.append(head);
  }
  card.dataset.testid = "person-card";
  document.body.append(card);
  card.style.left = `${Math.max(8, Math.min(window.innerWidth - 296, x - 20))}px`;
  card.style.top = `${Math.min(y + 14, window.innerHeight - card.offsetHeight - 8)}px`;
  const close = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key === "Escape" : !card.contains(e.target as Node)) {
      card.remove();
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("keydown", close);
    }
  };
  setTimeout(() => {
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", close);
  });
  return card;
}
