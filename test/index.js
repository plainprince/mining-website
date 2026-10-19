import { randomUUID } from "node:crypto";
import { join, normalize, extname, sep } from "node:path";
import { createSession, targetToDiff } from "./src/monero.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const SHARES_PATH = process.env.SHARES_PATH || "shares.json";
const MAX_SHARES = Math.max(100, Number(process.env.MAX_SHARES || 5000));

const WALLET = (process.env.MONERO_WALLET || "").trim();
const POOL_HOST = (process.env.MONERO_POOL_HOST || "gulf.moneroocean.stream").trim();
const POOL_PORT = Number(process.env.MONERO_POOL_PORT || 10001);
const POOL_TLS = /^(1|true|yes)$/i.test(process.env.MONERO_POOL_TLS || "");
const WORKER = (process.env.MONERO_WORKER || "browser").trim().slice(0, 64) || "browser";
const WALLPAPER_URL = (process.env.WALLPAPER_URL || "https://picsum.photos/seed/mining-demo/1920/1080").trim();

const ASSET_BASE = "/randomx/";
const PUBLIC_DIR = join(import.meta.dir, "public");

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

const configErrors = [];
if (!WALLET) configErrors.push("MONERO_WALLET is not set");
if (!POOL_HOST) configErrors.push("MONERO_POOL_HOST is not set");
if (!Number.isInteger(POOL_PORT) || POOL_PORT < 1 || POOL_PORT > 65535) {
  configErrors.push("MONERO_POOL_PORT must be 1-65535");
}
if (WALLET && WALLET.length < 90) {
  configErrors.push("MONERO_WALLET does not look like a Monero address");
}

const configured = configErrors.length === 0;
const mode = configured ? "pool" : "unconfigured";

/* ------------------------------------------------------------------ */
/* Share storage                                                      */
/* ------------------------------------------------------------------ */

class ShareStore {
  constructor(path, limit) {
    this.path = path;
    this.limit = limit;
    this.items = [];
    this.seen = new Set();
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      const data = await Bun.file(this.path).json();
      if (!Array.isArray(data)) return;
      this.items = data.slice(-this.limit);
      this.seen = new Set(this.items.map((item) => item.key).filter(Boolean));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.error(`shares: could not read ${this.path}:`, error);
      }
    }
  }

  get size() {
    return this.items.length;
  }

  counts() {
    let accepted = 0;
    let rejected = 0;
    for (const item of this.items) {
      if (item.accepted) accepted++;
      else rejected++;
    }
    return { total: this.items.length, accepted, rejected };
  }

  recent(count) {
    return this.items.slice(-count).reverse();
  }

  add(record) {
    if (record.key && this.seen.has(record.key)) return this.writeQueue;
    this.items.push(record);
    if (record.key) this.seen.add(record.key);
    while (this.items.length > this.limit) {
      const dropped = this.items.shift();
      if (dropped?.key) this.seen.delete(dropped.key);
    }
    return this.persist();
  }

  persist() {
    const snapshot = JSON.stringify(this.items, null, 2);
    this.writeQueue = this.writeQueue
      .then(() => Bun.write(this.path, snapshot))
      .catch((error) => console.error("shares: write failed:", error));
    return this.writeQueue;
  }
}

const store = new ShareStore(SHARES_PATH, MAX_SHARES);
await store.load();

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// SharedArrayBuffer + wasm pthreads (full mode) require cross-origin isolation,
// which means COOP same-origin plus COEP require-corp on every subresource.
const ISOLATION_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' blob: 'wasm-unsafe-eval' 'unsafe-eval'",
    "worker-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

let wallpaperCache = null;
let wallpaperRequest = null;

