import { canon } from "./commands.ts";
import { type Delta, compose, isNoop, transform } from "./delta.ts";
import { type Doc, type Snapshot, applyDoc, docEqual, emptyDoc, invert, snapshotDoc } from "./doc.ts";

export interface SubmitResult {
  duplicate: boolean;
  assignedRev: number | null;
  serverRev: number;
  delta: Delta | null;
  error?: string;
}

interface LogEntry {
  delta: Delta;
  sid: string;
  reqId: number;
}

/**
 * Server-authoritative OT log. Incoming batches are transformed against every
 * committed op after the client's base revision, then stored as the next revision.
 * (sid, reqId) acks are idempotent.
 */
export class ServerDoc {
  rev = 0;
  doc: Doc;
  log: LogEntry[] = [];
  acks = new Map<string, number | null>();
  /** Return an error to refuse the canonical delta. Runs before it is stored. */
  gate: ((doc: Doc, delta: Delta) => string | null) | null = null;

  constructor(doc?: Doc) {
    this.doc = doc ?? emptyDoc();
  }

  submit(sid: string, reqId: number, baseRev: number, delta: Delta): SubmitResult {
    const key = sid + ":" + reqId;
    if (this.acks.has(key)) {
      return {
        duplicate: true,
        assignedRev: this.acks.get(key) ?? null,
        serverRev: this.rev,
        delta: null,
      };
    }
    if (!Number.isInteger(baseRev) || baseRev < 0 || baseRev > this.rev) {
      return { duplicate: false, assignedRev: null, serverRev: this.rev, delta: null, error: "bad revision" };
    }
    let d = delta;
    for (let i = baseRev; i < this.rev; i++) {
      const hist = this.log[i];
      d = transform(d, hist.delta, sid < hist.sid);
    }
    d = canon(d);
    if (isNoop(d)) {
      this.acks.set(key, null);
      return { duplicate: false, assignedRev: null, serverRev: this.rev, delta: null };
    }
    if (this.gate) {
      let gateError: string | null = null;
      try {
        gateError = this.gate(this.doc, d);
      } catch (err) {
        gateError = err instanceof Error ? err.message : "rejected";
      }
      if (gateError) {
        return { duplicate: false, assignedRev: null, serverRev: this.rev, delta: null, error: gateError };
      }
    }
    let next: Doc;
    try {
      next = applyDoc(this.doc, d);
    } catch (err) {
      return {
        duplicate: false,
        assignedRev: null,
        serverRev: this.rev,
        delta: null,
        error: err instanceof Error ? err.message : "apply failed",
      };
    }
    if (!next.text.endsWith("\n") || next.styles.length !== next.text.length) {
      return { duplicate: false, assignedRev: null, serverRev: this.rev, delta: null, error: "invariant" };
    }
    this.doc = next;
    this.rev++;
    this.log.push({ delta: d, sid, reqId });
    this.acks.set(key, this.rev);
    return { duplicate: false, assignedRev: this.rev, serverRev: this.rev, delta: d };
  }
}

export interface WireOp {
  reqId: number;
  baseRev: number;
  delta: Delta;
}

interface HistEntry {
  delta: Delta;
  local: boolean;
  /** Undo inverses valid on `before`, not including this entry. */
  prior: Delta[] | null;
  before: Doc | null;
}

/**
 * Move `inv`, which undoes `done`, through later deltas so it applies to the
 * current document. Older inverses in `prior` are carried along in the
 * "done was never applied" coordinate space. Tie-breaks are opposite so the
 * pair stays consistent.
 */
function excludeUndo(
  before: Doc,
  done: Delta,
  subsequent: Delta[],
  prior: Delta[],
): { stack: Delta[]; invCursor: Delta } {
  let stack = structuredClone(prior);
  let invCursor = invert(done, before);
  for (const later of subsequent) {
    const laterOnShadow = transform(later, invCursor, true);
    stack = stack.map((u) => transform(u, laterOnShadow, false));
    invCursor = transform(invCursor, later, false);
  }
  return { stack, invCursor };
}

/**
 * Client OT state. One in-flight batch and one composed pending batch.
 * Remote ops rebase both, and undo/redo are inverse deltas kept current
 * by transforming them against every delta actually applied to the local doc.
 */
