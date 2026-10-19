/**
 * Browser <-> Monero pool bridge.
 *
 * A browser cannot open a raw TCP socket, so one WebSocket client session is
 * paired with one upstream pool TCP connection. Messages are line-delimited
 * JSON-RPC and are forwarded verbatim, except that the login is rewritten so
 * the configured wallet/worker always receive the work and credit.
 */

const LINE = "\n";
const MAX_BUFFER = 1 << 20;
const MAX_PENDING = 64;

function randomWorkerSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

function messageText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.message || JSON.stringify(value);
  return String(value);
}

/**
 * Convert a Monero stratum target into an approximate pool difficulty. Mirrors
 * the classic xmrig/cryptonote conversion: a 4-byte target is a 32-bit
 * difficulty seed (numeric hex value), while 8-byte and full 32-byte targets
 * are raw little-endian targets read from the high 64 bits.
 */
export function targetToDiff(targetHex) {
  if (typeof targetHex !== "string" || targetHex.length === 0 || targetHex.length % 2 !== 0) return 0;
  let raw;
  try {
    raw = Buffer.from(targetHex, "hex");
  } catch {
    return 0;
  }
  if (raw.length !== targetHex.length / 2) return 0;

  let target = 0n;
  if (raw.length === 4) {
    const t32 = BigInt(raw.readUInt32BE(0));
    if (t32 === 0n) return 0;
    target = 0xffffffffffffffffn / (0xffffffffn / t32);
  } else if (raw.length === 8) {
    target = raw.readBigUInt64LE(0);
  } else if (raw.length >= 32) {
    target = raw.readBigUInt64LE(24);
  } else {
    return 0;
  }

  if (target === 0n) return 0;
  return Number(0xffffffffffffffffn / target);
}

/**
 * One pool session. `sendToClient` receives JSON strings, `onShare` receives
 * a record for every submitted share the pool answers.
 */
export function createSession({
  sendToClient,
  onShare,
  onLog,
  pool,
  wallet,
  worker = "browser",
  tls = false,
  agent = "browser-pool/1.0",
  connect = Bun.connect,
}) {
  const log = typeof onLog === "function" ? onLog : () => {};
  const workerName = `${worker}-${randomWorkerSuffix()}`;

  let socket = null;
  let ready = false;
  let connecting = false;
  let closed = false;
  let buffer = "";
  let minerId = null;
  const pendingLines = [];
  const pendingSubmits = new Map();

  const safeSend = (value) => {
    try {
      sendToClient(typeof value === "string" ? value : JSON.stringify(value));
    } catch {
      /* client already gone */
    }
  };

  const sendError = (message) => safeSend({ error: message });

  function flush() {
    if (!ready || !socket) return;
    while (pendingLines.length) socket.write(pendingLines.shift());
  }

  function connectPool() {
    if (socket || connecting || closed) return;
    connecting = true;

    connect({
      hostname: pool.host,
      port: pool.port,
      tls,
      socket: {
        data(_s, data) {
          handleData(data);
        },
        close() {
          socket = null;
          ready = false;
          connecting = false;
          sendError("Pool disconnected");
        },
        error(_s, error) {
          sendError(`Pool socket error: ${messageText(error)}`);
        },
        connectError(_s, error) {
          socket = null;
          ready = false;
          connecting = false;
          sendError(`Pool connection failed: ${messageText(error)}`);
        },
        end() {
          socket = null;
          ready = false;
          sendError("Pool closed the connection");
        },
      },
    })
      .then((connected) => {
        if (closed) {
          connected.end?.();
          return;
        }
        socket = connected;
        ready = true;
        connecting = false;
        log(`connected ${pool.host}:${pool.port}`);
        flush();
      })
      .catch((error) => {
        connecting = false;
        sendError(`Pool connection failed: ${messageText(error)}`);
      });
  }

  function sendToPool(message) {
    const line = JSON.stringify(message) + LINE;
    if (ready && socket) socket.write(line);
    else {
      if (pendingLines.length >= MAX_PENDING) pendingLines.shift();
      pendingLines.push(line);
      connectPool();
    }
  }

  function handleData(data) {
    buffer += data.toString();
    if (buffer.length > MAX_BUFFER) {
      buffer = buffer.slice(-MAX_BUFFER);
      sendError("Pool sent an oversized message");
    }

    const lines = buffer.split(LINE);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`dropped non-JSON pool line: ${line.slice(0, 80)}`);
        continue;
      }

      const id = msg?.result?.id;
      if (id !== undefined && minerId === null) minerId = id;

      const job = msg?.result?.job || (msg?.method === "job" ? msg.params : null);
      if (job?.target) log(`job ${job.job_id} diff ${targetToDiff(job.target) || "?"}`);

      if (msg?.id !== undefined && pendingSubmits.has(msg.id)) {
        const share = pendingSubmits.get(msg.id);
        pendingSubmits.delete(msg.id);
        const accepted = !msg.error;
        onShare?.({
          ...share,
          accepted,
          error: accepted ? null : messageText(msg.error),
          answeredAt: new Date().toISOString(),
        });
      }

      safeSend(msg);
    }
  }

  function handleClientMessage(raw) {
    if (closed) return;

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

    // Legacy embed keepalive probe; answer locally.
    if (msg.method === "ping") {
      safeSend({ id: msg.id, result: { status: "OK" } });
      return;
    }

    if (msg.method === "login") {
      msg.params = msg.params && typeof msg.params === "object" ? msg.params : {};
      msg.params.login = wallet;
      msg.params.pass = workerName;
      msg.params.rigid = workerName;
      msg.params.agent = agent;
      msg.params.algo = ["rx/0"];
      sendToPool(msg);
      return;
    }

    if (msg.method === "submit") {
      msg.params = msg.params && typeof msg.params === "object" ? msg.params : {};
      if (minerId !== null) msg.params.id = minerId;
      if (msg.id !== undefined) {
        pendingSubmits.set(msg.id, {
          job_id: msg.params.job_id,
          nonce: msg.params.nonce,
          result: msg.params.result,
          worker: workerName,
          submittedAt: new Date().toISOString(),
        });
      }
      sendToPool(msg);
      return;
    }

    sendToPool(msg);
  }

  function close() {
    closed = true;
    pendingLines.length = 0;
    pendingSubmits.clear();
    if (socket) {
      try {
        socket.end();
      } catch {
        /* already closed */
      }
      socket = null;
    }
    ready = false;
  }

  return { handleClientMessage, close, workerName };
}
