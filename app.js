// Human Pace — mede o pace atual por GPS (ver docs/adr/0002)
//
// Pipeline, a cada leitura do GPS (~1 por segundo):
//   1. filtra leituras ruins (precisão, saltos)
//   2. amostra de velocidade: Doppler do GPS, ou distância/tempo se o aparelho não informa
//   3. mediana das últimas amostras: tira picos isolados sem atrasar mudança real
//   4. One Euro Filter: suaviza forte quando estável, solta quando o ritmo muda
//   5. detecção de parada à parte: abaixo do limite por N leituras = parado na hora

// ---- Parâmetros ajustáveis ----
const MEDIAN_N = 5;             // amostras da mediana (anti-pico)
const MIN_SAMPLES = 3;          // amostras mínimas para mostrar o primeiro pace
const EURO_MIN_CUTOFF = 0.05;   // Hz. Menor = mais estável quando o ritmo está constante
const EURO_BETA = 0.7;          // Maior = reage mais rápido quando o ritmo muda
const EURO_D_CUTOFF = 1.0;      // Hz. Suavização da taxa de variação (raramente mexer)
const STOP_SPEED_MS = 3 / 3.6;  // abaixo de 3 km/h = parado
const STOP_CONFIRM = 2;         // leituras seguidas abaixo do limite para mostrar parado
const MAX_ACCURACY_M = 25;      // descarta leituras com precisão pior que isso
const MAX_SPEED_MS = 9;         // ~32 km/h: acima disso é salto de GPS, não corredor
const SIGNAL_GAP_MS = 3000;     // sem leitura boa há mais que isso = falha de sinal
const HOLD_MS = 10000;          // em falha de sinal, segura o último pace por até isso
const LONG_PRESS_MS = 3000;     // toque longo para encerrar

const $ = (id) => document.getElementById(id);

let watchId = null;
let wakeLock = null;
let lastAccepted = null;  // última leitura aceita: {t, lat, lon, acc, speed}
let samples = [];         // últimas amostras de velocidade (m/s)
let stopped = true;
let euro = null;          // estado do One Euro Filter
let totalDistance = 0;    // metros, só trechos em movimento
let currentSpeed = null;  // m/s filtrado, null = parado ou sem dado
let lastShownPace = "--:--";
const stats = {};

function resetStats() {
  Object.assign(stats, {
    total: 0, rejectedAcc: 0, rejectedJump: 0, lastAcc: null, lastSample: null,
    median: null, lastFixAt: 0, lastAcceptedAt: 0, source: "-", lastError: null,
  });
}
resetStats();

// ---------- Cálculo ----------