async function loadWallpaper() {
  if (wallpaperCache) return wallpaperCache;

  if (!wallpaperRequest) {
    wallpaperRequest = (async () => {
      const response = await fetch(WALLPAPER_URL, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      wallpaperCache = {
        body: new Uint8Array(await response.arrayBuffer()),
        type: response.headers.get("content-type") || "image/jpeg",
      };
      return wallpaperCache;
    })().finally(() => {
      wallpaperRequest = null;
    });
  }

  return wallpaperRequest;
}

async function wallpaperResponse() {
  try {
    const { body, type } = await loadWallpaper();
    return new Response(body, {
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=3600",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  } catch (error) {
    return new Response(`wallpaper unavailable: ${error.message}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}

function serveFile(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(PUBLIC_DIR, relative));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    return new Response("forbidden", { status: 403, headers: ISOLATION_HEADERS });
  }

  const file = Bun.file(target);
  const headers = {
    "content-type": MIME[extname(target)] || "application/octet-stream",
    "cache-control": "no-store",
    ...ISOLATION_HEADERS,
  };
  return new Response(file, { headers });
}

/* ------------------------------------------------------------------ */
/* Status                                                             */
/* ------------------------------------------------------------------ */

function shortWallet(wallet) {
  if (!wallet) return null;
  if (wallet.length <= 16) return wallet;
  return `${wallet.slice(0, 8)}…${wallet.slice(-8)}`;
}

function statusPayload() {
  return {
    mode,
    configured,
    errors: configErrors,
    engine: {
      assets: ASSET_BASE,
      version: "0.3.0",
    },
    pool: {
      host: POOL_HOST,
      port: POOL_PORT,
      tls: POOL_TLS,
      url: `${POOL_TLS ? "stratum+ssl" : "stratum+tcp"}://${POOL_HOST}:${POOL_PORT}`,
    },
    wallet: WALLET || null,
    walletShort: shortWallet(WALLET),
    worker: WORKER,
    shares: { ...store.counts(), path: SHARES_PATH },
    serverTime: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* WebSocket <-> pool bridge                                          */
/* ------------------------------------------------------------------ */

const sessions = new Set();

function createBridge(ws) {
  const session = createSession({
    sendToClient: (text) => {
      try {
        ws.send(text);
      } catch {
        /* client gone */
      }
    },
    onShare: (share) => {
      const record = {
        id: randomUUID(),
        key: `${share.job_id}:${share.nonce}:${share.result}`,
        submittedAt: share.submittedAt,
        answeredAt: share.answeredAt,
        job_id: share.job_id,
        nonce: share.nonce,
        result: share.result,
        worker: share.worker,
        accepted: share.accepted,
        error: share.error,
      };
      store.add(record);
    },
    onLog: (line) => console.log(`[pool] ${line}`),
    pool: { host: POOL_HOST, port: POOL_PORT },
    wallet: WALLET,
    worker: WORKER,
    tls: POOL_TLS,
  });

  sessions.add(session);
  return session;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  routes: {
    "/healthz": () => new Response("ok"),
    "/api/status": { GET: () => json(statusPayload()) },
    "/api/wallpaper": { GET: () => wallpaperResponse() },
    "/api/shares": {
      GET: () =>
        json({
          mode,
          configured,
          total: store.size,
          counts: store.counts(),
          items: store.recent(25),
        }),
    },
  },
  websocket: {
    open(ws) {
      ws.data.session = createBridge(ws);
    },
    message(ws, message) {
      ws.data.session?.handleClientMessage(typeof message === "string" ? message : message.toString());
    },
    close(ws) {
      const session = ws.data.session;
      if (session) {
        sessions.delete(session);
        session.close();
        ws.data.session = null;
      }
    },
  },
  fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      if (srv.upgrade(req, { data: {} })) return;
      return new Response("websocket upgrade failed", { status: 400 });
    }

    return serveFile(url.pathname);
  },
});

console.log(`browser Monero pool miner on http://${HOST}:${server.port}`);
if (configured) {
  console.log(`mode=pool pool=${POOL_TLS ? "ssl" : "tcp"}://${POOL_HOST}:${POOL_PORT} wallet=${shortWallet(WALLET)}`);
  console.log(`shares=${SHARES_PATH} shares_max=${MAX_SHARES}`);
  console.log("browser RandomX hashrate is real but small; pool payouts arrive per accepted share.");
} else {
  console.log(`mode=unconfigured: ${configErrors.join("; ")}`);
  console.log("set MONERO_WALLET (and optionally MONERO_POOL_HOST/PORT) in .env; see .env.example");
}

function shutdown() {
  for (const session of sessions) session.close();
  sessions.clear();
  server.stop(true);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}

export { server, store, mode, configured, statusPayload, targetToDiff, shutdown };
