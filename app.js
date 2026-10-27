// Human Pace — mede o pace atual por GPS (ver docs/adr/0002)
//
// Pipeline, a cada leitura do GPS (~1 por segundo):
//   1. filtra leituras ruins (precisão, saltos)
//   2. amostra de velocidade: Doppler do GPS, ou distância/tempo se o aparelho não informa
//   3. mediana das últimas amostras: tira picos isolados sem atrasar mudança real
//   4. One Euro Filter: suaviza forte quando estável, solta quando o ritmo muda
//   5. detecção de parada à parte: abaixo do limite por N leituras = parado na hora
//   6. na tela, pace em degraus de 5 s com histerese: só troca de degrau quando o ritmo
//      passa do meio do caminho com folga, para o número não ficar pulando na divisa
//   7. o número muda no máximo a cada 5 s; parar e voltar a correr aparecem na hora
//
// Com "GPS + sensores" (padrão), o acelerômetro ajuda em duas coisas:
//   - parada: tablet sem balanço por ~1,5 s = parado na hora, sem esperar o GPS
//   - falha de sinal: enquanto o acelerômetro detecta passos, segura o último pace
//     do GPS por mais tempo (não estima um pace novo)
// "Só GPS" é a medição original, sem nada disso.
//
// Vinheta (standby): com "--:--" na tela por IDLE_AFTER_MS, toca assets/vinheta.mp4 em loop.
// Sai no primeiro movimento. Não mexe na medição: só lê o que está na tela e o acelerômetro.
// A posição do vídeo segue o relógio (hora do servidor), então os tablets tocam alinhados.

const APP_VERSION = "v18"; // mudar junto com CACHE no sw.js

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
const HOLD_MS = 5000;           // em falha de sinal, segura o último pace por até isso
const LONG_PRESS_MS = 3000;     // toque longo para encerrar
const PACE_STEP_S = 5;          // pace na tela de 5 em 5 s (último dígito 0 ou 5)
const PACE_HYST_S = 2;          // s além do meio do degrau para trocar de degrau
const PACE_REFRESH_MS = 5000;   // troca o número na tela no máximo a cada isso

// Vinheta e relógio
const IDLE_AFTER_MS = 20000;    // "--:--" na tela por isso = entra na vinheta
const VIDEO_SYNC_MS = 500;      // confere a posição do vídeo a cada isso
const VIDEO_SEEK_S = 0.5;       // desvio maior que isso: pula; menor: acelera ou freia de leve
const VIDEO_SEEK_LEAD_S = 0.15; // pula um pouco à frente, porque o pulo leva um instante
const CLOCK_URL = "https://www.cloudflare.com/cdn-cgi/trace"; // responde "ts=<segundos>", com CORS
const CLOCK_SAMPLES = 8;        // consultas por sincronia
const CLOCK_RESYNC_MS = 10 * 60000;

// Acelerômetro (tablet preso às costas, no colete)
const STILL_STD = 0.6;          // m/s². Balanço abaixo disso = sem movimento
const MOVE_STD = 1.0;           // m/s². Acima disso volta a contar como movimento (histerese)
const STILL_CONFIRM_MS = 1500;  // tempo sem balanço para declarar parado
const STEP_MIN_ACC = 1.2;       // m/s². Pico mínimo para contar um passo
const STEP_MIN_MS = 250;        // intervalo mínimo entre passos (240 passos/min)
const STEP_MAX_MS = 1500;       // sem passo há mais que isso = cadência inválida
const CADENCE_N = 8;            // intervalos usados na mediana da cadência
const STRIDE_MIN_UPDATES = 10;  // leituras de GPS com cadência antes de confiar na passada
const STEP_FILL_MS = 60000;     // sem GPS, com passos, segura o pace por até isso

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
let paceBucket = null;    // degrau do pace na tela, em s/km; null = sem pace
let paceShownAt = 0;      // quando o número na tela foi trocado pela última vez
let paceSource = "-";     // de onde veio o pace na tela (diagnóstico)
let useSensors = true;    // menu de diagnóstico: GPS + sensores ou só GPS (original)
let vinhetaOn = true;     // menu de diagnóstico: vinheta no standby
let idle = false;         // vinheta tocando
let idleBySensor = false; // entrou com o acelerômetro parado: sai quando ele voltar a mexer
let blankSince = null;    // desde quando a tela mostra "--:--"
let videoDrift = null;    // s, posição do vídeo menos a posição pelo relógio (diagnóstico)
// Diferença entre o relógio do servidor e o do tablet. Sem sincronia, usa o do tablet.
const clock = { offset: 0, error: null, at: 0 };
const stats = {};
const motion = {};

