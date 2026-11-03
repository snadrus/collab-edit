/**
 * Guest safety net: when the owner has not been reachable for a while and this guest still has edits the owner never
 * acknowledged, offer (quietly) to save a copy into the guest's own FiFolders drive. The copy records where it came from.
 * When the owner comes back, the copy is also handed to the owner's FiPen/FiGrid, which lists it in their FiFolders
 * ("Participant copies") so they can bring it into their own drive and keep owning the document.
 */

export type CopyKind = "doc" | "book";

export interface CopyOrigin {
  /** Room key of the original document, e.g. "doc:abc123". */
  doc: string;
  /** Owner of the original, as far as this guest knows (display name or wallet; may be empty). */
  owner: string;
  /** Owner's revision this guest's edits were based on. */
  baseRev: number;
  /** Who made the copy. */
  by: string;
  at: number;
}

export interface CopyState {
  raw: string;
  title: string;
  rev: number;
  dirty: boolean;
}

/** A copy handed to the owner, stored on the owner's origin for FiFolders. */
export interface ParticipantCopy {
  id: string;
  kind: CopyKind;
  title: string;
  from: string;
  content: string;
  origin: CopyOrigin;
  /** "version": nothing changed on the owner's side since the guest's base, so it can become the next version. */
  fit: "version" | "diverged";
  /** The owner's FiFolders path for the original, when the owner has it open from FiFolders. */
  path: string;
  received: number;
}

export const COPIES_KEY = "fifolders:copies";
export const COPY_OFFER_MS = 30_000;
const OFFER = "Owner is away. Save a copy to your drive?";

function offerMs(): number {
  const v = (window as unknown as { __p2pCopyOfferMs?: number }).__p2pCopyOfferMs;
  return typeof v === "number" ? v : COPY_OFFER_MS;
}

function copyState(kind: CopyKind): CopyState | null {
  const w = window as unknown as { __editor?: { copyState?: () => CopyState }; __sheet?: { copyState?: () => CopyState } };
  const api = kind === "doc" ? w.__editor : w.__sheet;
  try {
    return api?.copyState?.() ?? null;
  } catch {
    return null;
  }
}

function myName(): string {
  return (document.querySelector("#name-btn") as HTMLElement | null)?.textContent?.trim() || "A participant";
}

function pendingKey(kind: CopyKind, id: string): string {
  return `p2p:guest-copy:${kind}:${id}`;
}

function notifyFiFolders(): void {
  try {
    const channel = new BroadcastChannel("fifolders-ops");
    channel.postMessage({ v: 1 });
    channel.close();
  } catch {
    // The storage write is enough.
  }
}

/** The copy's file: the editor's own export plus a `copyOf` record. */
export function copyFile(state: CopyState, origin: CopyOrigin): string {
  const parsed = JSON.parse(state.raw) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, copyOf: origin });
}

export function copyTitle(title: string): string {
  return `${(title || "Untitled").trim()} (my copy)`;
}

/** Queue the copy into this browser's FiFolders drive (the guest's own wallet commits it). */
export function queueCopy(kind: CopyKind, id: string, content: string, title: string): string {
  const dir = kind === "doc" ? "/FiPen" : "/FiGrid";
  const ext = kind === "doc" ? ".fipen" : ".figrid";
  const name = copyTitle(title).replace(/[\\/:*?"<>|]+/g, " ").trim() + ext;
  const path = `${dir}/${name}`;
  let ops: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem("fifolders:ops") || "{}") as { ops?: unknown };
    if (Array.isArray(parsed.ops)) ops = parsed.ops as Record<string, unknown>[];
  } catch {
    ops = [];
  }
  const opId = `copy:${kind}:${id}`;
  const now = Date.now();
  ops = ops.filter((op) => op.id !== opId);
  ops.push({ id: opId, v: 1, kind: "fel-save", label: copyTitle(title), status: "pending", stage: "saving", path, name, title: copyTitle(title), content, created: now, updated: now });
  localStorage.setItem("fifolders:ops", JSON.stringify({ v: 1, ops }));
  notifyFiFolders();
  return path;
}

export interface GuestCopyHooks {
  kind: CopyKind;
  id: string;
  ownerOnline: () => boolean;
  ownerName: () => string;
  sendToOwner: (body: unknown) => void;
}