function haversine(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// One Euro Filter (Casiez et al., 2012): a frequência de corte sobe junto com a
// velocidade de mudança do sinal. Estável = filtra muito; mudando = quase sem atraso.
function smoothingFactor(dt, cutoff) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function euroFilter(x, t) {
  if (!euro) {
    euro = { x, dx: 0, t };
    return x;
  }
  const dt = Math.max((t - euro.t) / 1000, 0.1);
  const aD = smoothingFactor(dt, EURO_D_CUTOFF);
  const dx = aD * ((x - euro.x) / dt) + (1 - aD) * euro.dx;
  const a = smoothingFactor(dt, EURO_MIN_CUTOFF + EURO_BETA * Math.abs(dx));
  euro = { x: a * x + (1 - a) * euro.x, dx, t };
  return euro.x;
}

function onPosition(pos) {
  const c = pos.coords;
  const fix = { t: pos.timestamp, lat: c.latitude, lon: c.longitude, acc: c.accuracy, speed: c.speed };
  stats.total++;
  stats.lastAcc = c.accuracy;
  stats.lastFixAt = Date.now();

  if (c.accuracy > MAX_ACCURACY_M) { stats.rejectedAcc++; return; }

  let segment = 0;
  let sample = null;
  if (lastAccepted) {
    const dt = (fix.t - lastAccepted.t) / 1000;
    if (dt <= 0) return;
    segment = haversine(lastAccepted, fix);
    if (segment / dt > MAX_SPEED_MS) { stats.rejectedJump++; return; }
    sample = segment / dt;
    stats.source = "posição";
  }
  if (c.speed != null && !Number.isNaN(c.speed)) {
    sample = c.speed;
    stats.source = "doppler";
  }

  lastAccepted = fix;
  stats.lastAcceptedAt = Date.now();
  if (sample == null) return;

  stats.lastSample = sample;
  samples.push(sample);
  if (samples.length > MEDIAN_N) samples.shift();
  if (samples.length < MIN_SAMPLES) return;

  const med = median(samples);
  stats.median = med;

  // Parada: as últimas STOP_CONFIRM amostras brutas abaixo do limite. Não passa pelo filtro.
  const recent = samples.slice(-STOP_CONFIRM);
  const nowStopped = recent.length === STOP_CONFIRM && recent.every((s) => s < STOP_SPEED_MS);

  if (nowStopped || med < STOP_SPEED_MS) {
    stopped = true;
    currentSpeed = null;
    euro = null; // ao voltar a correr, o filtro começa do ritmo novo, sem rampa desde zero
    return;
  }

  stopped = false;
  currentSpeed = euroFilter(med, fix.t);
  totalDistance += segment;
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
  if (speed == null || speed < STOP_SPEED_MS) return "--:--";
  const secPerKm = Math.round(1000 / speed);
  const m = Math.floor(secPerKm / 60);
  const s = String(secPerKm % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function render() {
  const sinceGood = Date.now() - stats.lastAcceptedAt;
  const signalOk = !!lastAccepted && sinceGood <= SIGNAL_GAP_MS;
  const lost = !!lastAccepted && sinceGood > HOLD_MS;

  // A retenção vale só para falha de sinal. Parada real aparece na hora.
  let holding = false;
  if (signalOk) {
    lastShownPace = formatPace(currentSpeed);
  } else if (!lastAccepted || lost) {
    lastShownPace = "--:--";
  } else {
    holding = true;
  }
  $("pace").textContent = lastShownPace;
  // Segmentos apagados no mesmo formato do número (8:88 ou 88:88), para alinhar dígito a dígito
  $("ghost").textContent = lastShownPace.replace(/[0-9-]/g, "8");

  const status = $("gps-status");
  status.classList.toggle("ok", !!lastAccepted && !lost);
  status.classList.toggle("lost", lost);
  $("gps-text").textContent = lost ? "sinal GPS perdido" : "buscando GPS";

  $("distance").textContent = (totalDistance / 1000).toFixed(2);

  const diag = $("diag");
  if (!diag.classList.contains("hidden")) {
    const kmh = (v) => (v == null ? "—" : (v * 3.6).toFixed(1));
    diag.textContent = [
      `leituras:         ${stats.total}`,
      `rejeitadas acc:   ${stats.rejectedAcc}`,
      `rejeitadas salto: ${stats.rejectedJump}`,
      `precisão (m):     ${stats.lastAcc == null ? "—" : stats.lastAcc.toFixed(1)}`,
      `fonte:            ${stats.source}`,
      `amostra km/h:     ${kmh(stats.lastSample)}`,
      `mediana km/h:     ${kmh(stats.median)}`,
      `filtrada km/h:    ${kmh(currentSpeed)}`,
      `parado:           ${stopped ? "sim" : "não"}`,
      `segurando:        ${holding ? "sim" : "não"}`,
      `última leitura:   ${stats.lastFixAt ? ((Date.now() - stats.lastFixAt) / 1000).toFixed(0) + " s atrás" : "—"}`,
      `wake lock:        ${wakeLock ? "ativo" : "inativo"}`,
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

  lastAccepted = null;
  samples = [];
  stopped = true;
  euro = null;
  totalDistance = 0;
  currentSpeed = null;
  lastShownPace = "--:--";
  resetStats();

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