function resetMotion() {
  Object.assign(motion, {
    events: 0, mean: null, lp: null, variance: 0, std: 0, t: 0,
    still: false, quietSince: null, armed: false, lastStep: 0, intervals: [],
    stride: null, strideUpdates: 0,
  });
}
resetMotion();

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

// ---------- Acelerômetro ----------

// Usa o módulo da aceleração: não depende de como o tablet está virado no colete.
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const t = e.timeStamp;
  const mag = Math.hypot(a.x, a.y, a.z);
  motion.events++;
  if (motion.mean == null) {
    Object.assign(motion, { mean: mag, lp: mag, t });
    return;
  }
  const dt = Math.min(Math.max((t - motion.t) / 1000, 0.001), 0.2);
  motion.t = t;
  motion.mean += smoothingFactor(dt, 0.5) * (mag - motion.mean);  // gravidade + desvio lento
  motion.lp += smoothingFactor(dt, 5) * (mag - motion.lp);        // tira tremida fina
  const y = motion.lp - motion.mean;
  motion.variance += smoothingFactor(dt, 0.5) * (y * y - motion.variance);
  motion.std = Math.sqrt(motion.variance);

  // Parado: balanço baixo por STILL_CONFIRM_MS. Volta a mover só acima de MOVE_STD.
  if (motion.std < STILL_STD) {
    motion.quietSince ??= t;
    if (t - motion.quietSince >= STILL_CONFIRM_MS) motion.still = true;
  } else {
    motion.quietSince = null;
    if (motion.std > MOVE_STD) motion.still = false;
  }

  // Passo: pico acima do limite depois de passar pelo zero
  if (y < 0) motion.armed = true;
  if (motion.armed && y > Math.max(STEP_MIN_ACC, 0.6 * motion.std) && t - motion.lastStep > STEP_MIN_MS) {
    const interval = t - motion.lastStep;
    if (motion.lastStep && interval < STEP_MAX_MS) {
      motion.intervals.push(interval);
      if (motion.intervals.length > CADENCE_N) motion.intervals.shift();
    }
    motion.lastStep = t;
    motion.armed = false;
  }
}

function motionActive() {
  return motion.events > 0 && performance.now() - motion.t < 1000;
}

// Passos por minuto, ou null se não está dando passos agora
function cadence() {
  if (!motionActive() || motion.still) return null;
  if (performance.now() - motion.lastStep > STEP_MAX_MS || motion.intervals.length < 4) return null;
  return 60000 / median(motion.intervals);
}

// Velocidade estimada pelos passos (m/s), ou null se ainda não aprendeu a passada
function stepSpeed() {
  const c = cadence();
  if (c == null || motion.strideUpdates < STRIDE_MIN_UPDATES) return null;
  return (c / 60) * motion.stride;
}

// Aprende a passada enquanto o GPS está bom. Média móvel lenta, limitada a valores plausíveis.
function learnStride(speed) {
  const c = cadence();
  if (c == null || speed == null) return;
  const stride = (speed * 60) / c;
  if (stride < 0.4 || stride > 2.2) return;
  motion.stride = motion.stride == null ? stride : motion.stride + 0.1 * (stride - motion.stride);
  motion.strideUpdates++;
}

function sensorStill() {
  return useSensors && motionActive() && motion.still;
}

// ---------- GPS ----------

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

  if (nowStopped || med < STOP_SPEED_MS || sensorStill()) {
    stopped = true;
    currentSpeed = null;
    euro = null; // ao voltar a correr, o filtro começa do ritmo novo, sem rampa desde zero
    return;
  }

  stopped = false;
  currentSpeed = euroFilter(med, fix.t);
  totalDistance += segment;
  learnStride(currentSpeed);
}

function onPositionError(err) {
  stats.lastError = `${err.code}: ${err.message}`;
  if (err.code === err.PERMISSION_DENIED) {
    stopRun();
    $("start-msg").textContent = "Sem permissão de localização. Libere nas configurações do navegador e tente de novo.";
  }
}

// ---------- Relógio ----------

