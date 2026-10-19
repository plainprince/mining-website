# mining-website

**Status: proof of concept — not production software.** This repo demonstrates that an ordinary
browser tab can run genuine Monero RandomX (`rx/0`) proof-of-work and submit real shares to a real
stratum pool through a small Bun bridge. It is intentionally rough: there is no authentication, no
built-in TLS, no operator UI, no payout handling, and no guarantee that the value of the mined
shares exceeds the electricity used. Treat it as a research/demo project.

## Quick start

### 1. Requirements

- [Bun](https://bun.sh/) for the server.
- A Monero mainnet wallet address (yours).
- A stratum pool (defaults to MoneroOcean `gulf.moneroocean.stream:10001`).
- No local Monero node and no daemon sync.

### 2. Install

```sh
bun install
```

### 3. Configure

Copy the example environment file and set your wallet:

```sh
cp .env.example .env
```

Minimum `.env`:

```sh
MONERO_WALLET=4...your-address
```

Or pass it inline:

```sh
MONERO_WALLET=4...your-address bun start
```

The server rewrites the pool login and worker name, so every accepted share is credited to
`MONERO_WALLET` no matter what the browser sends. The browser cannot redirect payouts.

If `MONERO_WALLET` is missing, the page still loads but stays `not configured`; it never falls back
to fake work.

### 4. Run

```sh
bun start
```

For auto-reload during development:

```sh
bun run dev
```

Then open `http://127.0.0.1:3000`. Mining starts automatically on page load.

### 5. Use the page

- **`p`** toggles the stats banner (hashrate, dataset state, threads, shares, pool, wallet, etc.).
  The key is `STATS_KEY` in `public/app.js` if you want to change it.
- The current proof-of-concept page has no stop button and no disclosure paragraph. Closing or
  reloading the tab stops the engine. A hidden tab is throttled or suspended by the browser.
- Opening devtools (`F12`, `Ctrl+Shift+I/J/C`, `Cmd+Alt+I/J/C`) or resizing the viewport so a
  devtools panel is detected stops mining and redirects the tab to `google.com`. This anti-debug
  behavior is part of the demo, not a security boundary.

### 6. Remote / VPS setup

Full mode needs a secure context (HTTPS) plus cross-origin isolation. Serving the page over plain
`http://VPS-IP:3000` will fall back to light mode. Put it behind HTTPS.

The Bun server sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` itself. If a reverse proxy strips them,
`public/coi-serviceworker.js` re-adds them and the page reloads once. The stats banner's
**Full mode** row shows the exact blocker when full mode still is not available.

## Honest expectations

There is no demo mode, no fake chain, no testnet, no synthetic target, and no third-party proxy.
RandomX is deliberately memory-hard and CPU-bound, so a browser cannot match a dedicated miner.
Expect on the order of a few hundred hashes per second, against a Monero network hashrate in the
gigahashes per second. Shares are real and the pool credits them, but the resulting XMR is tiny and
may sit below the pool's payout minimum for a very long time. This page is honest about that
instead of inventing shares.

## Configuration

| Variable           | Default                       | Meaning                                                  |
| ------------------ | ----------------------------- | -------------------------------------------------------- |
| `MONERO_WALLET`    | —                             | Required. All accepted shares are credited here          |
| `MONERO_POOL_HOST` | `gulf.moneroocean.stream`     | Pool hostname                                            |
| `MONERO_POOL_PORT` | `10001`                       | Pool stratum port                                        |
| `MONERO_POOL_TLS`  | `false`                       | `true` for a TLS stratum port                            |
| `MONERO_WORKER`    | `browser`                     | Worker/rig name; a unique per-session suffix is appended |
| `PORT`             | `3000`                        | HTTP port                                                |
| `HOST`             | `127.0.0.1`                   | Bind address                                             |
| `SHARES_PATH`      | `shares.json`                 | Where pool-answered shares are stored                    |
| `MAX_SHARES`       | `5000`                        | Rolling cap on stored records                            |
| `WALLPAPER_URL`    | Picsum seed `mining-demo`     | Background image fetched once and cached by the server   |

There is no CPU throttle or fixed mode setting: the page tries to use every core the browser
exposes. Mode and thread allocation are automatic:

1. `full` mode whenever the page is cross-origin isolated.
2. Otherwise `light` mode at 100% of cores and the memory budget.
3. If the engine reports an allocation or worker-startup failure, retry at 75%, then 50%, then 25%
   of the cores and memory. Explicit full-dataset replicas are disabled so every slot mines.

## Stats banner

Press `p` to show or hide the overlay. It reads:

| Row             | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `State`         | Engine phase (`mining`, `initializing`, `connecting`, `stopped`, …)      |
| `Hashrate`      | Current session hashrate                                                |
| `Dataset`       | `full`/`light`, dataset build progress, and worker count                |
| `Full mode`     | `available`, or why it is blocked (`needs HTTPS`, `COOP/COEP missing`, …) |
| `Threads`       | Mining threads / cores reported by the browser                          |
| `Accepted`      | Accepted shares in this browser session                                 |
| `Rejected`      | Rejected shares in this browser session                                 |
| `Pool`          | Upstream stratum host and port                                          |
| `Worker`        | Configured worker prefix (the pool sees a unique suffix)                |
| `Wallet`        | Shortened configured payout wallet                                      |
| `Stored shares` | Accepted/rejected totals persisted by the server across sessions        |

## How it works

```
browser tab ──WS /ws──► Bun server ──TCP stratum──► Monero pool
     │  RandomX (WASM)         │  login / getjob / submit / keepalived
     │  submit {nonce,result}  │
     └─────────────────────────┘  GET /api/status, /api/shares
```

- `src/monero.js` — stratum bridge. Rewrites the pool login to the configured wallet/worker (so a
  browser cannot redirect payouts), tracks the pool session id, forwards `job`/`submit`/
  `keepalived`, and reports each share verdict.
- `index.js` — Bun server. Serves the page and vendored engine assets with the COOP/COEP headers
  `full` mode needs, upgrades `/ws` into a pool session, and exposes the HTTP API.
- `public/randomx/` — vendored [RandomX-bonanza](https://github.com/aa022/RandomX-bonanza) engine
  (CC0): `embed.js` control plane, `worker.js` driver, and `randomx{,_st}.{js,wasm}` (full/light).
  Files are served locally; their sha256 hashes are recorded in `manifest.json`.
- `public/app.js` — auto-start, mode selection and fallback ladder, the `p` stats banner, the
  devtools self-destruct, and service-worker-based isolation recovery.
- `public/coi-serviceworker.js` — re-adds COOP/COEP to document navigations when a reverse proxy
  strips them, enabling full mode without changing the proxy.
- `public/index.html` — fullscreen wallpaper page and the hidden stats overlay.

### HTTP and WebSocket endpoints

| Endpoint        | Purpose                                                              |
| --------------- | -------------------------------------------------------------------- |
| `GET /healthz`  | Plain `ok` health check                                              |
| `GET /api/status` | Pool, wallet, worker, stored-share counts, and server time         |
| `GET /api/shares` | Stored-share counts plus the 25 most recent records                |
| `GET /api/wallpaper` | Background image fetched and cached server-side                |
| `WS /ws`        | One browser session bridged to one upstream stratum connection       |

## Full vs light mode

`full` mode builds the ~2 GiB RandomX dataset once and shares it across pthreads through
`SharedArrayBuffer`, which requires cross-origin isolation. It is faster and uses less total RAM
than running the same number of independent light workers.

`light` mode builds a ~256 MiB cache per worker and needs no isolation, but each worker is
independent. Without isolation the page cannot use full mode at all — that is a browser security
gate, not a configuration choice.

If full mode is available but fails (for example, the device cannot allocate the dataset), the page
falls back to light mode. It only reduces threads/memory after the engine reports an actual
failure. See the stats banner's **Full mode** row for the current reason.

### DNS filters can block pools

Some DNS resolvers/filters (for example `uBlockDNS`) sinkhole mining domains to `0.0.0.0`, which
shows up as `Pool connection failed: ...`. If a pool will not connect, check with
`getent ahosts <pool-host>`: an answer of `0.0.0.0` means it is blocked. Reachable alternatives
include `gulf.moneroocean.stream:10001`, `xmrpool.eu:3333`, and `pool.supportxmr.com:3333`
(note SupportXMR/HashVault/NanoPool are commonly filtered).

## Tests

```sh
bun test
```

Covers Monero target-to-difficulty conversion and an end-to-end bridge test against a mock pool TCP
server: login rewrite, login response and pushed-job forwarding, submit session-id rewrite, and
accepted/rejected share recording.

## Stored share format

```json
{
  "id": "…",
  "key": "<job_id>:<nonce>:<result>",
  "submittedAt": "2026-01-01T00:00:00.000Z",
  "answeredAt": "2026-01-01T00:00:00.100Z",
  "job_id": "…",
  "nonce": "1a2b3c4d",
  "result": "<32-byte hash hex>",
  "worker": "browser-abc123",
  "accepted": true,
  "error": null
}
```

Rejected shares keep the pool's error message in `error`.

## Proof-of-concept limitations

- **No authentication or rate limiting.** Anyone who can reach the server can mine to your
  configured wallet (using their own CPU).
- **No built-in TLS.** Use a reverse proxy for HTTPS; full mode requires it.
- **No stop button or disclosure paragraph in the current page.** Mining auto-starts and stops
  when the tab is closed/navigated away. The devtools redirect is demo behavior, not security.
- **No payout management.** Shares are credited by the pool to `MONERO_WALLET`; this project does
  not track balances or withdrawals.
- **No fake chain and no fake targets.** Shares are judged by a real pool.
- **No third-party mining proxy.** The tab talks only to this server.
- **No profitability claims.** A browser is a rounding error next to dedicated miners.
- **Not hardened for public deployment.** Run it on a trusted network or behind your own access
  controls while experimenting.

## Licensing

The RandomX-bonanza engine assets under `public/randomx/` are CC0-1.0 (`LICENSE`) and bundle
tevador's RandomX, which is BSD-3-Clause (`RandomX.LICENSE`). Everything else here is the
project's own code.
