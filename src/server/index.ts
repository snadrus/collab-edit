import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { WebSocketServer } from "ws";
import { Hub } from "./hub.ts";
import { Store } from "./store.ts";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUB = path.join(ROOT, "public");
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");

await esbuild.build({
  entryPoints: [path.join(ROOT, "src/client/main.ts")],
  bundle: true,
  format: "iife",
  outfile: path.join(PUB, "app.js"),
  sourcemap: process.env.DEV === "1",
  target: "es2022",
  legalComments: "none",
});

const store = new Store(DATA);
const hub = new Hub(store);

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
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/d/"))) {
      serveFile(res, path.join(PUB, "index.html"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/docs") {
      sendJson(res, 200, store.list());
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

const wss = new WebSocketServer({ server, path: "/ws" });
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
      room = hub.open(docId);
      if (!conn) conn = hub.connect(room, ws, sid, name, since, resume);
      else hub.pushInit(room, conn, since, resume);
      return;
    }
    if (room && conn) hub.handle(room, conn, msg);
  });
  ws.on("close", () => {
    if (room && conn) hub.disconnect(room, conn);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Felarumi listening on http://${HOST}:${PORT}`);
});