export class ClientSync {
  rev = 0;
  doc: Doc;
  inflight: { reqId: number; delta: Delta; wire: WireOp } | null = null;
  pending: Delta | null = null;
  undoStack: Delta[] = [];
  redoStack: Delta[] = [];
  hist: HistEntry[] = [];
  nextReq = 1;
  outbound: WireOp | null = null;
  sid: string;
  /** Delta most recently applied by a local edit, undo, or redo. */
  lastDelta: Delta | null = null;
  /** Server document at the base revision of the unacked queue. */
  baseSnap: Snapshot | null = null;
  /** Local document after the in-flight op and remote catch-up, before pending. */
  pendingBase: Doc | null = null;
  /** A remote op arrived while this client still had unacked edits. */
  transformed = false;

  constructor(
    sid: string,
    doc?: Doc,
    rev = 0,
  ) {
    this.sid = sid;
    this.doc = doc ?? emptyDoc();
    this.rev = rev;
  }

  local(delta: Delta): void {
    this.lastDelta = null;
    const applied = canon(delta);
    if (isNoop(applied)) return;
    const before = structuredClone(this.doc);
    if (docEqual(applyDoc(before, applied), before)) return;
    const prior = structuredClone(this.undoStack);
    const inv = invert(applied, before);
    this.undoStack = this.undoStack.map((u) => transform(u, applied, false));
    this.undoStack.push(inv);
    this.redoStack = [];
    this.hist.push({ delta: applied, local: true, prior, before });
    this.applyLocal(applied);
  }

  undo(): boolean {
    let i = this.hist.length - 1;
    while (i >= 0 && !this.hist[i].local) i--;
    if (i < 0) return false;
    const entry = this.hist[i];
    const subsequent = this.hist.slice(i + 1).map((h) => h.delta);
    const { stack, invCursor } = excludeUndo(entry.before!, entry.delta, subsequent, entry.prior!);
    const beforeUndo = this.doc;
    this.lastDelta = null;
    let applied = canon(invCursor);
    if (isNoop(applied)) applied = invCursor;
    const newTail: HistEntry[] = [];
    let invC = invert(entry.delta, entry.before!);
    for (const later of subsequent) {
      const laterOnShadow = transform(later, invC, true);
      if (!isNoop(laterOnShadow)) newTail.push({ delta: laterOnShadow, local: false, prior: null, before: null });
      invC = transform(invC, later, false);
    }
    this.hist = this.hist.slice(0, i).concat(newTail);
    this.undoStack = stack;
    if (!isNoop(applied)) {
      this.redoStack.push(invert(applied, beforeUndo));
      this.applyLocal(applied);
    }
    return true;
  }

  redo(): boolean {
    const delta = this.redoStack.pop();
    if (!delta || isNoop(delta)) return false;
    const rest = this.redoStack;
    this.redoStack = [];
    this.local(delta);
    this.redoStack = rest;
    return true;
  }

  applyLocal(delta: Delta): void {
    if (!this.inflight) this.baseSnap = snapshotDoc(this.doc);
    else if (!this.pending) this.pendingBase = structuredClone(this.doc);
    this.lastDelta = delta;
    this.doc = applyDoc(this.doc, delta);
    if (this.inflight) this.pending = this.pending ? compose(this.pending, delta) : delta;
    else this.submit(delta);
  }

  submit(delta: Delta): void {
    const canonical = canon(delta);
    if (isNoop(canonical)) return;
    const wire: WireOp = { reqId: this.nextReq++, baseRev: this.rev, delta: canonical };
    this.inflight = { reqId: wire.reqId, delta: canonical, wire };
    this.outbound = wire;
  }

  takeOutbound(): WireOp | null {
    const msg = this.outbound;
    this.outbound = null;
    return msg;
  }

  /** Retransmit the original batch. The server treats a repeated reqId as a no-op ack. */
  resend(): void {
    if (this.inflight && !this.outbound) this.outbound = this.inflight.wire;
  }

