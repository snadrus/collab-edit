import assert from "node:assert/strict";
import test from "node:test";
import { commandsToDelta, deltaToCommands } from "../src/shared/commands.ts";
import { type Attrs, type Delta, EMBED, compose, isNoop, transform, transformPosition } from "../src/shared/delta.ts";
import {
  type CharStyle,
  type Doc,
  applyDoc,
  docEqual,
  emptyDoc,
  invert,
  markedText,
  plainText,
  voteMap,
} from "../src/shared/doc.ts";
import { ClientSync, ServerDoc } from "../src/shared/engine.ts";
import { assignColor } from "../src/shared/palette.ts";
import { addColumnDelta, addRowDelta, insertTableDelta, removeColumnDelta, removeRowDelta } from "../src/shared/table.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ri(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, xs: T[]): T {
  return xs[Math.floor(rng() * xs.length)];
}

const WORDS = ["alpha", "beta", "gamma", "doc", "x", "qu", "n", "line", "ok", "z"];

function randomDoc(rng: () => number): Doc {
  const paras = ri(rng, 1, 4);
  let text = "";
  const styles: CharStyle[] = [];
  for (let p = 0; p < paras; p++) {
    const len = ri(rng, 0, 12);
    for (let i = 0; i < len; i++) {
      text += pick(rng, ["a", "b", "c", "d", "e", " ", "f", "g"]);
      const st: CharStyle = {};
      if (rng() < 0.2) st.b = true;
      if (rng() < 0.15) st.i = true;
      if (rng() < 0.1) st.color = pick(rng, ["#111111", "#cc0000", "#0055aa"]);
      if (rng() < 0.1) st.size = pick(rng, [11, 14, 18]);
      styles.push(st);
    }
    const br = p === paras - 1 || rng() < 0.85 ? "\n" : "\f";
    text += br;
    const ps: CharStyle = {
      h: pick(rng, ["normal", "h1", "h2", "title"] as const),
      align: pick(rng, ["left", "center", "right"] as const),
    };
    if (rng() < 0.3) ps.list = pick(rng, ["bullet", "numbered"] as const);
    styles.push(ps);
  }
  if (!text.endsWith("\n")) {
    text += "\n";
    styles.push({ h: "normal", align: "left" });
  }
  return { text, styles };
}

function randomPrimitive(doc: Doc, rng: () => number): Delta {
  const len = doc.text.length;
  const max = len - 1;
  const roll = rng();
  if (roll < 0.45 && max >= 0) {
    const at = ri(rng, 0, max);
    const s = pick(rng, WORDS).slice(0, ri(rng, 1, 6));
    const a: Attrs = {};
    if (rng() < 0.4) a.b = true;
    if (rng() < 0.3) a.i = true;
    if (rng() < 0.2) a.font = pick(rng, ["Open Sans", "Lora", "Roboto"]);
    if (rng() < 0.15) a.color = "#202124";
    const withNl = rng() < 0.2 ? s + "\n" : s;
    const attrs: Attrs = { ...a };
    if (withNl.includes("\n") && rng() < 0.5) attrs.h = pick(rng, ["normal", "h1", "h2"]);
    const ops = [];
    if (at > 0) ops.push({ t: "r" as const, n: at });
    ops.push(Object.keys(attrs).length ? { t: "i" as const, s: withNl, a: attrs } : { t: "i" as const, s: withNl });
    return { ops };
  }
  if (roll < 0.75 && max > 0) {
    const a = ri(rng, 0, max - 1);
    const b = ri(rng, a + 1, max);
    const ops = [];
    if (a > 0) ops.push({ t: "r" as const, n: a });
    ops.push({ t: "d" as const, n: b - a });
    return { ops };
  }
  const a = ri(rng, 0, Math.max(0, len - 1));
  const b = ri(rng, a, len - 1);
  if (b === a) return { ops: [] };
  const attrs: Attrs = {};
  const kind = rng();
  if (kind < 0.33) attrs.b = rng() < 0.5 ? true : null;
  else if (kind < 0.5) attrs.i = true;
  else if (kind < 0.65) attrs.u = rng() < 0.5 ? true : null;
  else if (kind < 0.8) attrs.color = rng() < 0.2 ? null : pick(rng, ["#000000", "#1a73e8", "#d93025"]);
  else if (kind < 0.9) attrs.h = pick(rng, ["normal", "title", "h1", "h2", "h3"]);
  else attrs.list = rng() < 0.3 ? null : pick(rng, ["bullet", "numbered"]);
  const ops = [];
  if (a > 0) ops.push({ t: "r" as const, n: a });
  ops.push({ t: "r" as const, n: b - a, a: attrs });
  return { ops };
}

