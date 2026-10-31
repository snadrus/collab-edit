import { type Book, type GridDelta, ServerBook, applyBook, emptyBook, transformGrid } from "./ot.ts";

export class GridClient {
  rev = 0;
  book: Book = emptyBook();
  inflight: { reqId: number; delta: GridDelta } | null = null;
  pending: GridDelta | null = null;
  sid: string;
  private req = 1;

  constructor(sid: string) {
    this.sid = sid;
  }

  load(book: Book, rev: number): void {
    this.book = book;
    this.rev = rev;
    this.inflight = null;
    this.pending = null;
  }

  view(): Book {
    let book = this.book;
    if (this.inflight) book = applyBook(book, this.inflight.delta);
    if (this.pending) book = applyBook(book, this.pending);
    return book;
  }

  /** Queue a local delta. Returns a message when it should be sent now. */
  push(delta: GridDelta): { reqId: number; baseRev: number; delta: GridDelta } | null {
    if (!delta.ops.length) return null;
    if (this.inflight) {
      this.pending = this.pending ? { ops: [...this.pending.ops, ...delta.ops] } : { ops: [...delta.ops] };
      return null;
    }
    const reqId = this.req++;
    this.inflight = { reqId, delta };
    return { reqId, baseRev: this.rev, delta };
  }

  ack(reqId: number, assigned: number | null, serverRev: number, delta: GridDelta | null): { reqId: number; baseRev: number; delta: GridDelta } | null {
    if (!this.inflight || this.inflight.reqId !== reqId) return null;
    if (delta && assigned != null) this.book = applyBook(this.book, delta);
    this.rev = serverRev;
    this.inflight = null;
    const next = this.pending;
    this.pending = null;
    return next ? this.push(next) : null;
  }

  remote(sid: string, delta: GridDelta, rev: number): void {
    if (sid === this.sid) return;
    this.book = applyBook(this.book, delta);
    this.rev = rev;
    if (this.inflight) this.inflight = { reqId: this.inflight.reqId, delta: transformGrid(this.inflight.delta, delta, this.sid < sid) };
    if (this.pending) this.pending = transformGrid(this.pending, delta, this.sid < sid);
  }
}

export { ServerBook };
