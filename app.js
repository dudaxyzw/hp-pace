// Human Pace — mede o pace atual por GPS (ver docs/adr/0002)

const WINDOW_MS = 15000;        // janela do pace atual
const MAX_ACCURACY_M = 25;      // descarta leituras com precisão pior que isso
const MAX_SPEED_MS = 9;         // ~32 km/h: acima disso é salto de GPS, não corredor
const MIN_SPEED_MS = 3 / 3.6;   // abaixo de 3 km/h mostra --:--
const MIN_SPAN_MS = 5000;       // tempo mínimo de dados na janela para calcular
const STALE_MS = 10000;         // sem leitura há 10 s = sinal perdido
const LONG_PRESS_MS = 3000;     // toque longo para encerrar
const HOLD_MS = 10000;          // segura o último pace válido antes de mostrar --:--

const $ = (id) => document.getElementById(id);

let watchId = null;
let wakeLock = null;
let fixes = [];           // leituras aceitas dentro da janela: {t, lat, lon, acc, speed}
let lastAccepted = null;
let totalDistance = 0;    // metros, só trechos em movimento
let currentSpeed = null;  // m/s suavizado, null = sem dado
let lastValidPace = null; // {text, at}: último pace mostrado, para segurar em falhas curtas
const stats = { total: 0, rejectedAcc: 0, rejectedJump: 0, lastAcc: null, lastRawSpeed: null, lastFixAt: 0, source: "-" };

// ---------- Cálculo ----------

