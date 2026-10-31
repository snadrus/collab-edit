import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { WebSocketServer } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "p2p/dist");
const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "127.0.0.1";

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

function copyFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function inject(html: string, script: string): string {
  return html
    .replace("<head>", "<head>\n  <script>window.__FELARUMI_P2P__=true</script>")
    .replace(script, `<script type="module" src="/p2p.js"></script>\n  ${script.replace("<script ", '<script type="module" ')}`);
}

export async function buildStatic(): Promise<void> {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  await esbuild.build({
    entryPoints: {
      p2p: path.join(ROOT, "p2p/src/boot.ts"),
      app: path.join(ROOT, "src/client/main.ts"),
      "sheets/app": path.join(ROOT, "apps/felanumio/src/client.ts"),
    },
    bundle: true,
    format: "esm",
    splitting: true,
    outdir: DIST,
    target: "es2022",
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const pub = path.join(ROOT, "public");
  for (const name of fs.readdirSync(pub)) {
    if (name === "app.js" || name === "app.js.map" || name === "index.html") continue;
    const from = path.join(pub, name);
    const to = path.join(DIST, name);
    fs.cpSync(from, to, { recursive: true });
  }
  fs.writeFileSync(path.join(DIST, "index.html"), inject(fs.readFileSync(path.join(pub, "index.html"), "utf8"), '<script src="/app.js"></script>'));
  const sheets = path.join(ROOT, "apps/felanumio/public");
  fs.mkdirSync(path.join(DIST, "sheets"), { recursive: true });
  fs.copyFileSync(path.join(sheets, "app.css"), path.join(DIST, "sheets/app.css"));
  fs.writeFileSync(
    path.join(DIST, "sheets/index.html"),
    inject(fs.readFileSync(path.join(sheets, "index.html"), "utf8"), '<script src="/sheets/app.js"></script>'),
  );
  fs.mkdirSync(path.join(DIST, "ui"), { recursive: true });
  copyFile(path.join(ROOT, "packages/ui/shell.css"), path.join(DIST, "ui/shell.css"));
}

function safeFile(urlPath: string): string | null {
  const rel = decodeURIComponent(urlPath.split("?")[0]).replace(/^\/+/, "");
  if (!rel || rel.includes("\0") || rel.includes("..")) return null;
  const full = path.resolve(DIST, rel);
  if (full !== DIST && !full.startsWith(DIST + path.sep)) return null;
  return full;
}

function sendFile(res: import("node:http").ServerResponse, file: string): void {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

if (process.env.SKIP_BUILD === "1" && fs.existsSync(path.join(DIST, "index.html"))) {
  console.log("Using the existing static build");
} else {
  await buildStatic();
}

const rooms = new Map<string, Map<string, import("ws").WebSocket>>();
const wss = new WebSocketServer({ noServer: true });
const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  if (pathname === "/" || pathname.startsWith("/d/") || /^\/[vce]\/[^/]+\/?$/.test(pathname)) {
    sendFile(res, path.join(DIST, "index.html"));
    return;
  }
  if (pathname === "/sheets" || pathname === "/sheets/" || pathname.startsWith("/sheets/b/") || /^\/sheets\/[vce]\/[^/]+\/?$/.test(pathname)) {
    sendFile(res, path.join(DIST, "sheets/index.html"));
    return;
  }
  const file = safeFile(pathname);
  if (file) {
    sendFile(res, file);
    return;
  }
  res.writeHead(404).end("Not found");
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname !== "/relay") {
    socket.destroy();
    return;
  }
  const roomId = url.searchParams.get("room") || "";
  const peer = url.searchParams.get("peer") || "";
  wss.handleUpgrade(req, socket, head, (ws) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = new Map();
      rooms.set(roomId, room);
    }
    const others = [...room.keys()];
    room.set(peer, ws);
    ws.send(JSON.stringify({ t: "peers", peers: others }));
    for (const [id, other] of room) {
        if (id !== peer && other.readyState === 1) other.send(JSON.stringify({ t: "join", peer }));
    }
    ws.on("message", (data) => {
      let msg: { t?: string; to?: string; body?: unknown };
      try {
        msg = JSON.parse(data.toString()) as { t?: string; to?: string; body?: unknown };
      } catch {
        return;
      }
      if (msg.t !== "msg" || !room) return;
      const packet = JSON.stringify({ t: "msg", from: peer, body: msg.body });
      for (const [id, other] of room) {
        if (id === peer || other.readyState !== 1) continue;
        if (msg.to === "*" || msg.to === id) other.send(packet);
      }
    });
    ws.on("close", () => {
      room?.delete(peer);
      if (room) {
        for (const other of room.values()) {
          if (other.readyState === 1) other.send(JSON.stringify({ t: "leave", peer }));
        }
        if (room.size === 0) rooms.delete(roomId);
      }
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Felarumi static host on http://${HOST}:${PORT}`);
});
