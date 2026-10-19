import { afterAll, expect, test } from "bun:test";
import { createSession, targetToDiff } from "../src/monero.js";

const TEST_WALLET = "4AEm9oe64pUY2saKdCQfSrg5Xy5N8TgGcecM8qZhcri1FSWdvJ4mFAzhfS3my4Cca7dNyZea7BRb2KannBpRBY1yGytE5fv";

async function waitFor(predicate, timeout = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

test("targetToDiff converts Monero stratum targets", () => {
  expect(targetToDiff("ffffffff")).toBe(1);
  expect(targetToDiff("7fffffff")).toBe(2);
  expect(targetToDiff("ffffffffffffffff")).toBe(1);
  expect(targetToDiff("00".repeat(24) + "ffffffffffffffff")).toBe(1);
});

test("targetToDiff rejects malformed targets", () => {
  expect(targetToDiff("abc")).toBe(0);
  expect(targetToDiff("")).toBe(0);
  expect(targetToDiff("00000000")).toBe(0);
  expect(targetToDiff("0000000000000000")).toBe(0);
  expect(targetToDiff("00".repeat(32))).toBe(0);
  expect(targetToDiff(null)).toBe(0);
});

test("session rewrites login, forwards jobs, and records share verdicts", async () => {
  const received = [];
  const buffers = new Map();

  const pool = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        let buffer = buffers.get(socket) || "";
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffers.set(socket, lines.pop());
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          received.push(msg);
          if (msg.method === "login") {
            socket.write(
              JSON.stringify({
                id: msg.id,
                jsonrpc: "2.0",
                error: null,
                result: {
                  id: "sess-1",
                  job: {
                    job_id: "job-1",
                    blob: "ab".repeat(43),
                    seed_hash: "cd".repeat(32),
                    target: "ffffffff",
                  },
                  extensions: ["keepalive"],
                },
              }) + "\n",
            );
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "job",
                params: { job_id: "job-2", blob: "ef".repeat(43), seed_hash: "cd".repeat(32), target: "ffffffff" },
              }) + "\n",
            );
          } else if (msg.method === "submit") {
            const reject = msg.params.nonce === "deadbeef";
            socket.write(
              JSON.stringify({
                id: msg.id,
                jsonrpc: "2.0",
                error: reject ? { code: -1, message: "low difficulty share" } : null,
                result: reject ? null : { status: "OK" },
              }) + "\n",
            );
          }
        }
      },
      close(socket) {
        buffers.delete(socket);
      },
    },
  });

  const clientMessages = [];
  const shares = [];
  const session = createSession({
    sendToClient: (text) => clientMessages.push(JSON.parse(text)),
    onShare: (share) => shares.push(share),
    pool: { host: "127.0.0.1", port: pool.port },
    wallet: TEST_WALLET,
    worker: "browser",
  });

  session.handleClientMessage(
    JSON.stringify({ id: 1, jsonrpc: "2.0", method: "login", params: { login: "attacker", pass: "x", rigid: "x" } }),
  );

  await waitFor(() => received.some((msg) => msg.method === "login"));
  const login = received.find((msg) => msg.method === "login");
  expect(login.params.login).toBe(TEST_WALLET);
  expect(login.params.pass.startsWith("browser-")).toBe(true);
  expect(login.params.rigid).toBe(login.params.pass);
  expect(login.params.algo).toEqual(["rx/0"]);

  await waitFor(() => clientMessages.some((msg) => msg.id === 1));
  expect(clientMessages.find((msg) => msg.id === 1).result.id).toBe("sess-1");
  await waitFor(() => clientMessages.some((msg) => msg.method === "job"));

  session.handleClientMessage(
    JSON.stringify({ id: 2, jsonrpc: "2.0", method: "submit", params: { id: "spoofed", job_id: "job-1", nonce: "01000000", result: "aa" } }),
  );
  await waitFor(() => shares.length === 1);
  expect(received.find((msg) => msg.method === "submit").params.id).toBe("sess-1");
  expect(shares[0].accepted).toBe(true);
  expect(shares[0].error).toBe(null);

  session.handleClientMessage(
    JSON.stringify({ id: 3, jsonrpc: "2.0", method: "submit", params: { job_id: "job-1", nonce: "deadbeef", result: "bb" } }),
  );
  await waitFor(() => shares.length === 2);
  expect(shares[1].accepted).toBe(false);
  expect(shares[1].error).toBe("low difficulty share");

  session.handleClientMessage(JSON.stringify({ id: 9, method: "ping" }));
  await waitFor(() => clientMessages.some((msg) => msg.id === 9));
  expect(clientMessages.find((msg) => msg.id === 9).result.status).toBe("OK");

  session.close();
  pool.stop(true);
});

afterAll(() => {
  // Nothing global to clean up; each test owns its resources.
});