function randomOp(doc: Doc, rng: () => number): Delta {
  let cur = doc;
  let delta = randomPrimitive(cur, rng);
  if (isNoop(delta)) return randomPrimitive(cur, rng);
  if (rng() < 0.35) {
    cur = applyDoc(cur, delta);
    const second = randomPrimitive(cur, rng);
    if (!isNoop(second)) delta = compose(delta, second);
  }
  return delta;
}

test("apply, compose, and invert round-trip", () => {
  const rng = mulberry32(11);
  for (let i = 0; i < 500; i++) {
    const doc = randomDoc(rng);
    const a = randomOp(doc, rng);
    const mid = applyDoc(doc, a);
    const b = randomOp(mid, rng);
    const step = applyDoc(mid, b);
    const together = applyDoc(doc, compose(a, b));
    assert.ok(docEqual(step, together), "compose " + i);
    const back = applyDoc(mid, invert(a, doc));
    assert.ok(docEqual(back, doc), "invert " + i + "\n" + doc.text + "\n" + mid.text + "\n" + back.text);
  }
});

test("command round-trip preserves apply", () => {
  const rng = mulberry32(19);
  for (let i = 0; i < 400; i++) {
    const doc = randomDoc(rng);
    const delta = randomOp(doc, rng);
    const via = commandsToDelta(deltaToCommands(delta));
    const again = commandsToDelta(deltaToCommands(via));
    assert.ok(docEqual(applyDoc(doc, delta), applyDoc(doc, via)), "commands " + i);
    assert.deepEqual(via, again);
  }
});

test("transformPosition", () => {
  const ins: Delta = { ops: [{ t: "i", s: "X" }] };
  assert.equal(transformPosition(ins, 0, true), 1);
  assert.equal(transformPosition(ins, 0, false), 0);
  assert.equal(transformPosition(ins, 2, true), 3);
  const del: Delta = { ops: [{ t: "d", n: 1 }] };
  assert.equal(transformPosition(del, 0, true), 0);
  assert.equal(transformPosition(del, 1, true), 0);
  assert.equal(transformPosition(del, 3, true), 2);
  const mid: Delta = { ops: [{ t: "r", n: 2 }, { t: "i", s: "Y" }] };
  assert.equal(transformPosition(mid, 2, true), 3);
  assert.equal(transformPosition(mid, 2, false), 2);
  assert.equal(transformPosition(mid, 4, false), 5);
});

test("TP1 across thousands of random concurrent pairs", () => {
  const rng = mulberry32(0xc0ffee);
  const trials = 4000;
  for (let i = 0; i < trials; i++) {
    const doc = randomDoc(rng);
    const a = randomOp(doc, rng);
    const b = randomOp(doc, rng);
    for (const aw of [true, false]) {
      let left: Doc;
      let right: Doc;
      try {
        const b2 = transform(b, a, !aw);
        const a2 = transform(a, b, aw);
        left = applyDoc(applyDoc(doc, a), b2);
        right = applyDoc(applyDoc(doc, b), a2);
      } catch (err) {
        throw new Error(`TP1 threw at ${i}: ${(err as Error).message}\nA ${JSON.stringify(a)}\nB ${JSON.stringify(b)}\nDOC ${JSON.stringify(doc.text)}`);
      }
      if (!docEqual(left, right)) {
        throw new Error(
          `TP1 diverged at ${i} win=${aw}\nDOC ${JSON.stringify(doc.text)}\nA ${JSON.stringify(a)}\nB ${JSON.stringify(b)}\nL ${JSON.stringify(left.text)}\nR ${JSON.stringify(right.text)}`,
        );
      }
    }
  }
});