  /**
   * Fold a committed remote op into local state.
   * Returns the delta that was applied to the local document, or null if ignored.
   */
  ingestRemote(delta: Delta, sid: string, rev: number, reqId?: number): Delta | null {
    if (rev <= this.rev) return null;
    if (rev !== this.rev + 1) throw new Error(`revision gap: have ${this.rev}, got ${rev}`);
    if (sid === this.sid && this.inflight && reqId === this.inflight.reqId) {
      this.ack(reqId, rev, rev);
      return null;
    }
    let d = delta;
    const win = this.sid < sid;
    if (this.inflight || this.pending) this.transformed = true;
    if (this.inflight) {
      const inf = this.inflight.delta;
      this.inflight = { ...this.inflight, delta: transform(inf, d, win) };
      d = transform(d, inf, !win);
    }
    if (this.pendingBase) this.pendingBase = applyDoc(this.pendingBase, d);
    if (this.pending) {
      const p = this.pending;
      this.pending = transform(p, d, win);
      d = transform(d, p, !win);
    }
    this.shiftHistory(d);
    if (!isNoop(d)) this.hist.push({ delta: d, local: false, prior: null, before: null });
    this.doc = applyDoc(this.doc, d);
    this.rev = rev;
    return d;
  }

  ack(reqId: number, assignedRev: number | null, serverRev: number): void {
    if (!this.inflight || this.inflight.reqId !== reqId) return;
    if (assignedRev != null && assignedRev > this.rev + 1) {
      throw new Error(`ack gap: have ${this.rev}, assigned ${assignedRev}`);
    }
    const pending = this.pending;
    const pendingBase = this.pendingBase;
    this.inflight = null;
    this.pending = null;
    this.pendingBase = null;
    if (assignedRev != null) this.rev = assignedRev;
    if (serverRev < this.rev) throw new Error("server rev behind client");
    if (pending) {
      this.baseSnap = snapshotDoc(pendingBase ?? this.doc);
      this.submit(pending);
    } else {
      this.baseSnap = snapshotDoc(this.doc);
      this.transformed = false;
    }
  }

  shiftHistory(delta: Delta): void {
    if (isNoop(delta)) return;
    this.undoStack = this.undoStack.map((u) => transform(u, delta, false));
    this.redoStack = this.redoStack.map((r) => transform(r, delta, false));
  }

  reset(doc: Doc, rev: number): void {
    this.doc = doc;
    this.rev = rev;
    this.inflight = null;
    this.pending = null;
    this.outbound = null;
    this.undoStack = [];
    this.redoStack = [];
    this.hist = [];
    this.baseSnap = snapshotDoc(doc);
    this.pendingBase = null;
    this.transformed = false;
  }

  /** Unacked local work, based on `baseRev`, or null when everything is saved. */
  exportQueue(): {
    baseRev: number;
    baseSnap: Snapshot;
    inflight: { reqId: number; delta: Delta } | null;
    pending: Delta | null;
    transformed: boolean;
  } | null {
    if (!this.inflight && !this.pending) return null;
    if (!this.baseSnap) return null;
    return {
      baseRev: this.inflight ? this.inflight.wire.baseRev : this.rev,
      baseSnap: this.baseSnap,
      inflight: this.inflight ? { reqId: this.inflight.reqId, delta: structuredClone(this.inflight.wire.delta) } : null,
      pending: this.pending ? structuredClone(this.pending) : null,
      transformed: this.transformed,
    };
  }

  /** Rebuild unacked work after a reload. Catch-up ops rebase it before it is resent. */
  restoreUnacked(base: Doc, baseRev: number, inflight: { reqId: number; delta: Delta } | null, pending: Delta | null): void {
    this.reset(base, baseRev);
    if (!inflight) return;
    const delta = canon(inflight.delta);
    this.doc = applyDoc(this.doc, delta);
    this.inflight = { reqId: inflight.reqId, delta, wire: { reqId: inflight.reqId, baseRev, delta } };
    this.nextReq = Math.max(this.nextReq, inflight.reqId + 1);
    if (pending && !isNoop(canon(pending))) {
      const queued = canon(pending);
      this.pendingBase = structuredClone(this.doc);
      this.doc = applyDoc(this.doc, queued);
      this.pending = queued;
    }
  }
}