function haversine(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Velocidade média na janela. Prefere a velocidade Doppler que o próprio GPS informa
// (bem mais precisa que a posição); se o aparelho não informa, usa distância/tempo.
function windowSpeed() {
  if (fixes.length < 2) return null;
  const span = fixes[fixes.length - 1].t - fixes[0].t;
  if (span < MIN_SPAN_MS) return null;

  const withSpeed = fixes.filter((f) => f.speed != null && !Number.isNaN(f.speed));
  if (withSpeed.length >= fixes.length / 2) {
    stats.source = "doppler";
    return withSpeed.reduce((s, f) => s + f.speed, 0) / withSpeed.length;
  }

  stats.source = "posição";
  let dist = 0;
  for (let i = 1; i < fixes.length; i++) dist += haversine(fixes[i - 1], fixes[i]);
  return dist / (span / 1000);
}

function onPosition(pos) {
  const c = pos.coords;
  const fix = { t: pos.timestamp, lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed };
  stats.total++;
  stats.lastAcc = c.accuracy;
  stats.lastRawSpeed = c.speed;
  stats.lastFixAt = Date.now();

  if (c.accuracy > MAX_ACCURACY_M) { stats.rejectedAcc++; return; }

  let segment = 0;
  if (lastAccepted) {
    const dt = (fix.t - lastAccepted.t) / 1000;
    if (dt <= 0) return;
    segment = haversine(lastAccepted, fix);
    if (segment / dt > MAX_SPEED_MS) { stats.rejectedJump++; return; }
  }

  lastAccepted = fix;
  fixes.push(fix);
  while (fixes.length && fix.t - fixes[0].t > WINDOW_MS) fixes.shift();

  currentSpeed = windowSpeed();
  if (currentSpeed != null && currentSpeed >= MIN_SPEED_MS) totalDistance += segment;
}

function onPositionError(err) {
  stats.lastError = `${err.code}: ${err.message}`;
  if (err.code === err.PERMISSION_DENIED) {
    stopRun();
    $("start-msg").textContent = "Sem permissão de localização. Libere nas configurações do navegador e tente de novo.";
  }
}

// ---------- Tela ----------

function formatPace(speed) {
  if (speed == null || speed < MIN_SPEED_MS) return "--:--";
  const secPerKm = Math.round(1000 / speed);
  const m = Math.floor(secPerKm / 60);
  const s = String(secPerKm % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function render() {
  const stale = Date.now() - stats.lastFixAt > STALE_MS;
  const status = $("gps-status");
  status.classList.toggle("ok", !!lastAccepted && !stale);
  status.classList.toggle("lost", !!lastAccepted && stale);
  $("gps-text").textContent = lastAccepted && stale ? "sinal GPS perdido" : "buscando GPS";

  // Uma falha curta (GPS piscando, leitura ruim) não derruba o número: segura o último
  // pace válido por HOLD_MS. Só depois disso mostra --:--.
  const pace = stale ? "--:--" : formatPace(currentSpeed);
  let holding = false;
  if (pace !== "--:--") {
    lastValidPace = { text: pace, at: Date.now() };
    $("pace").textContent = pace;
  } else if (lastValidPace && Date.now() - lastValidPace.at < HOLD_MS) {
    holding = true;
    $("pace").textContent = lastValidPace.text;
  } else {
    $("pace").textContent = "--:--";
  }
  $("distance").textContent = (totalDistance / 1000).toFixed(2);

  const diag = $("diag");
  if (!diag.classList.contains("hidden")) {
    const fmt = (v, d = 1) => (v == null ? "—" : v.toFixed(d));
    diag.textContent = [
      `leituras:        ${stats.total}`,
      `rejeitadas acc:  ${stats.rejectedAcc}`,
      `rejeitadas salto:${stats.rejectedJump}`,
      `na janela:       ${fixes.length}`,
      `precisão (m):    ${fmt(stats.lastAcc)}`,
      `vel. bruta km/h: ${stats.lastRawSpeed == null ? "—" : fmt(stats.lastRawSpeed * 3.6)}`,
      `vel. janela km/h:${currentSpeed == null ? "—" : fmt(currentSpeed * 3.6)}`,
      `fonte:           ${stats.source}`,
      `segurando:       ${holding ? "sim" : "não"}`,
      `última leitura:  ${stats.lastFixAt ? ((Date.now() - stats.lastFixAt) / 1000).toFixed(0) + " s atrás" : "—"}`,
      `wake lock:       ${wakeLock ? "ativo" : "inativo"}`,
      stats.lastError ? `erro: ${stats.lastError}` : "",
    ].join("\n");
  }
}

// ---------- Ciclo de vida ----------

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { wakeLock = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && watchId != null) requestWakeLock();
});

async function startRun() {
  if (!("geolocation" in navigator)) {
    $("start-msg").textContent = "Este navegador não tem GPS disponível.";
    return;
  }
  try {
    await document.documentElement.requestFullscreen();
    await screen.orientation.lock("landscape");
  } catch { /* celular ou navegador sem suporte: segue sem travar */ }
  requestWakeLock();

  fixes = [];
  lastAccepted = null;
  totalDistance = 0;
  currentSpeed = null;
  lastValidPace = null;
  Object.assign(stats, { total: 0, rejectedAcc: 0, rejectedJump: 0, lastAcc: null, lastRawSpeed: null, lastFixAt: 0, lastError: null });

  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000,
  });

  $("start").classList.add("hidden");
  $("run").classList.remove("hidden");
}

function stopRun() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (wakeLock) wakeLock.release();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $("run").classList.add("hidden");
  $("start").classList.remove("hidden");
}

$("btn-start").addEventListener("click", startRun);
setInterval(() => { if (watchId != null) render(); }, 1000);

// Toque duplo: painel de diagnóstico. Toque longo: encerrar.
let lastTap = 0;
let pressTimer = null;
let pressStart = 0;
let progressRaf = null;

function cancelPress() {
  clearTimeout(pressTimer);
  cancelAnimationFrame(progressRaf);
  $("stop-progress").style.width = "0";
}

$("run").addEventListener("pointerdown", () => {
  pressStart = Date.now();
  const tick = () => {
    $("stop-progress").style.width = `${Math.min(100, ((Date.now() - pressStart) / LONG_PRESS_MS) * 100)}%`;
    progressRaf = requestAnimationFrame(tick);
  };
  tick();
  pressTimer = setTimeout(() => {
    cancelPress();
    if (confirm("Encerrar a medição?")) stopRun();
  }, LONG_PRESS_MS);
});

$("run").addEventListener("pointerup", () => {
  cancelPress();
  const now = Date.now();
  if (now - lastTap < 350) {
    $("diag").classList.toggle("hidden");
    render();
    lastTap = 0;
  } else {
    lastTap = now;
  }
});
$("run").addEventListener("pointercancel", cancelPress);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