test("sid tie-break is independent of arrival order", () => {
  const doc = emptyDoc();
  const a: Delta = { ops: [{ t: "i", s: "A" }] };
  const b: Delta = { ops: [{ t: "i", s: "B" }] };
  const server = new ServerDoc(doc);
  const first = server.submit("m-high", 1, 0, b);
  const second = server.submit("a-low", 1, 0, a);
  assert.equal(plainText(server.doc), "AB");
  assert.equal(first.assignedRev, 1);
  assert.equal(second.assignedRev, 2);

  const flipped = new ServerDoc(doc);
  flipped.submit("a-low", 1, 0, a);
  flipped.submit("m-high", 1, 0, b);
  assert.equal(plainText(flipped.doc), "AB");
});

test("idempotent reqId does not double-apply", () => {
  const server = new ServerDoc();
  const d: Delta = { ops: [{ t: "i", s: "hi" }] };
  const a = server.submit("s", 1, 0, d);
  const b = server.submit("s", 1, 0, d);
  assert.equal(b.duplicate, true);
  assert.equal(b.assignedRev, a.assignedRev);
  assert.equal(plainText(server.doc), "hi");
});

test("solo undo and redo restore the document", () => {
  const rng = mulberry32(42);
  const server = new ServerDoc();
  const client = new ClientSync("solo", emptyDoc(), 0);
  const deliver = () => {
    const msg = client.takeOutbound();
    if (!msg) return;
    const res = server.submit(client.sid, msg.reqId, msg.baseRev, commandsToDelta(deltaToCommands(msg.delta)));
    assert.equal(res.error, undefined);
    client.ack(msg.reqId, res.assignedRev, res.serverRev);
    const again = client.takeOutbound();
    if (again) {
      const res2 = server.submit(client.sid, again.reqId, again.baseRev, again.delta);
      client.ack(again.reqId, res2.assignedRev, res2.serverRev);
    }
  };
  const checkpoints: Doc[] = [structuredClone(client.doc)];
  let spins = 0;
  while (checkpoints.length < 41 && spins++ < 500) {
    client.local(randomOp(client.doc, rng));
    deliver();
    if (!docEqual(client.doc, checkpoints[checkpoints.length - 1])) checkpoints.push(structuredClone(client.doc));
  }
  assert.equal(checkpoints.length, 41);
  for (let i = 0; i < 40; i++) {
    assert.equal(client.undo(), true, "undo " + i);
    deliver();
    assert.ok(
      docEqual(client.doc, checkpoints[checkpoints.length - 2 - i]),
      "undo " + i + " got " + JSON.stringify(client.doc.text) + " want " + JSON.stringify(checkpoints[checkpoints.length - 2 - i].text),
    );
  }
  assert.ok(docEqual(client.doc, emptyDoc()));
  for (let i = 0; i < 40; i++) {
    assert.equal(client.redo(), true, "redo " + i);
    deliver();
  }
  assert.ok(docEqual(client.doc, checkpoints[checkpoints.length - 1]));
  assert.ok(docEqual(client.doc, server.doc));
});

