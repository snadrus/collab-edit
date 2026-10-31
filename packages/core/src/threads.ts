export interface Reply {
  id: string;
  sid: string;
  name: string;
  text: string;
  ts: number;
}

export interface Thread {
  id: string;
  sid: string;
  name: string;
  color: string;
  text: string;
  ts: number;
  quote: string;
  resolved: boolean;
  replies: Reply[];
}

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}

export function validId(value: unknown): string | null {
  return typeof value === "string" && ID_RE.test(value) ? value : null;
}

export function sanitizeThread(input: unknown): Thread | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = validId(raw.id);
  const sid = clip(raw.sid, 80);
  const text = clip(raw.text, 2000);
  if (!id || !sid || !text) return null;
  const replies: Reply[] = [];
  if (Array.isArray(raw.replies)) {
    for (const item of raw.replies) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const rid = validId(r.id);
      const rsid = clip(r.sid, 80);
      const rtext = clip(r.text, 2000);
      if (!rid || !rsid || !rtext) continue;
      replies.push({
        id: rid,
        sid: rsid,
        name: clip(r.name, 40) || "Guest",
        text: rtext,
        ts: typeof r.ts === "number" ? r.ts : Date.now(),
      });
    }
  }
  return {
    id,
    sid,
    name: clip(raw.name, 40) || "Guest",
    color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color)) ? String(raw.color).toLowerCase() : "#2196f3",
    text,
    ts: typeof raw.ts === "number" ? raw.ts : Date.now(),
    quote: clip(raw.quote, 240),
    resolved: raw.resolved === true,
    replies,
  };
}