// O servidor só informa o segundo cheio. Cada consulta diz que, entre o envio e a resposta,
// o relógio dele estava naquele segundo: isso limita a diferença a uma faixa. As próximas
// consultas são marcadas para a virada de segundo cair no meio delas, e a faixa vai
// encolhendo até perto do tempo de ida e volta da rede. Mesma fonte em todos os tablets.
async function clockSample() {
  const t0 = Date.now();
  const text = await (await fetch(CLOCK_URL, { cache: "no-store" })).text();
  const t1 = Date.now();
  const ts = Number(/^ts=([\d.]+)$/m.exec(text)?.[1]);
  if (!ts) throw new Error("resposta sem ts");
  const s = Math.floor(ts) * 1000;
  return { lo: s - t1, hi: s + 1000 - t0, rtt: t1 - t0 };
}

async function syncClock() {
  try {
    let lo = -Infinity, hi = Infinity, rtt = 200;
    for (let i = 0; i < CLOCK_SAMPLES; i++) {
      if (i > 0) {
        const mid = (lo + hi) / 2;
        const now = Date.now();
        let wait = Math.ceil((now + mid) / 1000) * 1000 - mid - now - rtt / 2;
        if (wait < 0) wait += 1000;
        await new Promise((r) => setTimeout(r, wait));
      }
      const s = await clockSample();
      rtt = s.rtt;
      if (s.lo > hi || s.hi < lo) { lo = s.lo; hi = s.hi; }  // não bate com as anteriores: recomeça
      else { lo = Math.max(lo, s.lo); hi = Math.min(hi, s.hi); }
    }
    Object.assign(clock, { offset: (lo + hi) / 2, error: (hi - lo) / 2, at: Date.now() });
  } catch { /* sem rede: segue com a última sincronia, ou com o relógio do tablet */ }
}

function syncedNow() {
  return Date.now() + clock.offset;
}

// ---------- Vinheta ----------

const video = $("vinheta");

// Carrega o vídeo inteiro na memória (vem do cache do app): pula para qualquer ponto sem rede
async function loadVinheta() {
  try {
    const r = await fetch("assets/vinheta.mp4");
    if (r.ok) video.src = URL.createObjectURL(await r.blob());
  } catch { /* sem vídeo: o standby não entra */ }
}

function videoReady() {
  return video.duration > 0 && Number.isFinite(video.duration);
}

// Onde o vídeo deveria estar agora: o ciclo começa em todo múltiplo da duração desde 1970,
// então com 10 s de vídeo começa em x:00, x:10, x:20… em todos os tablets
function videoTarget() {
  const d = video.duration * 1000;
  return (((syncedNow() % d) + d) % d) / 1000;
}

function setIdle(on) {
  idle = on;
  idleBySensor = on && sensorStill();
  video.classList.toggle("hidden", !on);
  if (on) {
    video.playbackRate = 1;
    video.currentTime = (videoTarget() + VIDEO_SEEK_LEAD_S) % video.duration;
    video.play().catch(() => {});
  } else {
    video.pause();
    blankSince = null; // depois de sair, conta os 20 s de novo
    videoDrift = null;
  }
}

function updateIdle() {
  const blank = lastShownPace === "--:--";
  if (!blank) blankSince = null;
  else blankSince ??= Date.now();
  if (idle) {
    if (!blank || !vinhetaOn || (idleBySensor && !sensorStill())) setIdle(false);
  } else if (vinhetaOn && videoReady() && blank && Date.now() - blankSince >= IDLE_AFTER_MS) {
    setIdle(true);
  }
}

// Desvio pequeno: acelera ou freia até 5%, sem o olho perceber. Grande: pula.
function syncVideo() {
  if (!idle || !videoReady()) return;
  const d = video.duration;
  let drift = video.currentTime - videoTarget();
  if (drift > d / 2) drift -= d;
  else if (drift < -d / 2) drift += d;
  videoDrift = drift;
  if (Math.abs(drift) > VIDEO_SEEK_S) {
    video.playbackRate = 1;
    video.currentTime = (videoTarget() + VIDEO_SEEK_LEAD_S) % d;
  } else {
    video.playbackRate = Math.abs(drift) < 0.02 ? 1 : Math.min(1.05, Math.max(0.95, 1 - drift / 2));
  }
}

// ---------- Tela ----------

