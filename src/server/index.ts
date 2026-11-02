import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { WebSocketServer } from "ws";
import { BookHub, BookStore, type BookConn } from "../../apps/felanumio/src/hub.ts";
import { Hub } from "./hub.ts";
import { Store } from "./store.ts";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUB = path.join(ROOT, "public");
const SHEETS = path.join(ROOT, "apps/felanumio/public");
const UI = path.join(ROOT, "packages/ui");
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");

const bundle = {
  bundle: true,
  format: "iife" as const,
  sourcemap: process.env.DEV === "1",
  target: "es2022" as const,
  legalComments: "none" as const,
};
await esbuild.build({
  ...bundle,
  entryPoints: [path.join(ROOT, "src/client/main.ts")],
  outfile: path.join(PUB, "app.js"),
});
await esbuild.build({
  ...bundle,
  entryPoints: [path.join(ROOT, "apps/felanumio/src/client.ts")],
  outfile: path.join(SHEETS, "app.js"),
});

const store = new Store(DATA);
const hub = new Hub(store);
const books = new BookStore(DATA);
const bookHub = new BookHub(books);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
};

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safePublic(urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  if (!rel || rel.includes("\0") || rel.includes("..")) return null;
  const full = path.resolve(PUB, rel);
  if (full !== PUB && !full.startsWith(PUB + path.sep)) return null;
  return full;
}