/** Guest side: the timed offer, the save, and the hand-off once the owner is back. */
export function installGuestCopy(h: GuestCopyHooks): { ownerBack: () => void; acked: () => void } {
  let since = 0;
  let dismissedAt = 0;
  let bar: HTMLElement | null = null;
  const close = () => {
    bar?.remove();
    bar = null;
  };
  const show = () => {
    if (bar) return;
    bar = document.createElement("div");
    bar.id = "p2p-copy";
    bar.setAttribute("role", "status");
    bar.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:50;max-width:340px;background:#fff;color:#202124;border:1px solid #dadce0;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15);padding:12px 14px;font:14px/1.4 system-ui,sans-serif;display:flex;flex-wrap:wrap;gap:8px;align-items:center";
    const text = document.createElement("span");
    text.id = "p2p-copy-text";
    text.textContent = OFFER;
    text.style.flex = "1 1 100%";
    const save = document.createElement("button");
    save.type = "button";
    save.id = "p2p-copy-save";
    save.textContent = "Save a copy";
    const later = document.createElement("button");
    later.type = "button";
    later.id = "p2p-copy-later";
    later.textContent = "Not now";
    save.addEventListener("click", () => saveCopy());
    later.addEventListener("click", () => {
      dismissedAt = Date.now();
      close();
    });
    bar.append(text, save, later);
    document.body.append(bar);
  };
  const saveCopy = () => {
    const state = copyState(h.kind);
    if (!state) return;
    const origin: CopyOrigin = { doc: `${h.kind}:${h.id}`, owner: h.ownerName(), baseRev: state.rev, by: myName(), at: Date.now() };
    const content = copyFile(state, origin);
    const path = queueCopy(h.kind, h.id, content, state.title);
    localStorage.setItem(pendingKey(h.kind, h.id), JSON.stringify({ content, title: state.title, origin }));
    if (!bar) show();
    const text = bar!.querySelector("#p2p-copy-text") as HTMLElement;
    text.textContent = `Copy queued for your drive (${path}). `;
    const link = document.createElement("a");
    link.id = "p2p-copy-open";
    link.href = new URL("/", location.href).href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open FiFolders to finish saving";
    text.append(link);
    for (const b of bar!.querySelectorAll("button")) b.remove();
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = "OK";
    ok.addEventListener("click", () => {
      dismissedAt = Number.MAX_SAFE_INTEGER;
      close();
    });
    bar!.append(ok);
    dismissedAt = Number.MAX_SAFE_INTEGER;
  };
  window.setInterval(() => {
    const state = copyState(h.kind);
    // Edits the owner has not acknowledged. A present owner acks within moments, so unsaved edits that stay
    // unacknowledged (owner gone, asleep, or offline) for the offer delay mean the owner is away.
    const waiting = !!state?.dirty;
    if (!waiting) {
      since = 0;
      if (bar && !bar.querySelector("#p2p-copy-open")) close();
      return;
    }
    if (!since) since = Date.now();
    if (Date.now() - since >= offerMs() && dismissedAt < since) show();
  }, 500);
  return {
    ownerBack: () => {
      const raw = localStorage.getItem(pendingKey(h.kind, h.id));
      if (!raw) return;
      try {
        const pending = JSON.parse(raw) as { content: string; title: string; origin: CopyOrigin };
        h.sendToOwner({ k: "copy", kind: h.kind, title: pending.title, from: pending.origin.by, content: pending.content, origin: pending.origin });
      } catch {
        localStorage.removeItem(pendingKey(h.kind, h.id));
      }
    },
    acked: () => localStorage.removeItem(pendingKey(h.kind, h.id)),
  };
}

/** Owner side: keep a participant's copy for FiFolders' "Participant copies". */
export function receiveCopy(kind: CopyKind, id: string, body: Record<string, unknown>, currentRev: number): ParticipantCopy | null {
  const origin = body.origin as CopyOrigin | undefined;
  if (typeof body.content !== "string" || !origin || origin.doc !== `${kind}:${id}`) return null;
  const copy: ParticipantCopy = {
    id: `${kind}:${id}:${origin.by}:${origin.at}`,
    kind,
    title: String(body.title || "Untitled"),
    from: String(body.from || origin.by || "A participant"),
    content: body.content,
    origin,
    fit: Number(origin.baseRev) === currentRev ? "version" : "diverged",
    path: new URLSearchParams(location.search).get("path") || "",
    received: Date.now(),
  };
  let list: ParticipantCopy[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(COPIES_KEY) || "[]") as unknown;
    if (Array.isArray(parsed)) list = parsed as ParticipantCopy[];
  } catch {
    list = [];
  }
  list = list.filter((item) => item.id !== copy.id);
  list.push(copy);
  localStorage.setItem(COPIES_KEY, JSON.stringify(list));
  notifyFiFolders();
  return copy;
}