test("thousands of concurrent ops converge, including undo", () => {
  const seeds = [1, 7, 99, 2026, 8675309];
  let applied = 0;
  for (const seed of seeds) {
    const rng = mulberry32(seed);
    const server = new ServerDoc();
    const sids = ["alpha", "bravo", "charlie", "delta"];
    const clients = sids.map((sid) => new ClientSync(sid, emptyDoc(), 0));
    type SMsg = { from: number; reqId: number; base: number; delta: Delta };
    type CMsg =
      | { kind: "remote"; rev: number; sid: string; reqId: number; delta: Delta }
      | { kind: "ack"; reqId: number; assigned: number | null; server: number };
    const sin: SMsg[] = [];
    const cin: CMsg[][] = sids.map(() => []);

    const serverDocs: Doc[] = [structuredClone(server.doc)];
    const flushSend = (i: number) => {
      const msg = clients[i].takeOutbound();
      if (!msg) return;
      sin.push({ from: i, reqId: msg.reqId, base: msg.baseRev, delta: commandsToDelta(deltaToCommands(msg.delta)) });
    };

    const serverProcess = (m: SMsg) => {
      const res = server.submit(sids[m.from], m.reqId, m.base, m.delta);
      if (res.error) throw new Error(`server ${res.error} seed ${seed} from ${sids[m.from]} base ${m.base}`);
      cin[m.from].push({ kind: "ack", reqId: m.reqId, assigned: res.assignedRev, server: res.serverRev });
      serverDocs[server.rev] = structuredClone(server.doc);
      if (res.delta && res.assignedRev != null) {
        const wire = commandsToDelta(deltaToCommands(res.delta));
        for (let i = 0; i < clients.length; i++) {
          if (i === m.from) continue;
          cin[i].push({ kind: "remote", rev: res.assignedRev, sid: sids[m.from], reqId: m.reqId, delta: wire });
        }
      }
      applied++;
    };

    const clientProcess = (i: number, m: CMsg) => {
      const c = clients[i];
      if (m.kind === "ack") c.ack(m.reqId, m.assigned, m.server);
      else c.ingestRemote(m.delta, m.sid, m.rev, m.reqId);
      flushSend(i);
    };

    const trace: string[] = [];
    const note = (s: string) => {
      trace.push(s);
      if (trace.length > 12) trace.shift();
    };
    const quietCheck = (step: number) => {
      for (let i = 0; i < clients.length; i++) {
        if (cin[i].length || clients[i].inflight || clients[i].pending) continue;
        const expect = serverDocs[clients[i].rev];
        if (expect && !docEqual(clients[i].doc, expect)) {
          const slog = server.log.slice(-8).map((e, k) => `${server.rev - server.log.slice(-8).length + k} ${e.sid} ${JSON.stringify(e.delta)}`).join("\n");
          const cst = clients.map((c, k) => `${sids[k]} rev ${c.rev} inf ${!!c.inflight} pend ${!!c.pending} ${JSON.stringify(c.doc.text)}`).join("\n");
          throw new Error(
            `seed ${seed} step ${step} ${sids[i]} diverged at rev ${clients[i].rev} (server head ${server.rev})\nC ${JSON.stringify(clients[i].doc.text)}\nS ${JSON.stringify(expect.text)}\n` +
              trace.join("\n") + "\n--log--\n" + slog + "\n--clients--\n" + cst,
          );
        }
      }
    };
    for (let step = 0; step < 10000; step++) {
      const roll = rng();
      if (roll < 0.62) {
        const i = Math.floor(rng() * clients.length);
        const c = clients[i];
        const u = rng();
        if (u < 0.1) c.undo();
        else if (u < 0.14) c.redo();
        else c.local(randomOp(c.doc, rng));
        flushSend(i);
        note(`local ${sids[i]} -> ${JSON.stringify(clients[i].doc.text)}`);
      } else if (roll < 0.82 && sin.length) {
        const j = Math.floor(rng() * sin.length);
        const m = sin.splice(j, 1)[0];
        note(`srv ${sids[m.from]} base ${m.base} ${JSON.stringify(m.delta)}`);
        serverProcess(m);
      } else if (cin.some((q) => q.length)) {
        const ready = [];
        for (let i = 0; i < cin.length; i++) if (cin[i].length) ready.push(i);
        const i = ready[Math.floor(rng() * ready.length)];
        const msg = cin[i].shift()!;
        note(`recv ${sids[i]} ${msg.kind} ${msg.kind === "remote" ? msg.rev + " " + msg.sid : "ack " + msg.reqId}`);
        clientProcess(i, msg);
      } else if (sin.length) {
        serverProcess(sin.splice(Math.floor(rng() * sin.length), 1)[0]);
      } else {
        const i = Math.floor(rng() * clients.length);
        clients[i].resend();
        flushSend(i);
      }
      if (step % 25 === 0) quietCheck(step);
    }

    let guard = 0;
    while (guard++ < 100000) {
      let progress = false;
      if (sin.length) {
        serverProcess(sin.shift()!);
        progress = true;
      }
      for (let i = 0; i < cin.length; i++) {
        if (cin[i].length) {
          clientProcess(i, cin[i].shift()!);
          progress = true;
        }
      }
      for (let i = 0; i < clients.length; i++) {
        const before = sin.length;
        flushSend(i);
        if (sin.length !== before) progress = true;
      }
      if (!progress) break;
      quietCheck(10000 + guard);
    }

    for (let i = 0; i < clients.length; i++) {
      if (clients[i].inflight || clients[i].pending) {
        throw new Error(`seed ${seed} client ${sids[i]} still pending inflight=${!!clients[i].inflight} pending=${!!clients[i].pending} rev ${clients[i].rev} server ${server.rev}`);
      }
      if (!docEqual(clients[i].doc, server.doc) || clients[i].rev !== server.rev) {
        throw new Error(
          `seed ${seed} client ${sids[i]} diverged rev ${clients[i].rev}/${server.rev}\nC ${JSON.stringify(clients[i].doc.text)}\nS ${JSON.stringify(server.doc.text)}`,
        );
      }
    }
  }
  assert.ok(applied > 2000, "expected thousands of committed ops, got " + applied);
});