function serveFile(res: ServerResponse, file: string): void {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "content-type": MIME[ext] || "application/octet-stream",
    "cache-control": ext === ".woff2" ? "public, max-age=86400" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/d/") || /^\/[vce]\/[^/]+\/?$/.test(url.pathname))) {
      serveFile(res, path.join(PUB, "index.html"));
      return;
    }
    if (
      req.method === "GET" &&
      (url.pathname === "/sheets" || url.pathname === "/sheets/" || url.pathname.startsWith("/sheets/b/") || /^\/sheets\/[vce]\/[^/]+\/?$/.test(url.pathname))
    ) {
      serveFile(res, path.join(SHEETS, "index.html"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/sheets/app.js") {
      serveFile(res, path.join(SHEETS, "app.js"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/sheets/app.css") {
      serveFile(res, path.join(SHEETS, "app.css"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/ui/shell.css") {
      serveFile(res, path.join(UI, "shell.css"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/books") {
      sendJson(res, 200, books.list());
      return;
    }
    const bookOpen = url.pathname.match(/^\/api\/books\/open\/([A-Za-z0-9_-]{1,80})$/);
    if (req.method === "GET" && bookOpen) {
      const found = books.idForToken(bookOpen[1]);
      if (!found) {
        sendJson(res, 404, { error: "missing" });
        return;
      }
      sendJson(res, 200, found);
      return;
    }
    const bookApi = url.pathname.match(/^\/api\/books\/([A-Za-z0-9_-]{1,80})\/(share|access)$/);
    if (bookApi) {
      const bookId = bookApi[1];
      const action = bookApi[2];
      if (!books.load(bookId)) {
        sendJson(res, 404, { error: "missing" });
        return;
      }
      if (req.method === "GET" && action === "share") {
        sendJson(res, 200, books.tokensFor(bookId));
        return;
      }
      if (req.method === "POST" && action === "access") {
        const body = JSON.parse((await readBody(req)) || "{}") as { access?: string };
        const access = body.access === "comment" || body.access === "view" ? body.access : "edit";
        books.setAccess(bookId, access);
        sendJson(res, 200, { access });
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/books") {
      const raw = await readBody(req);
      let title = "Untitled spreadsheet";
      if (raw) {
        try {
          const body = JSON.parse(raw) as { title?: string };
          if (body.title && body.title.trim()) title = body.title.trim().slice(0, 200);
        } catch {
          /* ignore */
        }
      }
      const id = randomBytes(9).toString("base64url");
      books.create(id, title);
      sendJson(res, 201, { id, title });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/docs") {
      sendJson(res, 200, url.searchParams.get("trash") === "1" ? store.listTrash() : store.list());
      return;
    }
    const opened = url.pathname.match(/^\/api\/open\/([A-Za-z0-9_-]{1,80})$/);
    if (req.method === "GET" && opened) {
      const found = store.docForToken(opened[1]);
      if (!found) {
        sendJson(res, 404, { error: "missing" });
        return;
      }
      sendJson(res, 200, found);
      return;
    }
    const copy = url.pathname.match(/^\/api\/docs\/([A-Za-z0-9_-]{1,80})\/copy$/);
    if (req.method === "POST" && copy) {
      const room = hub.open(copy[1]);
      const id = randomBytes(9).toString("base64url");
      const title = ("Copy of " + room.title).slice(0, 200);
      store.create(id, title);
      store.replaceSnapshot(id, room.server.doc);
      store.setPage(id, room.page, Date.now());
      for (const thread of room.threads.values()) store.saveThread(id, thread);
      for (const suggestion of room.suggestions.values()) store.saveSuggestion(id, suggestion);
      sendJson(res, 201, { id, title });
      return;
    }
    const docApi = url.pathname.match(/^\/api\/docs\/([A-Za-z0-9_-]{1,80})(?:\/(share|access|trash|restore|tabs|tab))?$/);
    if (docApi && docApi[1] !== "copy") {
      const docId = docApi[1];
      const action = docApi[2] || "";
      if (!store.exists(docId) && action !== "tabs") {
        sendJson(res, 404, { error: "missing" });
        return;
      }
      if (req.method === "GET" && action === "share") {
        const share = store.tokensFor(docId);
        sendJson(res, 200, { access: share.access, tokens: share.tokens, trashed: store.trashedAt(docId) > 0 });
        return;
      }
      if (req.method === "POST" && action === "access") {
        const body = JSON.parse((await readBody(req)) || "{}") as { access?: string };
        const access = body.access === "comment" || body.access === "view" ? body.access : "edit";
        store.setAccess(docId, access);
        sendJson(res, 200, { access });
        return;
      }
      if (req.method === "POST" && action === "trash") {
        store.trash(docId);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && action === "restore") {
        store.restore(docId);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "DELETE" && !action) {
        store.purge(docId);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && action === "tabs") {
        sendJson(res, 200, store.tabs(docId));
        return;
      }
      if (req.method === "POST" && action === "tabs") {
        const body = JSON.parse((await readBody(req)) || "{}") as { title?: string };
        const child = randomBytes(9).toString("base64url");
        store.addTab(docId, child, body.title || "");
        sendJson(res, 201, { id: child });
        return;
      }
      if (req.method === "POST" && action === "tab") {
        const body = JSON.parse((await readBody(req)) || "{}") as { title?: string };
        store.setTabTitle(docId, body.title || "");
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/docs") {
      const raw = await readBody(req);
      let title = "Untitled document";
      if (raw) {
        try {
          const body = JSON.parse(raw) as { title?: string };
          if (body.title && body.title.trim()) title = body.title.trim().slice(0, 200);
        } catch {
          /* ignore */
        }
      }
      const id = randomBytes(9).toString("base64url");
      store.create(id, title);
      sendJson(res, 201, { id, title });
      return;
    }
    if (req.method === "GET") {
      const file = safePublic(url.pathname);
      if (file) {
        serveFile(res, file);
        return;
      }
    }
    res.writeHead(404).end("Not found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end("error");
  }
});

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost");
  const docId = url.searchParams.get("doc") || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(docId)) {
    ws.close(1008, "bad doc");
    return;
  }
  let room: ReturnType<Hub["open"]> | null = null;
  let conn: ReturnType<Hub["connect"]> | null = null;
  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.t === "hello") {
      const sid = typeof msg.sid === "string" && msg.sid.length < 80 ? msg.sid : randomBytes(8).toString("hex");
      const name = typeof msg.name === "string" ? msg.name : "Guest";
      const since = typeof msg.since === "number" && Number.isInteger(msg.since) ? msg.since : null;
      const resume = msg.resume === true && since != null;
      const share = typeof msg.share === "string" ? msg.share : "";
      room = hub.open(docId);
      const role = store.roleFor(docId, share);
      if (!conn) conn = hub.connect(room, ws, sid, name, since, resume, role);
      else hub.pushInit(room, conn, since, resume);
      return;
    }
    if (room && conn) hub.handle(room, conn, msg);
  });
  ws.on("close", () => {
    if (room && conn) hub.disconnect(room, conn);
  });
});

const sheetWss = new WebSocketServer({ noServer: true });
sheetWss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", "http://localhost");
  const bookId = url.searchParams.get("book") || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(bookId)) {
    ws.close(1008, "bad book");
    return;
  }
  let room: NonNullable<ReturnType<BookHub["open"]>> | null = null;
  let conn: BookConn | null = null;
  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.t === "hello") {
      const sid = typeof msg.sid === "string" && msg.sid.length < 80 ? msg.sid : randomBytes(8).toString("hex");
      const name = typeof msg.name === "string" ? msg.name : "Guest";
      const share = typeof msg.share === "string" ? msg.share : "";
      room = bookHub.open(bookId);
      if (!room) {
        ws.close(1008, "missing");
        return;
      }
      const role = books.roleFor(bookId, share);
      if (!conn) conn = bookHub.connect(room, ws, sid, name, role);
      else bookHub.pushInit(room, conn);
      return;
    }
    if (room && conn) bookHub.handle(room, conn, msg);
  });
  ws.on("close", () => {
    if (room && conn) bookHub.disconnect(room, conn);
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  const target = url.pathname === "/ws" ? wss : url.pathname === "/ws/sheets" ? sheetWss : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});

server.listen(PORT, HOST, () => {
  console.log(`FiPen listening on http://${HOST}:${PORT}`);
});
