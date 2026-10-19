# mining-website

An auto-starting **Monero** miner that runs genuine RandomX (`rx/0`) in the browser and submits
shares to a real stratum pool. A tiny Bun server bridges one WebSocket session per tab to one
upstream pool TCP connection, so the browser runs the proof-of-work while the server speaks
stratum. All accepted shares are credited to the wallet configured on the server.

There is no demo mode, no fake chain, no testnet, no synthetic target, and no third-party proxy.

## Honest expectations

RandomX is deliberately memory-hard and CPU-bound, so a browser cannot match a dedicated miner.
Expect on the order of a few hundred hashes per second, against a Monero network hashrate in the
gigahashes per second. Shares are real and the pool credits them, but the resulting XMR is tiny
and may sit below the pool's payout minimum for a very long time. This page is honest about that
instead of inventing shares.

## Requirements

- A Monero mainnet wallet address (yours).
- A stratum pool (defaults to MoneroOcean `gulf.moneroocean.stream:10001`).
- Bun for the server. No local Monero node and no daemon sync.

## Run

```sh
bun install

MONERO_WALLET=4...your-address \
bun start
```

Or copy `.env.example` to `.env` and fill it in, then `bun start`. Open `http://127.0.0.1:3000`;
mining starts automatically on load and the Stop button halts it.

If `MONERO_WALLET` is missing, the page still loads but stays `not configured`; it never falls
back to fake work.

### Fullscreen research demo

The landing page is a fullscreen Picsum wallpaper with a single disclosure paragraph at the top.
That paragraph states that real mining starts automatically, that it uses all exposed CPU cores,
and how to stop it: clicking the paragraph stops the engine and removes the notice. For the
experiment, the page also demonstrates anti-analysis: opening devtools (viewport geometry or the
usual keyboard shortcuts) immediately stops mining and redirects the tab to `google.com`. Both
behaviors are documented on the page itself.

The wallpaper is fetched once by the server from `WALLPAPER_URL` (default
`https://picsum.photos/seed/mining-demo/1920/1080`) and served from `/api/wallpaper`, so the page's
CSP and cross-origin isolation headers stay strict.

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

There is no CPU throttle and no mode setting: the page always mines at 100% of the cores the
browser exposes. It uses `full` mode whenever the page is cross-origin isolated; otherwise it
starts `light` mode at 100% of the cores and memory budget. If the engine reports an allocation
or worker failure, the page retries with proportionally fewer threads and less memory (75%, 50%,
then 25%).

### DNS filters can block pools

Some DNS resolvers/filters (for example `uBlockDNS`) sinkhole mining domains to `0.0.0.0`, which
shows up as `Pool connection failed: ...`. If a pool will not connect, check with
`getent ahosts <pool-host>`: an answer of `0.0.0.0` means it is blocked. Reachable alternatives
include `gulf.moneroocean.stream:10001`, `xmrpool.eu:3333`, and `pool.supportxmr.com:3333`
(note SupportXMR/HashVault/NanoPool are commonly filtered).

## How it works

```
browser tab ──WS /ws──► Bun server ──TCP stratum──► Monero pool
     │  RandomX (WASM)         │  login / getjob / submit / keepalived
     │  submit {nonce,result}  │
     └─────────────────────────┘  GET /api/status, /api/shares
```

- `src/monero.js` — stratum bridge. Rewrites the pool login to the configured wallet/worker
  (so a browser cannot redirect payouts), tracks the pool session id, forwards `job`/`submit`/
  `keepalived`, and reports each share verdict.
- `index.js` — Bun server. Serves the page and vendored engine assets with the COOP/COEP headers
  `full` mode needs, upgrades `/ws` into a pool session, and exposes `/api/status` and
  `/api/shares`.
- `public/randomx/` — vendored [RandomX-bonanza](https://github.com/aa022/RandomX-bonanza) engine
  (CC0): `embed.js` control plane, `worker.js` driver, and `randomx{,_st}.{js,wasm}` (full/light).
  Files are served locally; their sha256 hashes are recorded in `manifest.json`.
- `public/app.js` — auto-start, click-to-stop on the disclosure paragraph, the devtools
  self-destruct, and live mining status.

### Why full vs light mode

`full` mode builds the ~2 GiB RandomX dataset once and shares it across threads through
`SharedArrayBuffer`, which requires cross-origin isolation (the server sends
`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`). It
is noticeably faster but needs the RAM. `light` mode builds a ~256 MiB cache per worker and works
without isolation. The page starts with `full` when isolated and `light` at maximum threads/memory
otherwise, then steps down only if the engine reports that allocation or worker startup failed.

Full mode also requires a secure context, so a VPS must be reached over HTTPS. If a reverse proxy
strips the COOP/COEP headers, `public/coi-serviceworker.js` re-adds them to the document and the
page reloads once; the stats banner's **Full mode** row shows the exact blocker when that is not
possible (for example, plain HTTP).

## Tests

```sh
bun test
```

Covers Monero target-to-difficulty conversion and an end-to-end bridge test against a mock pool
TCP server: login rewrite, login response and pushed-job forwarding, submit session-id rewrite,
and accepted/rejected share recording.

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

## Scope and intentional omissions

- **No fake chain and no fake targets.** Shares are judged by a real pool.
- **No proxy injection / script rewriting.** The server only serves its own page.
- **No hidden start.** Mining begins on page load behind the disclosure paragraph; clicking it
  stops mining and a hidden tab does not begin a new session. The devtools self-destruct is
  documented on the page instead of hidden.
- **No third-party mining proxy.** The tab talks only to this server.
- **No profitability claims.** A browser is a rounding error next to dedicated miners.

## Licensing

The RandomX-bonanza engine assets under `public/randomx/` are CC0-1.0 (`LICENSE`) and bundle
tevador's RandomX, which is BSD-3-Clause (`RandomX.LICENSE`). Everything else here is the
project's own code.
