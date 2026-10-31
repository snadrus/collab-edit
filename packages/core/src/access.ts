export type Role = "edit" | "comment" | "view";

export interface ShareTokens {
  edit: string;
  comment: string;
  view: string;
}

export function normalizeRole(value: unknown): Role {
  return value === "comment" || value === "view" ? value : "edit";
}

export function emptyTokens(): ShareTokens {
  return { edit: "", comment: "", view: "" };
}

export function parseTokens(raw: unknown): ShareTokens {
  const src = raw && typeof raw === "object" ? (raw as Partial<ShareTokens>) : {};
  const clean = (value: unknown) => (typeof value === "string" && /^[A-Za-z0-9_-]{6,80}$/.test(value) ? value : "");
  return { edit: clean(src.edit), comment: clean(src.comment), view: clean(src.view) };
}

/** A matching link token wins. Otherwise the document's general access applies. */
export function roleForToken(access: Role, tokens: ShareTokens, token: string): Role {
  if (token && token === tokens.edit) return "edit";
  if (token && token === tokens.comment) return "comment";
  if (token && token === tokens.view) return "view";
  return access;
}
