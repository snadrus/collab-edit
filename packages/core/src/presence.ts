import { hexAlpha, LOCAL_CARET, LOCAL_SELECTION } from "./palette.ts";

/** Own cursor is black. Everyone else sees the assigned Material color. */
export function caretColor(own: boolean, assigned: string): string {
  return own ? LOCAL_CARET : assigned;
}

/** Own selection is the Docs blue. Remote selections use the assigned color. */
export function selectionColor(own: boolean, assigned: string): string {
  return own ? LOCAL_SELECTION : hexAlpha(assigned, 0.28);
}