function chipDoc(): Doc {
  const text = EMBED + "hello\n";
  const styles: CharStyle[] = [{ embed: "vote", emoji: "👍" }];
  for (let i = 0; i < 5; i++) styles.push({ cmt: "thread1" });
  styles.push({ h: "normal", align: "left" });
  return { text, styles };
}

test("concurrent votes and comment anchors converge", () => {
  const doc = chipDoc();
  const voteA: Delta = { ops: [{ t: "r", n: 1, a: { "v.avery": "Avery" } }] };
  const voteB: Delta = { ops: [{ t: "r", n: 1, a: { "v.blair": "Blair" } }] };
  const left = applyDoc(applyDoc(doc, voteA), transform(voteB, voteA, false));
  const right = applyDoc(applyDoc(doc, voteB), transform(voteA, voteB, true));
  assert.ok(docEqual(left, right));
  assert.equal(voteMap(left.styles[0]).avery, "Avery");
  assert.equal(voteMap(left.styles[0]).blair, "Blair");
  const via = commandsToDelta(deltaToCommands(compose(voteA, transform(voteB, voteA, false))));
  const canonDoc = applyDoc(doc, via);
  assert.equal(voteMap(canonDoc.styles[0]).avery, "Avery");
  assert.equal(voteMap(canonDoc.styles[0]).blair, "Blair");
  assert.ok(docEqual(applyDoc(canonDoc, invert(via, doc)), doc));

  const server = new ServerDoc(doc);
  const a = server.submit("avery", 1, 0, voteA);
  const b = server.submit("blair", 1, 0, voteB);
  assert.equal(a.error, undefined);
  assert.equal(b.error, undefined);
  assert.equal(voteMap(server.doc.styles[0]).avery, "Avery");
  assert.equal(voteMap(server.doc.styles[0]).blair, "Blair");

  const front: Delta = { ops: [{ t: "i", s: "X" }] };
  const back: Delta = { ops: [{ t: "r", n: 6 }, { t: "i", s: "Y" }] };
  const anchored = applyDoc(applyDoc(doc, front), transform(back, front, false));
  const other = applyDoc(applyDoc(doc, back), transform(front, back, true));
  assert.ok(docEqual(anchored, other));
  assert.equal(markedText(anchored, "thread1"), "hello");

  const rng = mulberry32(2026);
  for (let i = 0; i < 600; i++) {
    const base = i % 5 === 0 ? chipDoc() : randomDoc(rng);
    const rich = (source: Doc): Delta => {
      const roll = rng();
      if (source.text[0] === EMBED && roll < 0.34) {
        const key = rng() < 0.5 ? "v.avery" : "v.blair";
        return { ops: [{ t: "r", n: 1, a: { [key]: rng() < 0.2 ? null : "Ada" } }] };
      }
      if (roll < 0.55) {
        const at = ri(rng, 0, Math.max(0, source.text.length - 1));
        const ops = [];
        if (at > 0) ops.push({ t: "r" as const, n: at });
        const attrs: Attrs = {};
        if (rng() < 0.5) attrs.cmt = rng() < 0.3 ? null : "thread1";
        if (rng() < 0.3) attrs.strike = true;
        ops.push({ t: "i" as const, s: pick(rng, ["x", "yo", EMBED]), a: Object.keys(attrs).length ? attrs : undefined });
        return { ops };
      }
      return randomPrimitive(source, rng);
    };
    const opA = rich(base);
    const opB = rich(base);
    for (const aw of [true, false]) {
      const b2 = transform(opB, opA, !aw);
      const a2 = transform(opA, opB, aw);
      const l = applyDoc(applyDoc(base, opA), b2);
      const r = applyDoc(applyDoc(base, opB), a2);
      assert.ok(docEqual(l, r), "rich TP1 " + i);
      const round = commandsToDelta(deltaToCommands(opA));
      assert.ok(docEqual(applyDoc(base, opA), applyDoc(base, round)), "rich canon " + i);
    }
  }
});