// O filtro segue com toda a precisão; o arredondamento é só na tela.
// Degrau atual vale enquanto o pace real estiver a até 2,5 + 2 s dele (ex.: 5:10 de 5:06 a 5:14).
// Parada zera o degrau, então a volta a correr aparece direto no degrau certo.
function formatPace(speed) {
  if (speed == null || speed < STOP_SPEED_MS) {
    paceBucket = null;
    return "--:--";
  }
  const raw = 1000 / speed;
  if (paceBucket == null || Math.abs(raw - paceBucket) > PACE_STEP_S / 2 + PACE_HYST_S) {
    paceBucket = Math.round(raw / PACE_STEP_S) * PACE_STEP_S;
  }
  const secPerKm = paceBucket;
  const m = Math.floor(secPerKm / 60);
  const s = String(secPerKm % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// Pace correndo troca no máximo a cada PACE_REFRESH_MS. Entrar ou sair de "--:--" é na hora.
function showPace(pace) {
  const now = Date.now();
  if (pace === "--:--" || lastShownPace === "--:--" || now - paceShownAt >= PACE_REFRESH_MS) {
    lastShownPace = pace;
    paceShownAt = now;
  }
}

function render() {
  const sinceGood = Date.now() - stats.lastAcceptedAt;
  const signalOk = !!lastAccepted && sinceGood <= SIGNAL_GAP_MS;
  const lost = !!lastAccepted && sinceGood > HOLD_MS;

  // A retenção vale só para falha de sinal. Parada real aparece na hora.
  // Com sensores: acelerômetro parado zera na hora; sem GPS, enquanto há passos,
  // segura o último pace por até STEP_FILL_MS em vez de só HOLD_MS.
  const stepping = useSensors && cadence() != null;
  let holding = false;
  if (lastAccepted && sensorStill()) {
    showPace(formatPace(null));
    paceSource = "parado (acelerômetro)";
  } else if (signalOk) {
    showPace(formatPace(currentSpeed));
    paceSource = "gps";
  } else if (lastAccepted && stepping && sinceGood <= STEP_FILL_MS) {
    holding = true;
    paceSource = "segurando (passos)";
  } else if (!lastAccepted || lost) {
    showPace(formatPace(null));
    paceSource = "-";
  } else {
    holding = true;
    paceSource = "segurando";
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
    $("diag-text").textContent = [
      `leituras:         ${stats.total}`,
      `rejeitadas acc:   ${stats.rejectedAcc}`,
      `rejeitadas salto: ${stats.rejectedJump}`,
      `precisão (m):     ${stats.lastAcc == null ? "—" : stats.lastAcc.toFixed(1)}`,
      `fonte:            ${stats.source}`,
      `amostra km/h:     ${kmh(stats.lastSample)}`,
      `mediana km/h:     ${kmh(stats.median)}`,
      `filtrada km/h:    ${kmh(currentSpeed)}`,
      `pace exato:       ${currentSpeed == null ? "—" : (1000 / currentSpeed).toFixed(1) + " s/km"}`,
      `parado:           ${stopped ? "sim" : "não"}`,
      `pace na tela:     ${paceSource}`,
      `acelerômetro:     ${motionActive() ? "ativo" : "sem dados"}`,
      `balanço m/s²:     ${motionActive() ? motion.std.toFixed(2) : "—"}${motion.still ? " (parado)" : ""}`,
      `cadência ppm:     ${cadence() == null ? "—" : cadence().toFixed(0)}`,
      `passada m:        ${motion.stride == null ? "—" : `${motion.stride.toFixed(2)} (${motion.strideUpdates})`}`,
      `km/h pelos passos: ${kmh(stepSpeed())}`,
      `última leitura:   ${stats.lastFixAt ? ((Date.now() - stats.lastFixAt) / 1000).toFixed(0) + " s atrás" : "—"}`,
      `wake lock:        ${wakeLock ? "ativo" : "inativo"}`,
      `relógio:          ${clock.at ? `${(clock.offset / 1000).toFixed(2)} s ±${(clock.error / 1000).toFixed(2)} (servidor)` : "do tablet (sem sincronia)"}`,
      `vinheta:          ${!vinhetaOn ? "desligada" : !videoReady() ? "sem vídeo" : idle ? "tocando" : blankSince ? `em ${Math.max(0, Math.ceil((IDLE_AFTER_MS - (Date.now() - blankSince)) / 1000))} s` : "aguardando parada"}`,
      `vinheta desvio:   ${videoDrift == null ? "—" : `${(videoDrift * 1000).toFixed(0)} ms`}`,
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
  // iPhone/iPad pedem permissão para o acelerômetro; no Android não precisa
  try {
    if (typeof DeviceMotionEvent?.requestPermission === "function") await DeviceMotionEvent.requestPermission();
  } catch { /* sem permissão: segue só com GPS */ }
  try {
    await document.documentElement.requestFullscreen();
    await screen.orientation.lock("portrait");
  } catch { /* celular ou navegador sem suporte: segue sem travar */ }
  requestWakeLock();

  lastAccepted = null;
  samples = [];
  stopped = true;
  euro = null;
  totalDistance = 0;
  currentSpeed = null;
  lastShownPace = "--:--";
  paceBucket = null;
  paceShownAt = 0;
  paceSource = "-";
  blankSince = null;
  if (Date.now() - clock.at > CLOCK_RESYNC_MS) syncClock();
  resetStats();
  resetMotion();
  window.addEventListener("devicemotion", onMotion);

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
  window.removeEventListener("devicemotion", onMotion);
  if (idle) setIdle(false);
  if (wakeLock) wakeLock.release();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  $("run").classList.add("hidden");
  $("start").classList.remove("hidden");
}

$("btn-start").addEventListener("click", startRun);
setInterval(() => { if (watchId != null) render(); }, 1000);
// Vinheta fora do render, mais rápido: sai no primeiro movimento e mantém o vídeo no ponto
setInterval(() => {
  if (watchId == null) return;
  updateIdle();
  syncVideo();
}, VIDEO_SYNC_MS);
setInterval(() => { if (watchId != null) syncClock(); }, CLOCK_RESYNC_MS);
loadVinheta();

// Relógio do menu de diagnóstico, na hora sincronizada: lado a lado, os tablets devem virar o segundo juntos
function renderClock() {
  const d = new Date(syncedNow());
  const p = (n) => String(n).padStart(2, "0");
  $("diag-clock").textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}
setInterval(() => { if (watchId != null && !$("diag").classList.contains("hidden")) renderClock(); }, 50);
syncClock();

// Opções do menu de diagnóstico. A escolha fica salva neste aparelho.
// Padrão: brilho desligado e vermelho cru de display.
// Chaves "glow2"/"red" novas: a antiga "glow" ficou salva como ligada em todo aparelho que abriu o app.
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* sem storage: vale só nesta sessão */ }
}
function loadPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function setGlow(on) {
  document.body.classList.toggle("no-glow", !on);
  $("btn-glow").textContent = `brilho: ${on ? "ligado" : "desligado"}`;
  savePref("glow2", on ? "1" : "0");
}
function setBrandRed(on) {
  document.body.classList.toggle("brand-red", on);
  $("btn-red").textContent = `vermelho: ${on ? "marca" : "display"}`;
  savePref("red", on ? "brand" : "display");
}
function setSensors(on) {
  useSensors = on;
  $("btn-measure").textContent = `medição: ${on ? "GPS + sensores" : "só GPS (original)"}`;
  savePref("measure", on ? "sensors" : "gps");
}
setGlow(loadPref("glow2", "0") === "1");
setBrandRed(loadPref("red", "display") === "brand");
function setVinheta(on) {
  vinhetaOn = on;
  $("btn-vinheta").textContent = `vinheta: ${on ? "ligada" : "desligada"}`;
  savePref("vinheta", on ? "1" : "0");
  if (!on && idle) setIdle(false);
}
setSensors(loadPref("measure", "sensors") === "sensors");
setVinheta(loadPref("vinheta", "1") === "1");

// Toques nos botões não contam como toque duplo nem toque longo da tela
for (const id of ["btn-glow", "btn-red", "btn-measure", "btn-vinheta"]) {
  $(id).addEventListener("pointerdown", (e) => e.stopPropagation());
  $(id).addEventListener("pointerup", (e) => e.stopPropagation());
}
$("btn-glow").addEventListener("click", () => setGlow(document.body.classList.contains("no-glow")));
$("btn-red").addEventListener("click", () => setBrandRed(!document.body.classList.contains("brand-red")));
$("btn-measure").addEventListener("click", () => { setSensors(!useSensors); render(); });
$("btn-vinheta").addEventListener("click", () => { setVinheta(!vinhetaOn); render(); });

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

$("version").textContent = APP_VERSION;

// Quando uma versão nova termina de instalar, recarrega sozinho, mas só na tela inicial.
// Nunca recarrega no meio de uma medição.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || watchId != null) return;
    reloading = true;
    location.reload();
  });
}