test("table structure edits", () => {
  let doc = applyDoc(emptyDoc(), insertTableDelta(emptyDoc(), 0, 2, 2));
  assert.equal([...doc.text].filter((ch) => ch === "\u001e").length, 2);
  assert.equal(doc.styles[doc.text.indexOf("\u001e")].cols, 2);
  const added = addColumnDelta(doc, 0);
  assert.ok(added);
  doc = applyDoc(doc, added!);
  assert.equal(doc.styles[doc.text.indexOf("\u001e")].cols, 3);
  const row = addRowDelta(doc, 0);
  assert.ok(row);
  doc = applyDoc(doc, row!);
  assert.equal([...doc.text].filter((ch) => ch === "\u001e").length, 3);
  const removed = removeColumnDelta(doc, 0);
  assert.ok(removed);
  doc = applyDoc(doc, removed!);
  assert.equal(doc.styles[doc.text.indexOf("\u001e")].cols, 2);
  const dropped = removeRowDelta(doc, 0);
  assert.ok(dropped);
  doc = applyDoc(doc, dropped!);
  assert.equal([...doc.text].filter((ch) => ch === "\u001e").length, 2);
  assert.ok(doc.text.endsWith("\n"));

  let para = applyDoc(emptyDoc(), { ops: [{ t: "i", s: "Hello" }] });
  para = applyDoc(para, { ops: [{ t: "r", n: 5 }, { t: "r", n: 1, a: { list: "check" } }] });
  const split = applyDoc(para, insertTableDelta(para, para.text.length - 1, 2, 2));
  assert.ok(split.text.startsWith("Hello\n\u001c"), split.text);
  assert.equal(split.text.includes("Hello\u001c"), false);
  assert.equal(split.styles[5].list, "check");
  assert.equal(split.styles[split.text.length - 1].list, undefined);
  const cell = split.text.indexOf("\u001c");
  assert.equal(split.text[cell + 1], "\u001e");
});

test("collaborator colors stay distinct", () => {
  const used: string[] = [];
  for (let i = 0; i < 10; i++) {
    const color = assignColor(used, "s" + i);
    assert.equal(used.includes(color), false);
    used.push(color);
  }
  const extra = assignColor(used, "overflow");
  assert.equal(used.includes(extra), false);
});
