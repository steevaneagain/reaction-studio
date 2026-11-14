'use strict';
/* Reaction Studio — runs entirely on your phone.
   1. Get a video: Share → "Reaction Studio" shortcut (a-Shell downloads it into Photos), then pick it here.
   2. Record like the Instagram camera: tap/hold for clips; the reacted video pauses between clips.
      When the reacted video ends it disappears and your camera grows to full screen.
   3. Edit on a timeline: reorder, trim each clip, retake a clip in place, cut silence, captions.
   4. Save: the phone plays the timeline back and records it into one video (with captions burned in). */

const $ = id => document.getElementById(id);
const W = 1080, H = 1920;
const SHORTCUT_NAME = 'Reaction Studio';

const el = {};
for (const id of [
  'loadScreen', 'studio', 'review', 'resumeBtn', 'resumeInfo', 'linkForm', 'linkInput', 'pasteBtn', 'getBtn',
  'gotPanel', 'pickLabel', 'pickText', 'fileInput', 'myVideosBtn', 'setupBtn', 'loadStatus',
  'stage', 'hint', 'segBar', 'retakeBar', 'retakeName', 'retakeLen', 'retakeCancel', 'recTimer', 'recTime',
  'backBtn', 'trimSrcBtn', 'edgeBtn', 'layoutBtn', 'swapBtn', 'sizeBtn', 'fitBtn', 'flipBtn',
  'restartBtn', 'seek', 'curTime', 'durTime', 'vol', 'volPct',
  'undoBtn', 'playBtn', 'recBtn', 'clipsBtn', 'lastClipThumb', 'clipCount', 'nextBtn',
  'reviewBack', 'totalLen', 'saveFinal', 'previewBox', 'reviewVideo', 'capCanvas', 'reviewPlay',
  'playAll', 'tlTime', 'tlTotal', 'tlScrub', 'tlInner', 'zoomIn', 'zoomOut', 'undoEd', 'redoEd', 'captionsBtn', 'autoCutBtn', 'timeline', 'tlClips', 'tlPlayhead', 'tlTip',
  'clipPanel', 'cpTitle', 'cpLeft', 'cpRight', 'cpRetake', 'cpDelete', 'cpDone',
  'trimTrack', 'shadeL', 'shadeR', 'trimSel', 'playhead', 'tIn', 'tLen', 'tOut',
  'sheetBackdrop', 'sheet', 'sheetTitle', 'closeSheet', 'sheetBody',
  'player', 'playerVideo', 'savePlayer', 'newReaction', 'closePlayer',
  'renderOverlay', 'renderBar', 'renderText', 'renderCancel',
  'toast', 'busy', 'busyText',
  'srcVideo', 'camVideo', 'workVideo', 'renderCanvas',
  'ovAddBtn', 'ovInput', 'ovLane', 'ovPanel', 'ovTitle', 'ovSound', 'ovFront', 'ovDelete', 'ovDone', 'ovSize',
]) el[id] = $(id);
el.src = el.srcVideo; el.cam = el.camVideo;
const g = el.stage.getContext('2d');
const capG = el.capCanvas.getContext('2d');

const SIZES = [{ k: 'S', w: 0.30 }, { k: 'M', w: 0.38 }, { k: 'L', w: 0.50 }];
const state = {
  layout: load('layout', 'bubble'),
  swap: load('swap', false),
  bubbleW: load('bubbleW', 0.38), // bubble width (0..1 of the frame), pinch to change smoothly
  fit: load('fit', 'contain'),
  bubble: load('bubble', { x: 0.76, y: 0.2 }),
  vid: load('vid', { scale: 1, x: 0.5, y: 0.5, edge: 'none' }), // the reacted video: size, position, edges
  facing: 'user',
  source: null,          // { blob, name }
  srcURL: null,
  camStream: null,
  recording: false, recStart: 0, curClip: null,
  clips: [],
  resumeOnRec: false,
  undoArmed: false,
  goneT: 0,
  retake: null,
  cap: { on: false, style: 'pop', y: 0.74, hi: null },
  overlays: [],
  srcIn: 0, srcOut: null,  // trim of the reacted video (seconds); null = to the end
  srcStrip: null,
};

function load(k, d) { try { const v = localStorage.getItem('rs.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
function save(k, v) { try { localStorage.setItem('rs.' + k, JSON.stringify(v)); } catch {} }

// ---------------- helpers ----------------
let toastTimer;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}
function busy(on, text = 'Working…') { el.busy.hidden = !on; el.busyText.textContent = text; }
function status(msg, err = false) { el.loadStatus.textContent = msg; el.loadStatus.classList.toggle('err', err); }
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const fmt1 = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0'); };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const once = (target, ev) => new Promise(res => target.addEventListener(ev, res, { once: true }));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function show(screen) {
  for (const [name, node] of [['load', el.loadScreen], ['studio', el.studio], ['review', el.review]]) {
    node.classList.toggle('active', screen === name);
  }
  if (screen === 'studio') { fitStage(); requestWakeLock(); }
  if (screen === 'review') requestWakeLock();
}

// ---------------- saving the session on the phone ----------------
// Clip videos are stored once each (key "clip:<id>"); the small "session" record holds the rest.
const clipMeta = c => ({
  id: c.id, ext: c.ext, duration: c.duration, in: c.in, out: c.out, userTrimmed: c.userTrimmed,
  srcStart: c.srcStart, srcEnd: c.srcEnd, srcWasPlaying: c.srcWasPlaying,
  speechStart: c.speechStart, speechEnd: c.speechEnd, strip: c.strip, thumb: c.thumb, captions: c.captions || null,
});
let saveTimer;
function saveSession(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => Store.set('session', {
    clips: state.clips.map(clipMeta),
    cap: state.cap,
    overlays: state.overlays.map(ovMeta),
    srcIn: state.srcIn, srcOut: state.srcOut,
    srcTime: el.src.currentTime || 0,
    resumeOnRec: state.resumeOnRec,
    updated: Date.now(),
  }).catch(e => console.warn('save failed', e));
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 600);
}
async function clearSession() {
  // every stored clip and overlay goes, including ones kept around for Undo
  for (const k of await Store.keys().catch(() => [])) if (/^(clip|ov):/.test(k)) await Store.del(k).catch(() => {});
  await Store.del('session').catch(() => {});
  await Store.del('source').catch(() => {});
}

// Clips/overlays deleted in an earlier visit were kept only for Undo: clear them out on start.
async function tidyStorage(s) {
  const keep = new Set([...((s && s.clips) || []).map(c => 'clip:' + c.id), ...((s && s.overlays) || []).map(o => 'ov:' + o.id)]);
  for (const k of await Store.keys().catch(() => [])) if (/^(clip|ov):/.test(k) && !keep.has(k)) await Store.del(k).catch(() => {});
}
async function checkResume() {
  try {
    const s = await Store.get('session');
    const src = await Store.get('source');
    if (!checkResume.tidied) { checkResume.tidied = true; tidyStorage(s); }
    if (s && src && s.clips && s.clips.length) {
      el.resumeBtn.hidden = false;
      el.resumeInfo.textContent = `${s.clips.length} clip${s.clips.length > 1 ? 's' : ''} · ${new Date(s.updated).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
    } else if (src && s) {
      el.resumeBtn.hidden = false;
      el.resumeInfo.textContent = 'Video loaded, no clips yet';
    }
  } catch {}
}
el.resumeBtn.onclick = async () => {
  ensureAudio();
  busy(true, 'Opening your reaction…');
  try {
    const s = await Store.get('session');
    const src = await Store.get('source');
    state.source = src;
    await setSource(URL.createObjectURL(src.blob));
    await restoreOverlays(s.overlays);
    state.cap = { ...state.cap, ...(s.cap || {}) };
    state.srcIn = s.srcIn || 0;
    state.srcOut = s.srcOut ?? null;
    state.clips = [];
    for (const m of s.clips) {
      const data = await Store.get('clip:' + m.id);
      if (!data) continue;
      state.clips.push({ ...m, blob: data.blob, micBlob: data.micBlob, url: URL.createObjectURL(data.blob) });
    }
    el.src.currentTime = s.srcTime || 0;
    state.resumeOnRec = !!s.resumeOnRec;
    renderClips();
    busy(false);
    if (state.clips.length) openEditor(); else enterStudio();
  } catch (e) {
    busy(false);
    toast('Couldn\'t open it: ' + e.message, 5000);
  }
};

// ---------------- audio graph ----------------
// mic ─────────────────────┐
//                          ├─> recDest (goes into the recording)
// video ─> videoGain ──────┘ └─> speakers
let ac, recDest, videoGain, micNode, micAnalyser, micBuf;
function ensureAudio() {
  if (!ac) {
    try {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      recDest = ac.createMediaStreamDestination();
      videoGain = ac.createGain();
      videoGain.gain.value = el.vol.value / 100;
      videoGain.connect(recDest);
      videoGain.connect(ac.destination);
      ac.createMediaElementSource(el.src).connect(videoGain);
      el.src.volume = 1;
      connectMic();
    } catch (e) {
      console.warn('Audio setup failed', e);
      ac = null;
    }
  }
  if (ac && ac.state !== 'running') ac.resume().catch(() => {});
}
function connectMic() {
  if (!ac || !state.camStream) return;
  if (micNode) { try { micNode.disconnect(); } catch {} }
  const tracks = state.camStream.getAudioTracks();
  if (!tracks.length) return;
  micNode = ac.createMediaStreamSource(new MediaStream(tracks));
  micNode.connect(recDest);
  micAnalyser = ac.createAnalyser();
  micAnalyser.fftSize = 1024;
  micNode.connect(micAnalyser);
}

// Where you start/stop talking in each clip (mic only), for "Cut silence".
const SPEECH_RMS = 0.015; // fairly quiet talking still counts
let loudFrames = 0;
function listenForSpeech(t) {
  const c = state.curClip;
  if (!micAnalyser || !c) return;
  if (!micBuf) micBuf = new Float32Array(micAnalyser.fftSize);
  micAnalyser.getFloatTimeDomainData(micBuf);
  let sum = 0;
  for (let i = 0; i < micBuf.length; i++) sum += micBuf[i] * micBuf[i];
  const rms = Math.sqrt(sum / micBuf.length);
  loudFrames = rms > SPEECH_RMS ? loudFrames + 1 : 0;
  if (loudFrames >= 2) {
    if (c.speechStart == null) c.speechStart = Math.max(0, t - 0.1);
    c.speechEnd = t;
  }
}

// ---------------- camera ----------------
async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    toast('The camera needs the https:// address of the app.', 6000);
    return;
  }
  if (state.camStream) state.camStream.getTracks().forEach(t => t.stop());
  try {
    state.camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    console.error(e);
    toast(e.name === 'NotAllowedError' ? 'Allow camera + microphone to record.' : 'Camera error: ' + e.message, 6000);
    return;
  }
  el.cam.srcObject = new MediaStream(state.camStream.getVideoTracks());
  el.cam.play().catch(() => {});
  connectMic();
}

// ---------------- home: getting a video ----------------
el.pasteBtn.onclick = async () => {
  try { el.linkInput.value = (await navigator.clipboard.readText()).trim(); }
  catch { el.linkInput.focus(); toast('Long-press the box and choose Paste'); }
};

// "Get video" hands the link to the iPhone Shortcut, which downloads it with a-Shell into Photos.
el.linkForm.onsubmit = e => {
  e.preventDefault();
  const url = el.linkInput.value.trim();
  if (!/^https?:\/\//i.test(url)) { el.linkInput.focus(); toast('Paste a link first'); return; }
  if (!load('setupDone', false)) { openSetup(true); return; }
  status('Downloading in the Shortcut… come back here when it finishes.');
  location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(SHORTCUT_NAME) + '&input=text&text=' + encodeURIComponent(url);
};

el.fileInput.onchange = async () => {
  const f = el.fileInput.files[0];
  if (!f) return;
  ensureAudio();
  el.fileInput.value = '';
  // A new video = a new reaction. Keep the old one only if it has no clips.
  if (state.clips.length && !confirm('Start a new reaction? Your current clips will be cleared.')) return;
  resetSession();
  await clearSession();
  state.source = { blob: f, name: f.name };
  Store.set('source', state.source).catch(() => toast('Couldn\'t save the video on this phone — it still works for now.'));
  Store.persist();
  await setSource(URL.createObjectURL(f));
  saveSession(true);
  el.gotPanel.hidden = true;
  el.pickLabel.classList.remove('big');
  el.pickText.textContent = 'Pick a video from my phone';
  enterStudio();
};

// Coming back from the Shortcut: ?got=1
(function handleReturn() {
  const p = new URLSearchParams(location.search);
  if (p.has('got')) {
    el.gotPanel.hidden = false;
    el.pickLabel.classList.add('big');
    el.pickText.textContent = 'Tap to choose your video';
    history.replaceState(null, '', location.pathname);
  }
})();

function enterStudio() {
  state.goneT = srcDone() ? 1 : 0;
  show('studio');
  if (!state.camStream) startCamera();
}

function setSource(url) {
  if (state.srcURL) URL.revokeObjectURL(state.srcURL);
  state.srcURL = url;
  el.src.src = url;
  el.src.load();
  return new Promise(res => {
    let finished = false;
    const done = () => {
      if (finished) return; finished = true;
      el.src.removeEventListener('loadeddata', done); el.src.removeEventListener('error', fail);
      updateTimes(); res();
    };
    const fail = () => { toast('This phone can\'t play that video file.'); done(); };
    el.src.addEventListener('loadeddata', done);
    el.src.addEventListener('error', fail);
    setTimeout(done, 8000);
  });
}

// ---------------- drawing the recording screen ----------------
function fitStage() {
  const wrap = el.stage.parentElement;
  const aw = wrap.clientWidth, ah = wrap.clientHeight;
  if (!aw || !ah) return;
  let h = ah, w = h * 9 / 16;
  if (w > aw) { w = aw; h = w * 16 / 9; }
  el.stage.style.width = w + 'px';
  el.stage.style.height = h + 'px';
}
addEventListener('resize', fitStage);

function drawMedia(m, x, y, w, h, mode, mirror) {
  const mw = m.videoWidth, mh = m.videoHeight;
  if (!mw || !mh || m.readyState < 2) return false;
  const s = mode === 'cover' ? Math.max(w / mw, h / mh) : Math.min(w / mw, h / mh);
  const dw = mw * s, dh = mh * s;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  if (mirror) { g.translate(x + w / 2, 0); g.scale(-1, 1); g.translate(-(x + w / 2), 0); }
  g.drawImage(m, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  g.restore();
  return true;
}
function roundRectPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function bubbleRect() {
  const bw = W * state.bubbleW;
  const bh = bw * (state.swap ? 16 / 9 : 4 / 3);
  const cx = clamp(state.bubble.x * W, bw / 2 + 24, W - bw / 2 - 24);
  const cy = clamp(state.bubble.y * H, bh / 2 + 24, H - bh / 2 - 24);
  return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
}
function placeholder(x, y, w, h, text) {
  g.fillStyle = '#16161a'; g.fillRect(x, y, w, h);
  g.fillStyle = '#666'; g.font = '600 44px -apple-system, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, x + w / 2, y + h / 2);
}
const drawVid = (r, small) => drawMedia(el.src, r.x, r.y, r.w, r.h, small ? 'cover' : state.fit, false) || placeholder(r.x, r.y, r.w, r.h, 'Video');
const drawCam = r => drawMedia(el.cam, r.x, r.y, r.w, r.h, 'cover', state.facing === 'user') || placeholder(r.x, r.y, r.w, r.h, 'Camera');
const FULL = { x: 0, y: 0, w: W, h: H };

// ----- the big reacted video: size/position (pinch, drag) + faded or blurred edges -----
const featherCv = document.createElement('canvas'); featherCv.width = W; featherCv.height = H;
const featherG = featherCv.getContext('2d');
let maskCv = null, maskKey = '';

function vidRect() {
  const m = el.src;
  const mw = m.videoWidth || 9, mh = m.videoHeight || 16;
  const s0 = state.fit === 'cover' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
  const w = mw * s0 * state.vid.scale, h = mh * s0 * state.vid.scale;
  return { x: state.vid.x * W - w / 2, y: state.vid.y * H - h / 2, w, h };
}
// A soft-edged white rectangle (made with a blurred shadow), used to fade the video's edges.
function featherMask(r, f) {
  const key = [r.x, r.y, r.w, r.h, f].map(Math.round).join(',');
  if (key === maskKey) return maskCv;
  maskCv = maskCv || document.createElement('canvas');
  maskCv.width = W; maskCv.height = H;
  const mg = maskCv.getContext('2d');
  mg.clearRect(0, 0, W, H);
  mg.save();
  mg.shadowColor = '#fff'; mg.shadowBlur = f; mg.shadowOffsetX = W * 3;
  mg.fillStyle = '#fff';
  mg.fillRect(r.x + f * 0.7 - W * 3, r.y + f * 0.7, Math.max(1, r.w - f * 1.4), Math.max(1, r.h - f * 1.4));
  mg.restore();
  maskKey = key;
  return maskCv;
}
// Blur by halving the picture a few times and growing it back step by step
// (each step softens it a little) — smooth, fast, and works on every phone.
const BLUR_STEPS = [[270, 480], [135, 240], [68, 120], [34, 60], [17, 30]].map(([w, h]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
});
function drawBlurBackground(m) {
  const mw = m.videoWidth, mh = m.videoHeight;
  const [w0, h0] = [BLUR_STEPS[0].width, BLUR_STEPS[0].height];
  const s = Math.max(w0 / mw, h0 / mh);
  const c0 = BLUR_STEPS[0].getContext('2d');
  c0.drawImage(m, (w0 - mw * s) / 2, (h0 - mh * s) / 2, mw * s, mh * s); // cover-fill
  for (let i = 1; i < BLUR_STEPS.length; i++) {
    BLUR_STEPS[i].getContext('2d').drawImage(BLUR_STEPS[i - 1], 0, 0, BLUR_STEPS[i].width, BLUR_STEPS[i].height);
  }
  for (let i = BLUR_STEPS.length - 2; i >= 0; i--) {
    BLUR_STEPS[i].getContext('2d').drawImage(BLUR_STEPS[i + 1], 0, 0, BLUR_STEPS[i].width, BLUR_STEPS[i].height);
  }
  g.save();
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(BLUR_STEPS[0], 0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  g.fillRect(0, 0, W, H);
  g.restore();
}
function drawMainVideo() {
  const m = el.src;
  if (!m.videoWidth || m.readyState < 2) { placeholder(0, 0, W, H, 'Video'); return; }
  const r = vidRect();
  const edge = state.vid.edge;
  if (edge === 'blur') drawBlurBackground(m);
  if (edge === 'none') { g.drawImage(m, r.x, r.y, r.w, r.h); return; }
  const f = Math.min(r.w, r.h) * 0.14;
  featherG.globalCompositeOperation = 'source-over';
  featherG.clearRect(0, 0, W, H);
  featherG.drawImage(m, r.x, r.y, r.w, r.h);
  featherG.globalCompositeOperation = 'destination-in';
  featherG.drawImage(featherMask(r, f), 0, 0);
  featherG.globalCompositeOperation = 'source-over';
  g.drawImage(featherCv, 0, 0);
}
const lerpRect = (a, b, t) => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

function drawBubbleFrame(r, radius, alpha, inside) {
  g.save();
  g.globalAlpha = alpha;
  g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 40; g.shadowOffsetY = 10;
  roundRectPath(r.x, r.y, r.w, r.h, radius); g.fillStyle = '#000'; g.fill();
  g.restore();
  g.save();
  g.globalAlpha = alpha;
  roundRectPath(r.x, r.y, r.w, r.h, radius); g.clip();
  inside(r);
  g.restore();
}
function strokeBubble(r, radius, alpha) {
  if (alpha <= 0.01) return;
  g.save();
  g.globalAlpha = alpha;
  roundRectPath(r.x, r.y, r.w, r.h, radius); g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,.9)'; g.stroke();
  g.restore();
}

function draw() {
  const t = ease(state.goneT); // 0 normal → 1 reacted video gone, camera full screen
  g.globalAlpha = 1;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  if (state.layout === 'split') {
    const top = { x: 0, y: 0, w: W, h: H / 2 }, bottom = { x: 0, y: H / 2, w: W, h: H / 2 };
    const vidR = state.swap ? bottom : top, camR = state.swap ? top : bottom;
    if (t < 1) { g.save(); g.globalAlpha = 1 - t; drawVid(vidR, false); g.restore(); }
    drawCam(lerpRect(camR, FULL, t));
    if (t < 0.02) { g.fillStyle = '#000'; g.fillRect(0, H / 2 - 3, W, 6); }
    return;
  }
  const b = bubbleRect();
  if (!state.swap) {
    if (t < 1) drawMainVideo();
    const r = lerpRect(b, FULL, t);
    drawBubbleFrame(r, 44 * (1 - t), 1, drawCam);
    strokeBubble(r, 44 * (1 - t), 1 - t);
  } else {
    drawCam(FULL);
    if (t < 1) {
      const s = 1 - 0.25 * t;
      const r = { x: b.x + b.w * (1 - s) / 2, y: b.y + b.h * (1 - s) / 2, w: b.w * s, h: b.h * s };
      drawBubbleFrame(r, 44, 1 - t, rr => drawVid(rr, true));
      strokeBubble(r, 44, 1 - t);
    }
  }
}

let lastFrame = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (el.studio.classList.contains('active')) {
    watchPictureEnd(now);
    const nearEnd = !el.src.paused && el.src.duration > 0 && el.src.currentTime >= srcOut() - 0.2;
    const target = srcDone() || nearEnd ? 1 : 0;
    if (state.goneT !== target) state.goneT = clamp(state.goneT + Math.sign(target - state.goneT) * dt / 0.35, 0, 1);
    draw();
    if (!seeking) updateTimes();
    if (state.recording) {
      const clipT = (now - state.recStart) / 1000;
      if (state.retake) {
        el.recTime.textContent = clipT.toFixed(1) + 's / ' + state.retake.target.toFixed(1) + 's';
        el.recTimer.classList.toggle('over', clipT >= state.retake.target);
      } else {
        el.recTime.textContent = fmt(totalRecorded());
        renderSegBar();
      }
      listenForSpeech(clipT);
    }
  }
  if (el.review.classList.contains('active') && !rendering) editorTick();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------- source video controls ----------------
let seeking = false;
// The reacted video can be trimmed: it only plays between srcIn and srcOut.
const srcIn = () => state.srcIn || 0;
const srcOut = () => (state.srcOut != null ? Math.min(state.srcOut, el.src.duration || Infinity) : (el.src.duration || 0));
const srcDone = () => el.src.ended || (el.src.duration > 0 && el.src.currentTime >= srcOut() - 0.04) ||
  (state.picEndAt != null && el.src.currentTime >= state.picEndAt - 0.05);

// Downloaded videos often have sound that runs a few seconds past the picture.
// Watch for new picture frames: when they stop while playing, the video is over.
let lastPicFrame = 0;
function onSrcFrame(now, meta) {
  lastPicFrame = performance.now();
  if (state.picEndAt != null && meta && meta.mediaTime < state.picEndAt - 0.1) state.picEndAt = null; // seeked back
  el.src.requestVideoFrameCallback(onSrcFrame);
}
if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) el.src.requestVideoFrameCallback(onSrcFrame);
let lastSrcT = -1, lastSrcMove = 0;
function watchPictureEnd(now) {
  const v = el.src;
  if (v.paused || v.seeking || v.readyState < 2) { lastPicFrame = now; lastSrcMove = now; return; }
  if (v.currentTime !== lastSrcT) { lastSrcT = v.currentTime; lastSrcMove = now; }
  const picStopped = ('requestVideoFrameCallback' in HTMLVideoElement.prototype) && now - lastPicFrame > 300;
  const timeStuck = now - lastSrcMove > 600;
  // only near the end (sound tails are a few seconds), so a slow/still shot mid-video can't trigger it
  if ((picStopped || timeStuck) && v.currentTime > 0.5 && v.currentTime > srcOut() - 8) {
    state.picEndAt = v.currentTime;
    v.pause();
  }
}
function updateTimes() {
  const a = srcIn(), d = Math.max(0, srcOut() - a);
  const t = clamp(el.src.currentTime - a, 0, d);
  el.curTime.textContent = fmt(t);
  el.durTime.textContent = fmt(d);
  el.seek.value = d ? Math.round(t / d * 1000) : 0;
}
function togglePlay() {
  ensureAudio();
  if (el.src.paused || srcDone()) {
    const atRealEnd = el.src.ended || el.src.currentTime >= srcOut() - 0.04;
    if (atRealEnd || el.src.currentTime < srcIn()) el.src.currentTime = srcIn();
    state.picEndAt = null;
    el.src.play().catch(e => toast('Can\'t play: ' + e.message));
  } else el.src.pause();
}
// stop at the trimmed end
el.src.addEventListener('timeupdate', () => { if (!el.src.paused && state.srcOut != null && el.src.currentTime >= srcOut() - 0.02) el.src.pause(); });
const syncPlayBtn = () => el.playBtn.classList.toggle('playing', !el.src.paused && !srcDone());
['play', 'pause', 'ended'].forEach(ev => el.src.addEventListener(ev, syncPlayBtn));
el.playBtn.onclick = togglePlay;
el.restartBtn.onclick = () => { el.src.currentTime = srcIn(); state.picEndAt = null; updateTimes(); };
el.seek.addEventListener('input', () => {
  seeking = true;
  el.src.currentTime = srcIn() + el.seek.value / 1000 * (srcOut() - srcIn());
  state.picEndAt = null;
  el.curTime.textContent = fmt(el.src.currentTime - srcIn());
});
el.seek.addEventListener('change', () => { seeking = false; });
el.seek.addEventListener('pointerup', () => { seeking = false; });

function setVol(v) {
  el.vol.value = v;
  el.volPct.textContent = v + '%';
  if (videoGain) videoGain.gain.value = v / 100;
  else el.src.volume = v / 100;
  save('vol', v);
}
el.vol.addEventListener('input', () => setVol(Number(el.vol.value)));
setVol(load('vol', 80));

// ---------------- layout tools ----------------
function refreshTools() {
  el.layoutBtn.textContent = state.layout === 'bubble' ? 'Bubble' : 'Split';
  el.sizeBtn.hidden = state.layout !== 'bubble';
  el.sizeBtn.textContent = SIZES.reduce((a, b) => Math.abs(b.w - state.bubbleW) < Math.abs(a.w - state.bubbleW) ? b : a).k;
  el.fitBtn.textContent = state.fit === 'contain' ? 'Fit' : 'Fill';
  el.edgeBtn.textContent = { none: 'Edges: off', fade: 'Edges: fade', blur: 'Edges: blur' }[state.vid.edge];
}
el.layoutBtn.onclick = () => { state.layout = state.layout === 'bubble' ? 'split' : 'bubble'; save('layout', state.layout); refreshTools(); };
el.swapBtn.onclick = () => { state.swap = !state.swap; save('swap', state.swap); };
el.sizeBtn.onclick = () => { const next = SIZES.find(s => s.w > state.bubbleW + 0.01) || SIZES[0]; state.bubbleW = next.w; save('bubbleW', state.bubbleW); refreshTools(); };
el.edgeBtn.onclick = () => {
  const order = ['none', 'fade', 'blur'];
  state.vid.edge = order[(order.indexOf(state.vid.edge) + 1) % order.length];
  // a full-screen (9:16) video has no edges to show — shrink it a little so the effect is visible
  if (state.vid.edge !== 'none' && state.vid.scale > 0.95) state.vid.scale = 0.84;
  if (state.vid.edge === 'none' && state.vid.scale > 0.8) { state.vid.scale = 1; state.vid.x = 0.5; state.vid.y = 0.5; }
  save('vid', state.vid); refreshTools();
  toast(state.vid.edge === 'none' ? 'Edges off' : 'Pinch the video to resize it · drag to move it');
};
el.fitBtn.onclick = () => { state.fit = state.fit === 'contain' ? 'cover' : 'contain'; save('fit', state.fit); refreshTools(); };
el.flipBtn.onclick = () => { state.facing = state.facing === 'user' ? 'environment' : 'user'; startCamera(); };
refreshTools();

// Tap the stage = play/pause. Drag (or pinch) the bubble to move / resize it.
const pointers = new Map();
let drag = null, pinch = null;
function toCanvas(e) {
  const r = el.stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H };
}
el.stage.addEventListener('pointerdown', e => {
  el.stage.setPointerCapture(e.pointerId);
  const p = toCanvas(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2 && state.layout === 'bubble') {
    const [a, b] = [...pointers.values()];
    const bb = bubbleRect();
    const onBubble = drag && drag.inBubble;
    const videoMovable = !state.swap && state.goneT === 0;
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), size: state.bubbleW, target: onBubble || !videoMovable ? 'bubble' : 'video', scale: state.vid.scale };
    drag = null;
    return;
  }
  const b = bubbleRect();
  const inBubble = state.layout === 'bubble' && state.goneT === 0 && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  drag = { start: p, moved: false, inBubble, vx: state.vid.x, vy: state.vid.y, ox: p.x - (b.x + b.w / 2), oy: p.y - (b.y + b.h / 2), t: performance.now() };
});
el.stage.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const p = toCanvas(e);
  pointers.set(e.pointerId, p);
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const ratio = Math.hypot(a.x - b.x, a.y - b.y) / pinch.d;
    if (pinch.target === 'video') { state.vid.scale = clamp(pinch.scale * ratio, 0.3, 1.8); return; }
    state.bubbleW = clamp(pinch.size * ratio, 0.18, 0.75);
    refreshTools();
    return;
  }
  if (!drag) return;
  if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 18) drag.moved = true;
  if (drag.inBubble && drag.moved) {
    state.bubble = { x: (p.x - drag.ox) / W, y: (p.y - drag.oy) / H };
    const b = bubbleRect();
    state.bubble = { x: (b.x + b.w / 2) / W, y: (b.y + b.h / 2) / H };
  } else if (drag.moved && state.layout === 'bubble' && !state.swap && state.goneT === 0) {
    // drag the reacted video around
    state.vid.x = clamp(drag.vx + (p.x - drag.start.x) / W, 0, 1);
    state.vid.y = clamp(drag.vy + (p.y - drag.start.y) / H, 0, 1);
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) { save(pinch.target === 'video' ? 'vid' : 'bubbleW', pinch.target === 'video' ? state.vid : state.bubbleW); pinch = null; } drag = null; return; }
  if (!drag) return;
  if (!drag.moved && performance.now() - drag.t < 400) togglePlay();
  if (drag.inBubble && drag.moved) save('bubble', state.bubble);
  else if (drag.moved) save('vid', state.vid);
  drag = null;
}
el.stage.addEventListener('pointerup', endPointer);
// iPhone Safari treats two-finger pinches as "zoom the page" and cancels our touches. Stop that here.
['gesturestart', 'gesturechange', 'gestureend'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));
for (const node of [el.stage, el.capCanvas, el.timeline]) {
  node.addEventListener('touchstart', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  node.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
}
el.stage.addEventListener('pointercancel', endPointer);

// ---------------- recording clips ----------------
let recorder, micRecorder, chunks = [], micChunks = [], recMime = '', vStream = null, pendingClipLen = 0;
function pickMime(kind = 'video') {
  const opts = kind === 'video'
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return opts.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}
const totalRecorded = () => state.clips.reduce((s, c) => s + c.duration, 0) + (state.recording ? (performance.now() - state.recStart) / 1000 : 0);

function startRec() {
  if (state.recording) return;
  if (!window.MediaRecorder || !el.stage.captureStream) { toast('This browser can\'t record. Use Safari on iPhone.', 5000); return; }
  if (!state.camStream) { toast('Camera isn\'t on yet.'); startCamera(); return; }
  ensureAudio();
  disarmUndo();
  draw();
  vStream = el.stage.captureStream(30);
  const tracks = [...vStream.getVideoTracks()];
  if (recDest) tracks.push(...recDest.stream.getAudioTracks());
  else tracks.push(...state.camStream.getAudioTracks());
  recMime = pickMime('video');
  try {
    recorder = new MediaRecorder(new MediaStream(tracks), {
      ...(recMime ? { mimeType: recMime } : {}), videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 128_000,
    });
  } catch (e) { toast('Recorder error: ' + e.message, 5000); return; }

  // Your mic on its own (no video sound) — used for captions.
  micRecorder = null; micChunks = [];
  try {
    const mt = pickMime('audio');
    micRecorder = new MediaRecorder(new MediaStream(state.camStream.getAudioTracks()), mt ? { mimeType: mt } : {});
    micRecorder.ondataavailable = e => { if (e.data && e.data.size) micChunks.push(e.data); };
  } catch { micRecorder = null; }

  const clip = { id: uid(), srcStart: el.src.currentTime, srcWasPlaying: state.resumeOnRec, duration: 0, speechStart: null, speechEnd: null };
  state.curClip = clip;
  chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const micDone = new Promise(res => { if (micRecorder) micRecorder.onstop = res; else res(); });
  recorder.onstop = async () => {
    vStream.getTracks().forEach(t => t.stop());
    await micDone;
    const type = recorder.mimeType || recMime || 'video/webm';
    const blob = new Blob(chunks, { type });
    const micBlob = micChunks.length ? new Blob(micChunks, { type: micRecorder.mimeType || 'audio/mp4' }) : null;
    chunks = []; micChunks = [];
    if (pendingClipLen < 0.35) { toast('Too short — tap to start, tap again to stop (or hold).'); el.src.currentTime = clip.srcStart; state.resumeOnRec = clip.srcWasPlaying; renderSegBar(); }
    else if (blob.size > 0) addClip(clip, blob, micBlob, type.includes('mp4') ? 'mp4' : 'webm');
    else toast('That clip came out empty — try again.');
  };
  recorder.start(1000);
  if (micRecorder) try { micRecorder.start(1000); } catch {}
  state.recording = true;
  state.recStart = performance.now();
  if (state.resumeOnRec && el.src.paused && !srcDone()) el.src.play().catch(() => {});
  el.recBtn.classList.add('on');
  el.recTimer.hidden = false;
  el.studio.classList.add('recording');
  renderSegBar();
}
function stopRec() {
  if (!state.recording) return;
  pendingClipLen = (performance.now() - state.recStart) / 1000;
  state.recording = false;
  if (state.curClip) state.curClip.srcEnd = el.src.currentTime;
  state.resumeOnRec = !el.src.paused && !srcDone();
  el.src.pause();
  try { recorder.stop(); } catch {}
  try { micRecorder && micRecorder.stop(); } catch {}
  el.recBtn.classList.remove('on');
  el.recTimer.hidden = true;
  el.studio.classList.remove('recording');
}

// Tap = start/stop. Hold = record while held.
let press = null;
el.recBtn.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (!state.recording) { startRec(); press = { started: true, t: performance.now() }; }
  else press = { started: false };
});
el.recBtn.addEventListener('pointerup', () => {
  if (!press) return;
  if (!press.started || performance.now() - press.t > 450) stopRec();
  press = null;
});
el.recBtn.addEventListener('contextmenu', e => e.preventDefault());

async function addClip(clip, blob, micBlob, ext) {
  clip.blob = blob;
  clip.micBlob = micBlob;
  clip.ext = ext;
  clip.url = URL.createObjectURL(blob);
  clip.duration = pendingClipLen;
  if (state.retake) return finishRetake(clip);
  state.clips.push(clip);
  renderClips();
  await storeClip(clip);
  prepareClip(clip);
}
async function storeClip(clip) {
  try {
    await Store.set('clip:' + clip.id, { blob: clip.blob, micBlob: clip.micBlob });
    Store.persist();
  } catch (e) {
    toast('Phone storage is full — this clip won\'t survive closing the app.', 5000);
  }
  saveSession();
}

// After recording: real length, thumbnails for the timeline, and captions if they're on.
async function prepareClip(clip) {
  await makeStrip(clip).catch(e => console.warn('strip failed', e));
  if (el.review.classList.contains('active')) renderTimeline();
  renderClips();
  saveSession();
  if (state.cap.on && !clip.captions) captionClips().catch(() => {});
}

// Thumbnail strip: 8 frames across the clip, drawn on the phone.
const stripQueue = [];
let stripBusy = false;
function makeStrip(clip) {
  return new Promise((resolve, reject) => { stripQueue.push({ clip, resolve, reject }); runStrips(); });
}
async function runStrips() {
  if (stripBusy) return;
  stripBusy = true;
  while (stripQueue.length) {
    const job = stripQueue.shift();
    try { await buildStrip(job.clip); job.resolve(); } catch (e) { job.reject(e); }
  }
  stripBusy = false;
}
async function buildStrip(clip) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.className = 'offscreen';
  document.body.appendChild(v);
  try {
    v.src = clip.url;
    await Promise.race([once(v, 'loadeddata'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    if (Number.isFinite(v.duration) && v.duration > 0) {
      clip.duration = v.duration;
      if (clip.out != null) clip.out = Math.min(clip.out, clip.duration);
    }
    const n = 8, fw = 54, fh = 96;
    const cv = document.createElement('canvas');
    cv.width = fw * n; cv.height = fh;
    const cg = cv.getContext('2d');
    for (let i = 0; i < n; i++) {
      const t = Math.min(clip.duration - 0.05, (i + 0.5) / n * clip.duration);
      v.currentTime = Math.max(0, t);
      await Promise.race([once(v, 'seeked'), new Promise(r => setTimeout(r, 1500))]);
      cg.drawImage(v, i * fw, 0, fw, fh);
    }
    clip.strip = cv.toDataURL('image/jpeg', 0.6);
    const tc = document.createElement('canvas');
    tc.width = fw * 2; tc.height = fh * 2;
    tc.getContext('2d').drawImage(cv, Math.floor(n / 2) * fw, 0, fw, fh, 0, 0, tc.width, tc.height);
    clip.thumb = tc.toDataURL('image/jpeg', 0.7);
  } finally {
    v.removeAttribute('src'); v.load(); v.remove();
  }
}

function removeClip(clip) {
  const i = state.clips.indexOf(clip);
  if (i < 0) return;
  state.clips.splice(i, 1); // its video stays stored so Undo can bring it back
  if (i === state.clips.length) { // last clip: rewind the reacted video to where it started
    el.src.pause();
    el.src.currentTime = clip.srcStart;
    state.resumeOnRec = clip.srcWasPlaying;
    state.goneT = 0;
  }
  renderClips();
  saveSession();
}

function renderSegBar() {
  const segs = state.clips.map(c => ({ d: Math.max(c.duration, 0.2) }));
  if (state.recording && !state.retake) segs.push({ d: Math.max((performance.now() - state.recStart) / 1000, 0.2), live: true });
  el.segBar.hidden = !segs.length;
  if (el.segBar.children.length !== segs.length) el.segBar.innerHTML = segs.map(() => '<i></i>').join('');
  [...el.segBar.children].forEach((node, i) => {
    node.style.flexGrow = segs[i].d;
    node.className = segs[i].live ? 'live' : (state.undoArmed && i === segs.length - 1 ? 'armed' : '');
  });
}
function renderClips() {
  const n = state.clips.length;
  el.clipCount.textContent = n;
  el.clipsBtn.disabled = !n;
  el.nextBtn.disabled = !n;
  el.undoBtn.disabled = !n;
  const last = state.clips[n - 1];
  el.lastClipThumb.src = (last && last.thumb) || '';
  renderSegBar();
  if (sheetMode === 'clips') renderSheet();
}

let undoTimer;
function disarmUndo() { state.undoArmed = false; clearTimeout(undoTimer); renderSegBar(); }
el.undoBtn.onclick = () => {
  if (!state.clips.length) return;
  if (!state.undoArmed) {
    state.undoArmed = true;
    renderSegBar();
    toast('Tap again to delete the last clip');
    clearTimeout(undoTimer);
    undoTimer = setTimeout(disarmUndo, 3000);
    return;
  }
  disarmUndo();
  removeClip(state.clips[state.clips.length - 1]);
  toast('Clip deleted — video rewound to where it started');
};

// ---------------- editor (timeline) ----------------
const ed = { sel: -1, playing: false, mode: 'all', idx: 0, autoCut: load('autoCut', true) };
const MIN_LEN = 0.5;
const clipLen = c => c.out - c.in;
const totalLen = () => state.clips.reduce((s, c) => s + clipLen(c), 0);

// Cut only the quiet bits at the start/end of a clip — never into words.
function autoCut(c) {
  if (c.userTrimmed) return;
  c.in = 0; c.out = c.duration;
  if (!ed.autoCut) return;
  // Best: the caption word timings (exact). Otherwise: mic loudness, with generous padding.
  const words = (c.captions || []).flatMap(L => L.words);
  let a, b;
  if (words.length) { a = words[0].s - 0.35; b = words[words.length - 1].e + 0.5; }
  else if (c.speechStart != null) { a = c.speechStart - 0.6; b = (c.speechEnd ?? c.duration) + 1.0; }
  else return;
  // only trim a real stretch of quiet (over half a second)
  if (a > 0.5) c.in = clamp(a, 0, c.duration);
  if (c.duration - b > 0.5) c.out = clamp(b, 0, c.duration);
  if (c.out - c.in < MIN_LEN) { c.in = 0; c.out = c.duration; }
}

el.nextBtn.onclick = () => { if (state.clips.length) { el.src.pause(); openEditor(); } };

function openEditor(select = -1) {
  for (const c of state.clips) if (c.in == null || c.out == null) autoCut(c);
  show('review');
  ed.playing = false;
  setPlaying(false);
  renderTimeline();
  refreshCapBtn();
  if (select >= 0) selectClip(select);
  else { selectClip(-1); loadPreview(0, state.clips[0].in, false); }
  saveSession();
}

function renderTimeline() {
  const clips = state.clips;
  el.totalLen.textContent = fmt(totalLen());
  el.autoCutBtn.setAttribute('aria-pressed', ed.autoCut);
  if (el.tlClips.children.length !== clips.length) el.tlClips.innerHTML = clips.map(() => '<div class="tl-clip"><span></span></div>').join('');
  [...el.tlClips.children].forEach((node, i) => {
    const c = clips[i];
    const len = clipLen(c);
    node.dataset.i = i;
    node.style.flexGrow = Math.max(len, 0.3);
    node.classList.toggle('sel', i === ed.sel);
    node.querySelector('span').textContent = `${i + 1} · ${len.toFixed(1)}s`;
    node.style.backgroundImage = c.strip ? `url("${c.strip}")` : '';
    node.style.backgroundSize = `${(c.duration / len) * 100}% 100%`;
    node.style.backgroundPosition = `${c.duration - len > 0.01 ? (c.in / (c.duration - len)) * 100 : 0}% 0`;
  });
  if (ed.sel >= 0) renderTrim();
  renderOvLane();
  rebuildTimelineCaptions();
}

function selectClip(i) {
  ed.sel = i;
  el.clipPanel.hidden = i < 0;
  el.tlTip.hidden = i >= 0;
  renderTimeline();
  if (i < 0) return;
  const c = state.clips[i];
  el.trimTrack.style.backgroundImage = c.strip ? `url("${c.strip}")` : '';
  el.cpLeft.disabled = i === 0;
  el.cpRight.disabled = i === state.clips.length - 1;
  ed.mode = 'clip';
  pausePreview();
  loadPreview(i, c.in, false);
}

// preview player: one <video>, switching between clip files
function loadPreview(i, t, play) {
  const c = state.clips[i];
  if (!c) return;
  ed.idx = i;
  const v = el.reviewVideo;
  const go = () => { try { v.currentTime = t; } catch {} if (play) v.play().catch(() => {}); };
  if (v.dataset.src !== c.url) {
    v.dataset.src = c.url;
    v.src = c.url;
    v.addEventListener('loadedmetadata', go, { once: true });
  } else go();
}
function setPlaying(on) {
  ed.playing = on;
  el.playAll.classList.toggle('playing', on && ed.mode === 'all');
  el.reviewPlay.classList.toggle('hide', on);
}
function pausePreview() { el.reviewVideo.pause(); pauseOverlays(); setPlaying(false); }
function playPreview(mode) {
  if (ed.playing) return pausePreview();
  ed.mode = mode;
  const clips = state.clips, v = el.reviewVideo;
  v.play().catch(() => {}); // start inside the tap so the phone allows sound
  if (mode === 'clip') {
    const c = clips[ed.sel];
    const inside = ed.idx === ed.sel && v.currentTime >= c.in && v.currentTime < c.out - 0.05;
    loadPreview(ed.sel, inside ? v.currentTime : c.in, true);
  } else {
    const c = clips[ed.idx];
    const atEnd = !c || (ed.idx === clips.length - 1 && v.currentTime >= c.out - 0.05);
    if (atEnd) loadPreview(0, clips[0].in, true);
    else loadPreview(ed.idx, clamp(v.currentTime, c.in, c.out), true);
  }
  setPlaying(true);
}
el.playAll.onclick = () => { if (ed.sel >= 0 && !ed.playing) selectClip(-1); playPreview('all'); };
el.reviewPlay.onclick = () => playPreview(ed.sel >= 0 ? 'clip' : 'all');

function timelineTime() {
  const c = state.clips[ed.idx];
  if (!c) return 0;
  const t = clamp(el.reviewVideo.currentTime, c.in, c.out);
  return state.clips.slice(0, ed.idx).reduce((s, x) => s + clipLen(x), 0) + (t - c.in);
}

function editorTick() {
  const clips = state.clips, v = el.reviewVideo;
  const c = clips[ed.idx];
  if (!c) return;
  if (ed.playing && !trimDrag && v.readyState >= 2 && (v.currentTime >= c.out - 0.02 || v.ended)) {
    if (ed.mode === 'all' && ed.idx < clips.length - 1) loadPreview(ed.idx + 1, clips[ed.idx + 1].in, true);
    else {
      pausePreview();
      if (ed.mode === 'all') loadPreview(0, clips[0].in, false);
      else loadPreview(ed.idx, c.in, false);
    }
  }
  const t = clamp(v.currentTime, c.in, c.out);
  const block = el.tlClips.children[ed.idx];
  if (block) {
    const x = block.offsetLeft + (t - c.in) / Math.max(clipLen(c), 0.01) * block.offsetWidth;
    el.tlPlayhead.style.left = x + 'px';
    // zoomed in and playing: keep the playhead on screen
    if (ed.playing && ed.zoom > 1 && !tl) {
      const view = el.timeline;
      if (x < view.scrollLeft + 20 || x > view.scrollLeft + view.clientWidth - 20) view.scrollLeft = x - view.clientWidth * 0.3;
    }
  }
  const tt = timelineTime();
  const total = totalLen();
  el.tlTime.textContent = fmt(tt);
  el.tlTotal.textContent = fmt(total);
  if (!scrubbing) el.tlScrub.value = total ? Math.round(tt / total * 1000) : 0;
  if (ed.sel === ed.idx) el.playhead.style.left = (v.currentTime / c.duration * 100) + '%';
  syncOverlays(tt, ed.playing);
  drawPreviewLayer(tt);
}

// ----- scrub bar: drag to any point of the edited video -----
let scrubbing = false;
el.tlScrub.addEventListener('input', () => {
  if (!scrubbing) { scrubbing = true; pausePreview(); if (ed.sel >= 0) selectClip(-1); }
  seekTimeline(el.tlScrub.value / 1000 * totalLen());
});
const endScrub = () => { scrubbing = false; };
el.tlScrub.addEventListener('change', endScrub);
el.tlScrub.addEventListener('pointerup', endScrub);
el.tlScrub.addEventListener('touchend', endScrub);

// ----- timeline zoom -----
ed.zoom = 1;
function setZoom(z, anchorX) {
  const view = el.timeline;
  const r = view.getBoundingClientRect();
  const ax = anchorX != null ? anchorX - r.left : view.clientWidth / 2;
  const oldW = el.tlInner.offsetWidth || view.clientWidth;
  const frac = (view.scrollLeft + ax) / oldW; // keep this point under the finger
  ed.zoom = clamp(z, 1, 12);
  el.tlInner.style.width = (ed.zoom * 100) + '%';
  const newW = el.tlInner.offsetWidth;
  view.scrollLeft = frac * newW - ax;
  el.zoomOut.disabled = ed.zoom <= 1;
  el.zoomIn.disabled = ed.zoom >= 12;
}
// zoom buttons keep the playhead in the middle
function centerOn(x) { el.timeline.scrollLeft = x - el.timeline.clientWidth / 2; }
el.zoomIn.onclick = () => { setZoom(ed.zoom * 1.6); centerOn(el.tlPlayhead.offsetLeft); };
el.zoomOut.onclick = () => { setZoom(ed.zoom / 1.6); centerOn(el.tlPlayhead.offsetLeft); };

// ----- timeline touches -----
// tap a clip = select it · slide = scroll (when zoomed) · press & hold a clip = drag to move it · pinch = zoom
let tl = null;
const tlPointers = new Map();
let tlPinch = null;
el.timeline.addEventListener('pointerdown', e => {
  el.timeline.setPointerCapture(e.pointerId);
  tlPointers.set(e.pointerId, e.clientX);
  if (tlPointers.size === 2) {
    if (tl) { clearTimeout(tl.timer); [...el.tlClips.children].forEach(b => b.classList.remove('dragging')); tl = null; }
    const [a, b] = [...tlPointers.values()];
    tlPinch = { d: Math.max(20, Math.abs(a - b)), z: ed.zoom };
    return;
  }
  const block = e.target.closest('.tl-clip');
  tl = { i: block ? Number(block.dataset.i) : -1, x0: e.clientX, scroll0: el.timeline.scrollLeft, dragging: false, moved: false };
  if (block) tl.timer = setTimeout(startDrag, 300);
});
function startDrag() {
  if (!tl || tl.dragging || tl.moved || tl.i < 0) return;
  pushUndo();
  tl.dragging = true;
  pausePreview();
  navigator.vibrate?.(12);
  el.tlClips.children[tl.i]?.classList.add('dragging');
}
el.timeline.addEventListener('pointermove', e => {
  if (!tlPointers.has(e.pointerId)) return;
  tlPointers.set(e.pointerId, e.clientX);
  if (tlPinch && tlPointers.size === 2) {
    const [a, b] = [...tlPointers.values()];
    setZoom(tlPinch.z * Math.max(20, Math.abs(a - b)) / tlPinch.d, (a + b) / 2);
    return;
  }
  if (!tl) return;
  if (!tl.dragging) {
    // sliding before the hold kicks in = scroll the timeline
    if (Math.abs(e.clientX - tl.x0) > 8) { tl.moved = true; clearTimeout(tl.timer); }
    if (tl.moved) el.timeline.scrollLeft = tl.scroll0 - (e.clientX - tl.x0);
    return;
  }
  const blocks = [...el.tlClips.children];
  let target = 0;
  blocks.forEach((b, j) => {
    if (j === tl.i) return;
    const r = b.getBoundingClientRect();
    if (e.clientX > r.left + r.width / 2) target++;
  });
  if (target !== tl.i) {
    const [moved] = state.clips.splice(tl.i, 1);
    state.clips.splice(target, 0, moved);
    const fix = k => k === tl.i ? target : (tl.i < k && k <= target ? k - 1 : (target <= k && k < tl.i ? k + 1 : k));
    if (ed.sel >= 0) ed.sel = fix(ed.sel);
    ed.idx = fix(ed.idx);
    tl.i = target;
    renderTimeline();
    blocks.forEach(b => b.classList.remove('dragging'));
    el.tlClips.children[target].classList.add('dragging');
  }
});
function endTl(e) {
  tlPointers.delete(e.pointerId);
  if (tlPinch) { if (tlPointers.size < 2) tlPinch = null; return; }
  if (!tl) return;
  clearTimeout(tl.timer);
  [...el.tlClips.children].forEach(b => b.classList.remove('dragging'));
  if (!tl.dragging && !tl.moved) { if (tl.i >= 0) selectClip(tl.i === ed.sel ? -1 : tl.i); }
  else if (tl.dragging) { renderTimeline(); if (ed.sel >= 0) selectClip(ed.sel); saveSession(); }
  tl = null;
  renderClips();
}
el.timeline.addEventListener('pointerup', endTl);
el.timeline.addEventListener('pointercancel', endTl);

// ----- undo / redo (everything you change in the editor) -----
const undoStack = [], redoStack = [];
function editSnapshot() {
  return {
    clips: state.clips.map(c => ({ c, m: { in: c.in, out: c.out, userTrimmed: c.userTrimmed, captions: c.captions ? JSON.parse(JSON.stringify(c.captions)) : null } })),
    overlays: state.overlays.map(o => ({ o, m: { start: o.start, dur: o.dur, vin: o.vin, x: o.x, y: o.y, w: o.w, sound: o.sound } })),
    cap: { ...state.cap },
    autoCut: ed.autoCut,
  };
}
function applySnapshot(s) {
  pausePreview();
  state.clips = s.clips.map(({ c, m }) => Object.assign(c, m));
  state.overlays = s.overlays.map(({ o, m }) => Object.assign(o, m));
  state.cap = { ...s.cap };
  ed.autoCut = s.autoCut;
  for (const o of state.overlays) loadOverlayMedia(o).catch(() => {});
  ed.idx = Math.min(ed.idx, Math.max(0, state.clips.length - 1));
  selectOverlay(null);
  selectClip(-1);
  renderClips();
  renderTimeline();
  refreshCapBtn();
  if (state.clips.length) seekTimeline(Math.min(timelineTime(), Math.max(0, totalLen() - 0.05)));
  if (sheetMode) renderSheet();
  saveSession();
}
function pushUndo() {
  undoStack.push(editSnapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  refreshUndo();
}
function refreshUndo() {
  el.undoEd.disabled = !undoStack.length;
  el.redoEd.disabled = !redoStack.length;
}
el.undoEd.onclick = () => {
  if (!undoStack.length) return;
  redoStack.push(editSnapshot());
  applySnapshot(undoStack.pop());
  refreshUndo();
  toast('Undone');
};
el.redoEd.onclick = () => {
  if (!redoStack.length) return;
  undoStack.push(editSnapshot());
  applySnapshot(redoStack.pop());
  refreshUndo();
  toast('Redone');
};

function moveSel(d) {
  const i = ed.sel, j = i + d;
  if (i < 0 || j < 0 || j >= state.clips.length) return;
  pushUndo();
  [state.clips[i], state.clips[j]] = [state.clips[j], state.clips[i]];
  renderClips();
  selectClip(j);
  saveSession();
}
el.cpLeft.onclick = () => moveSel(-1);
el.cpRight.onclick = () => moveSel(1);
el.cpDone.onclick = () => selectClip(-1);
el.cpDelete.onclick = () => {
  const c = state.clips[ed.sel];
  if (!c) return;
  pushUndo();
  pausePreview();
  removeClip(c);
  toast('Clip deleted — tap Undo (↶) to bring it back');
  if (!state.clips.length) { enterStudio(); return; }
  ed.idx = 0;
  selectClip(-1);
  loadPreview(0, state.clips[0].in, false);
};
el.autoCutBtn.onclick = () => {
  pushUndo();
  ed.autoCut = !ed.autoCut;
  save('autoCut', ed.autoCut);
  state.clips.forEach(autoCut);
  renderTimeline();
  const any = state.clips.some(c => c.speechStart != null);
  toast(ed.autoCut ? (any ? 'Cut the quiet bits at the start and end of each clip' : 'No talking detected to cut to') : 'Showing full clips');
  if (ed.sel >= 0) loadPreview(ed.sel, state.clips[ed.sel].in, false);
  saveSession();
};

function renderTrim() {
  const c = state.clips[ed.sel];
  if (!c) return;
  const d = c.duration || 1;
  const a = c.in / d * 100, b = c.out / d * 100;
  el.cpTitle.textContent = `Clip ${ed.sel + 1}`;
  el.shadeL.style.width = a + '%';
  el.shadeR.style.width = (100 - b) + '%';
  el.trimSel.style.left = `calc(${a}% - 16px)`;
  el.trimSel.style.right = `calc(${100 - b}% - 16px)`;
  el.tIn.textContent = fmt1(c.in);
  el.tOut.textContent = fmt1(c.out);
  el.tLen.textContent = clipLen(c).toFixed(1) + 's of ' + c.duration.toFixed(1) + 's';
}

let trimDrag = null;
const trimZone = el.clipPanel;
trimZone.addEventListener('pointerdown', e => {
  const c = state.clips[ed.sel];
  if (!c || (!e.target.closest('.trim-track, .trim-times') && e.target !== trimZone)) return;
  trimZone.setPointerCapture(e.pointerId);
  const r = el.trimTrack.getBoundingClientRect();
  const tAt = x => clamp((x - r.left) / r.width, 0, 1) * c.duration;
  const px = t => r.left + t / c.duration * r.width;
  const nearL = Math.abs(e.clientX - px(c.in)), nearR = Math.abs(e.clientX - px(c.out));
  let which = null;
  if (Math.min(nearL, nearR) < 32) { which = nearL <= nearR ? 'in' : 'out'; pushUndo(); }
  trimDrag = { which, tAt, c };
  pausePreview();
  ed.mode = 'clip';
  moveTrim(e);
});
function moveTrim(e) {
  if (!trimDrag) return;
  const { c, which } = trimDrag;
  const t = trimDrag.tAt(e.clientX);
  if (which === 'in') { c.in = clamp(t, 0, c.out - MIN_LEN); c.userTrimmed = true; loadPreview(ed.sel, c.in, false); }
  else if (which === 'out') { c.out = clamp(t, c.in + MIN_LEN, c.duration); c.userTrimmed = true; loadPreview(ed.sel, c.out, false); }
  else loadPreview(ed.sel, clamp(t, c.in, c.out), false);
  renderTimeline();
}
trimZone.addEventListener('pointermove', moveTrim);
const endTrim = () => {
  if (!trimDrag) return;
  const { which, c } = trimDrag;
  trimDrag = null;
  if (which) { loadPreview(ed.sel, c.in, false); playPreview('clip'); saveSession(); }
};
trimZone.addEventListener('pointerup', endTrim);
trimZone.addEventListener('pointercancel', endTrim);

el.reviewBack.onclick = () => { pausePreview(); enterStudio(); };

// retake: re-record one clip from the same spot in the reacted video
el.cpRetake.onclick = () => {
  const i = ed.sel, c = state.clips[i];
  if (!c) return;
  pausePreview();
  state.retake = { clip: c, index: i, target: clipLen(c), prevTime: el.src.currentTime, prevResume: state.resumeOnRec };
  el.src.pause();
  el.src.currentTime = c.srcStart;
  state.resumeOnRec = c.srcEnd != null ? c.srcEnd > c.srcStart + 0.2 : c.srcWasPlaying;
  el.retakeName.textContent = `clip ${i + 1}`;
  el.retakeLen.textContent = clipLen(c).toFixed(1) + 's';
  el.retakeBar.hidden = false;
  el.studio.classList.add('retaking');
  enterStudio();
  state.goneT = 0;
};
function endRetakeMode() {
  const r = state.retake;
  state.retake = null;
  el.retakeBar.hidden = true;
  el.studio.classList.remove('retaking');
  el.recTimer.classList.remove('over');
  el.src.pause();
  el.src.currentTime = r.prevTime;
  state.resumeOnRec = r.prevResume;
  return r;
}
el.retakeCancel.onclick = () => { if (!state.recording) openEditor(endRetakeMode().index); };
async function finishRetake(clip) {
  const r = endRetakeMode();
  const i = state.clips.indexOf(r.clip);
  if (i < 0) state.clips.push(clip);
  else {
    pushUndo();
    state.clips[i] = clip; // the old take stays stored so Undo can bring it back
  }
  busy(true, 'Adding your retake…');
  await storeClip(clip);
  await makeStrip(clip).catch(() => {});
  busy(false);
  autoCut(clip);
  renderClips();
  openEditor(state.clips.indexOf(clip));
  toast('Retake swapped in');
  if (state.cap.on) captionClips().catch(() => {});
}

// ---------------- captions ----------------
let tlCaps = [];            // caption lines placed on the timeline (seconds from the start)
let capJob = null;          // running transcription
let capStatus = '';

let tlLines = [];           // the editable lines (what the Captions sheet lists)
function rebuildTimelineCaptions() {
  buildTimelineLines();
  tlLines = tlCaps;
  // stacked styles show longer phrases
  if (Captions.isStacked(state.cap.style)) {
    tlCaps = Captions.groupPhrases(tlLines);
    tlCaps.forEach((L, i) => {
      const next = tlCaps[i + 1];
      L.until = Math.max(L.e + 0.15, Math.min(next ? next.s : Infinity, L.e + 0.8));
    });
  }
}
function buildTimelineLines() {
  tlCaps = [];
  let off = 0;
  for (const c of state.clips) {
    for (const L of c.captions || []) {
      const words = L.words
        .filter(w => { const mid = (w.s + w.e) / 2; return mid >= c.in && mid <= c.out; })
        .map(w => ({ w: w.w, s: off + w.s - c.in, e: off + w.e - c.in }));
      if (words.length) tlCaps.push({ s: words[0].s, e: words[words.length - 1].e, words, ref: L, clip: c });
    }
    off += clipLen(c);
  }
  // keep each line up until the next one (or a bit after it ends) so captions don't flicker
  tlCaps.forEach((L, i) => {
    const next = tlCaps[i + 1];
    L.until = Math.max(L.e + 0.15, Math.min(next ? next.s : Infinity, L.e + 0.6));
  });
}
const lineAt = t => tlCaps.find(L => t >= L.s && t < L.until) || null;

let capBox = null;
// Everything drawn on top of the preview video: overlays, then captions.
function drawPreviewLayer(t) {
  capG.clearRect(0, 0, W, H);
  drawOverlays(capG, t, true);
  capBox = null;
  if (!state.cap.on) return;
  capBox = Captions.draw(capG, lineAt(t), t, state.cap.style, state.cap.y, W, H, state.cap.hi);
}

// On the preview: drag an overlay to move it (pinch to resize), drag captions up/down, tap = play/pause.
const capPointers = new Map();
let capDrag = null;
function capPoint(e) {
  const r = el.capCanvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H, h: r.height };
}
function overlayAt(p, tt) {
  for (let i = state.overlays.length - 1; i >= 0; i--) {
    const o = state.overlays[i];
    if (!ovActive(o, tt)) continue;
    const r = ovRect(o);
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return o;
  }
  return null;
}
el.capCanvas.addEventListener('pointerdown', e => {
  el.capCanvas.setPointerCapture(e.pointerId);
  const p = capPoint(e);
  capPointers.set(e.pointerId, p);
  const sel = ovById(ovSel);
  if (capPointers.size === 2 && sel) { // pinch the selected overlay
    const [a, b] = [...capPointers.values()];
    pushUndo();
    capDrag = { kind: 'pinch', o: sel, d: Math.hypot(a.x - b.x, a.y - b.y), w: sel.w, moved: true };
    return;
  }
  const o = overlayAt(p, timelineTime());
  if (o) {
    if (ed.playing) pausePreview();
    if (ovSel !== o.id) selectOverlay(o.id);
    capDrag = { kind: 'ov', o, p0: p, x: o.x, y: o.y, moved: false };
  } else {
    capDrag = { kind: 'cap', y0: e.clientY, startY: state.cap.y, h: p.h, moved: false };
  }
});
el.capCanvas.addEventListener('pointermove', e => {
  if (!capDrag || !capPointers.has(e.pointerId)) return;
  const p = capPoint(e);
  capPointers.set(e.pointerId, p);
  if (capDrag.kind === 'pinch') {
    if (capPointers.size < 2) return;
    const [a, b] = [...capPointers.values()];
    capDrag.o.w = clamp(capDrag.w * Math.hypot(a.x - b.x, a.y - b.y) / capDrag.d, 0.1, 1.2);
    el.ovSize.value = Math.round(Math.min(1, capDrag.o.w) * 100);
  } else if (capDrag.kind === 'ov') {
    if (!capDrag.moved && Math.hypot(p.x - capDrag.p0.x, p.y - capDrag.p0.y) > 14) { capDrag.moved = true; pushUndo(); }
    if (!capDrag.moved) return;
    capDrag.o.x = clamp(capDrag.x + (p.x - capDrag.p0.x) / W, 0, 1);
    capDrag.o.y = clamp(capDrag.y + (p.y - capDrag.p0.y) / H, 0, 1);
  } else {
    const dy = e.clientY - capDrag.y0;
    if (Math.abs(dy) > 8 && !capDrag.moved && state.cap.on) { capDrag.moved = true; pushUndo(); }
    if (!capDrag.moved || !state.cap.on) return;
    state.cap.y = clamp(capDrag.startY + dy / capDrag.h, 0.12, 0.9);
  }
  if (!ed.playing) drawPreviewLayer(timelineTime());
});
function endCapPointer(e) {
  capPointers.delete(e.pointerId);
  if (!capDrag) return;
  if (capDrag.kind === 'pinch') { if (capPointers.size === 0) { capDrag = null; saveSession(); } return; }
  if (!capDrag.moved) {
    if (capDrag.kind === 'cap') { if (ovSel) selectOverlay(null); else playPreview(ed.sel >= 0 ? 'clip' : 'all'); }
  } else saveSession();
  capDrag = null;
}
el.capCanvas.addEventListener('pointerup', endCapPointer);
el.capCanvas.addEventListener('pointercancel', endCapPointer);

function refreshCapBtn() {
  el.captionsBtn.setAttribute('aria-pressed', state.cap.on);
  el.captionsBtn.textContent = capJob ? 'Captions…' : 'Captions';
}

Captions.onProgress(p => {
  if (p.phase === 'download') {
    capStatus = `Getting the caption engine (one time, ${Math.round(p.mb)} MB): ${Math.round(p.frac * 100)}%`;
    if (sheetMode === 'captions') renderSheet();
  }
});

// Whisper sometimes "hears" words in silence ("you", "Thank you."). Drop those.
const PHANTOMS = new Set(['you', 'thank you', 'thanks', 'thanks for watching', 'bye', 'okay', 'oh', 'uh', 'um', 'hmm', 'so', '']);
function dropPhantomWords(words, c) {
  const text = words.map(w => w.w).join(' ').toLowerCase().replace(/[^a-z' ]/g, '').trim();
  const micHeardNothing = c.speechStart == null;
  if (PHANTOMS.has(text)) return [];
  if (micHeardNothing && words.length <= 3) return [];
  return words;
}
async function captionClips() {
  if (capJob) return capJob;
  capJob = (async () => {
    refreshCapBtn();
    const todo = state.clips.filter(c => !c.captions);
    const silent = [];
    let n = 0;
    for (const c of todo) {
      n++;
      const num = state.clips.indexOf(c) + 1;
      capStatus = `Listening to clip ${num}${todo.length > 1 ? ` (${n} of ${todo.length})` : ''}…`;
      if (sheetMode === 'captions') renderSheet();
      // Your own mic first; if that gave nothing (or the phone couldn't read it), try the clip's sound.
      let words = [];
      if (c.micBlob) { try { words = await Captions.transcribe(c.micBlob, ac); } catch (e) { console.warn('mic audio', e); } }
      if (!words.length) { try { words = await Captions.transcribe(c.blob, ac); } catch (e) { console.warn('clip audio', e); } }
      words = dropPhantomWords(words, c);
      c.captions = Captions.toLines(words);
      if (!words.length) silent.push(num);
      if (!c.userTrimmed) autoCut(c); // word timings make Cut silence exact
      if (el.review.classList.contains('active')) renderTimeline(); else rebuildTimelineCaptions();
      saveSession();
    }
    capStatus = silent.length ? `No words were heard in clip ${silent.join(', ')}. If you were talking, tap "Redo all captions".` : '';
  })();
  try { await capJob; }
  catch (e) {
    capStatus = 'Captions failed: ' + e.message + (navigator.onLine ? '' : ' (you need internet the first time)');
    throw e;
  } finally {
    capJob = null;
    refreshCapBtn();
    if (sheetMode === 'captions') renderSheet();
  }
}

el.captionsBtn.onclick = () => openSheet('captions');

// ---------------- saving: render the timeline into one video, on the phone ----------------
let rendering = false, renderAbort = false;
let workNode = null, workDest = null;
el.saveFinal.onclick = async () => {
  if (rendering || !state.clips.length) return;
  pausePreview();
  ensureAudio();
  // unlock playback of the work video inside this tap (phones block sound that starts later)
  el.workVideo.muted = false;
  el.workVideo.play().catch(() => {});
  for (const m of ovMedia.values()) if (m.tagName === 'VIDEO') { m.play().catch(() => {}); m.pause(); }
  if (ovMonitor) ovMonitor.gain.value = 0; // don't blast overlay sound while saving
  if (state.cap.on && state.clips.some(c => !c.captions)) {
    busy(true, 'Finishing captions…');
    try { await captionClips(); } catch { toast('Captions failed — saving without the missing ones.', 4000); }
    busy(false);
  }
  rendering = true;
  renderAbort = false;
  el.renderOverlay.hidden = false;
  try {
    const blob = await renderVideo(frac => {
      el.renderBar.style.width = Math.round(frac * 100) + '%';
      el.renderText.textContent = Math.round(frac * 100) + '%';
    });
    if (!blob) return; // cancelled
    const id = uid();
    const thumb = el.renderCanvas.toDataURL ? (() => {
      const t = document.createElement('canvas'); t.width = 108; t.height = 192;
      t.getContext('2d').drawImage(el.renderCanvas, 0, 0, 108, 192);
      return t.toDataURL('image/jpeg', 0.7);
    })() : '';
    const video = { id, blob, created: Date.now(), duration: totalLen(), thumb, ext: blob.type.includes('mp4') ? 'mp4' : 'webm' };
    await Store.addVideo(video).catch(() => toast('Not enough space to keep it in My videos — save it to Photos now.', 5000));
    openPlayer({ blob, name: `reaction-${new Date().toISOString().slice(0, 10)}.${video.ext}`, mode: 'final' });
  } catch (e) {
    console.error(e);
    toast('Saving failed: ' + e.message, 6000);
  } finally {
    rendering = false;
    el.renderOverlay.hidden = true;
    pauseOverlays();
    if (ovMonitor) ovMonitor.gain.value = 1;
    el.renderBar.style.width = '0';
  }
};
el.renderCancel.onclick = () => { renderAbort = true; };

async function renderVideo(onProgress) {
  const clips = state.clips;
  const total = totalLen();
  const rc = el.renderCanvas, rg = rc.getContext('2d');
  const v = el.workVideo;
  if (!workNode) {
    workNode = ac.createMediaElementSource(v);
    workDest = workDest || ac.createMediaStreamDestination();
    workNode.connect(workDest);
  }
  const vs = rc.captureStream(30);
  const stream = new MediaStream([...vs.getVideoTracks(), ...workDest.stream.getAudioTracks()]);
  const mime = pickMime('video');
  const rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 160_000 });
  const out = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) out.push(e.data); };
  const stopped = once(rec, 'stop');
  const canPause = typeof rec.pause === 'function';
  let started = false, done = 0;

  const frame = tt => {
    rg.fillStyle = '#000'; rg.fillRect(0, 0, W, H);
    if (v.videoWidth) {
      const s = Math.max(W / v.videoWidth, H / v.videoHeight);
      rg.drawImage(v, (W - v.videoWidth * s) / 2, (H - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
    }
    drawOverlays(rg, tt, false);
    if (state.cap.on) Captions.draw(rg, lineAt(tt), tt, state.cap.style, state.cap.y, W, H, state.cap.hi);
  };

  try {
    for (const c of clips) {
      if (renderAbort) break;
      v.src = c.url;
      await once(v, 'loadeddata');
      v.currentTime = c.in;
      await Promise.race([once(v, 'seeked'), new Promise(r => setTimeout(r, 2000))]);
      frame(done);
      if (!started) { rec.start(500); started = true; }
      else if (canPause && rec.state === 'paused') rec.resume();
      await v.play();
      await new Promise(resolve => {
        const step = () => {
          if (renderAbort) { v.pause(); return resolve(); }
          const t = v.currentTime;
          const tt = done + Math.max(0, t - c.in);
          syncOverlays(tt, true);
          frame(tt);
          onProgress(Math.min(1, tt / total));
          if (t >= c.out - 0.01 || v.ended) {
            v.pause();
            if (canPause && rec.state === 'recording') rec.pause();
            return resolve();
          }
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      done += clipLen(c);
    }
  } finally {
    if (rec.state !== 'inactive') { if (rec.state === 'paused') rec.resume(); rec.stop(); }
    vs.getTracks().forEach(t => t.stop());
  }
  await stopped;
  v.removeAttribute('src'); v.load();
  if (renderAbort) { toast('Cancelled'); return null; }
  onProgress(1);
  return new Blob(out, { type: rec.mimeType || mime || 'video/mp4' });
}

// ---------------- sheet: clips / my videos / captions / setup ----------------
let sheetMode = null, videoList = [];
async function openSheet(mode) {
  if (state.recording) return;
  sheetMode = mode;
  el.sheetTitle.textContent = { clips: 'Clips', videos: 'My videos', captions: 'Captions', setup: 'Set up link downloads', srctrim: 'Trim the video', overlay: 'Overlay' }[mode];
  if (mode === 'videos') { try { videoList = await Store.listVideos(); } catch { videoList = []; } }
  renderSheet();
  el.sheetBackdrop.hidden = false;
  el.sheet.classList.add('open');
  el.sheet.setAttribute('aria-hidden', 'false');
}
function closeSheet() {
  if (sheetMode === 'captions') { rebuildTimelineCaptions(); saveSession(); }
  sheetMode = null;
  el.sheet.classList.remove('open');
  el.sheet.setAttribute('aria-hidden', 'true');
  el.sheetBackdrop.hidden = true;
}
el.closeSheet.onclick = closeSheet;
el.sheetBackdrop.onclick = closeSheet;
el.clipsBtn.onclick = () => openSheet('clips');
el.myVideosBtn.onclick = () => openSheet('videos');
el.setupBtn.onclick = () => openSetup(false);
function openSetup(fromGet) { openSheet('setup'); if (fromGet) toast('Set this up once, then Get video works'); }

// ----- trim the reacted video -----
el.trimSrcBtn.onclick = () => { if (!state.recording) { el.src.pause(); openSheet('srctrim'); } };

async function sourceStrip() {
  if (state.srcStrip) return state.srcStrip;
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.className = 'offscreen';
  document.body.appendChild(v);
  try {
    v.src = state.srcURL;
    await Promise.race([once(v, 'loadeddata'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
    const n = 10, fw = 54, fh = 96;
    const cv = document.createElement('canvas'); cv.width = fw * n; cv.height = fh;
    const cg = cv.getContext('2d');
    for (let i = 0; i < n; i++) {
      v.currentTime = (i + 0.5) / n * v.duration;
      await Promise.race([once(v, 'seeked'), new Promise(r => setTimeout(r, 1500))]);
      const s = Math.max(fw / v.videoWidth, fh / v.videoHeight);
      cg.drawImage(v, i * fw + (fw - v.videoWidth * s) / 2, (fh - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
    }
    state.srcStrip = cv.toDataURL('image/jpeg', 0.6);
  } finally { v.removeAttribute('src'); v.load(); v.remove(); }
  return state.srcStrip;
}

function renderSrcTrim(body) {
  const d = el.src.duration || 0;
  body.innerHTML = `
    <p class="sheet-tip">Cut the start or end of the video you're reacting to. Drag the white handles — the video above shows where you are.</p>
    <div class="src-trim">
      <div class="trim-track" data-track>
        <div class="trim-shade" data-shade="l" style="left:0"></div>
        <div class="trim-shade" data-shade="r" style="right:0"></div>
        <div class="trim-sel" data-sel><span class="handle l"><i></i></span><span class="handle r"><i></i></span></div>
      </div>
      <div class="trim-times"><span data-in></span><b data-len></b><span data-out></span></div>
    </div>
    <div class="cap-actions"><button class="btn ghost" data-act="reset">Use whole video</button><button class="btn primary" data-act="done">Done</button></div>`;
  const zone = body.querySelector('.src-trim'), track = body.querySelector('[data-track]');
  const q = s => body.querySelector(s);
  const paint = () => {
    const a = srcIn() / d * 100, b = srcOut() / d * 100;
    q('[data-shade="l"]').style.width = a + '%';
    q('[data-shade="r"]').style.width = (100 - b) + '%';
    q('[data-sel]').style.left = `calc(${a}% - 16px)`;
    q('[data-sel]').style.right = `calc(${100 - b}% - 16px)`;
    q('[data-in]').textContent = fmt1(srcIn());
    q('[data-out]').textContent = fmt1(srcOut());
    q('[data-len]').textContent = (srcOut() - srcIn()).toFixed(1) + 's of ' + d.toFixed(1) + 's';
  };
  paint();
  sourceStrip().then(s => { track.style.backgroundImage = `url("${s}")`; }).catch(() => {});
  let dragging = null;
  zone.addEventListener('pointerdown', e => {
    zone.setPointerCapture(e.pointerId);
    const r = track.getBoundingClientRect();
    const tAt = x => clamp((x - r.left) / r.width, 0, 1) * d;
    const px = t => r.left + t / d * r.width;
    dragging = { tAt, which: Math.abs(e.clientX - px(srcIn())) <= Math.abs(e.clientX - px(srcOut())) ? 'in' : 'out' };
    move(e);
  });
  const move = e => {
    if (!dragging) return;
    const t = dragging.tAt(e.clientX);
    if (dragging.which === 'in') { state.srcIn = clamp(t, 0, srcOut() - 1); el.src.currentTime = state.srcIn; }
    else { state.srcOut = clamp(t, srcIn() + 1, d); el.src.currentTime = state.srcOut; }
    state.goneT = 0;
    paint();
  };
  zone.addEventListener('pointermove', move);
  const end = () => { if (dragging) { dragging = null; saveSession(); } };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
  q('[data-act="reset"]').onclick = () => { state.srcIn = 0; state.srcOut = null; paint(); saveSession(); };
  q('[data-act="done"]').onclick = () => {
    if (state.srcOut != null && state.srcOut >= d - 0.05) state.srcOut = null;
    el.src.currentTime = srcIn();
    state.goneT = 0;
    updateTimes();
    saveSession();
    closeSheet();
  };
}

function renderSheet() {
  const body = el.sheetBody;
  if (sheetMode === 'srctrim') return renderSrcTrim(body);
  if (sheetMode === 'clips') return renderClipList(body);
  if (sheetMode === 'videos') return renderVideoList(body);
  if (sheetMode === 'captions') return renderCaptionSheet(body);
  if (sheetMode === 'setup') return renderSetup(body);
}

function renderClipList(body) {
  body.innerHTML = '<p class="sheet-tip">Your clips play back-to-back as one video. Tap › when you\'re done.</p><ul class="take-list"></ul>' +
    (state.clips.length ? '' : '<p class="empty">No clips yet.</p>');
  const ul = body.querySelector('ul');
  state.clips.forEach((c, i) => {
    const li = document.createElement('li');
    li.className = 'take';
    li.innerHTML = `<img class="thumb" src="${c.thumb || ''}" alt="">
      <div class="meta"><b>Clip ${i + 1}</b><small>${c.duration.toFixed(1)}s</small></div>
      <div class="acts"><button class="play">Play</button><button class="del" aria-label="Delete">✕</button></div>`;
    li.querySelector('.play').onclick = () => openPlayer({ url: c.url, mode: 'clip' });
    li.querySelector('.del').onclick = () => { if (confirm(`Delete clip ${i + 1}?`)) removeClip(c); };
    ul.appendChild(li);
  });
}

function renderVideoList(body) {
  body.innerHTML = '<p class="sheet-tip">Finished videos, kept on this phone. Save them to Photos to keep them for good.</p><ul class="take-list"></ul>' +
    (videoList.length ? '' : '<p class="empty">No saved videos yet.</p>');
  const ul = body.querySelector('ul');
  videoList.forEach(v => {
    const li = document.createElement('li');
    li.className = 'take';
    const when = new Date(v.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    li.innerHTML = `<img class="thumb" src="${v.thumb || ''}" alt="">
      <div class="meta"><b>${esc(when)}</b><small>${fmt(v.duration)} · ${(v.blob.size / 1e6).toFixed(1)} MB</small></div>
      <div class="acts"><button class="play">Play</button><button class="save">Save</button><button class="del" aria-label="Delete">✕</button></div>`;
    const name = `reaction-${new Date(v.created).toISOString().slice(0, 10)}.${v.ext || 'mp4'}`;
    li.querySelector('.play').onclick = () => openPlayer({ blob: v.blob, name, mode: 'video' });
    li.querySelector('.save').onclick = () => saveToPhone(v.blob, name);
    li.querySelector('.del').onclick = async () => {
      if (!confirm('Delete this video from the app? (Copies saved to Photos stay.)')) return;
      await Store.delVideo(v.id).catch(() => {});
      videoList = videoList.filter(x => x !== v);
      renderSheet();
    };
    ul.appendChild(li);
  });
}

function renderCaptionSheet(body) {
  const have = state.clips.some(c => c.captions);
  const missing = state.clips.filter(c => !c.captions).length;
  body.innerHTML = `
    <p class="sheet-tip">Captions of <b>your voice only</b>, made on this phone. Drag them up or down on the video.</p>
    ${capStatus ? `<p class="cap-progress">${esc(capStatus)}</p>` : ''}
    <div class="cap-actions">
      ${have ? `<button class="btn ${state.cap.on ? 'ghost' : 'primary'}" data-act="toggle">${state.cap.on ? 'Hide captions' : 'Show captions'}</button>` : ''}
      ${(!have || missing) && !capJob ? `<button class="btn primary" data-act="make">${have ? `Caption ${missing} new clip${missing > 1 ? 's' : ''}` : 'Add captions'}</button>` : ''}
    </div>
    ${have ? `<div class="cap-styles">${Captions.STYLE_LIST.map(([k, label]) => `<button data-style="${k}" class="${state.cap.style === k ? 'on' : ''}"><canvas width="540" height="400"></canvas><small>${label}</small></button>`).join('')}</div>` : ''}
    ${have ? `<p class="sheet-tip" style="margin-top:4px">Highlight colour</p>
    <div class="swatches">
      <button data-hi="" class="sw auto ${!state.cap.hi ? 'on' : ''}" aria-label="Style's own colour">Auto</button>
      ${HI_COLORS.map(c => `<button data-hi="${c}" class="sw ${state.cap.hi === c ? 'on' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')}
      <label class="sw custom ${state.cap.hi && !HI_COLORS.includes(state.cap.hi) ? 'on' : ''}" style="${state.cap.hi && !HI_COLORS.includes(state.cap.hi) ? `background:${state.cap.hi}` : ''}" aria-label="Pick any colour">
        <input type="color" value="${state.cap.hi || '#ffe500'}">＋
      </label>
    </div>` : ''}
    ${have && !tlLines.length && !capJob ? '<p class="cap-progress">Captions are on, but no words were found in your clips. If you were talking, tap "Redo all captions" below.</p>' : ''}
    <div class="cap-lines"></div>
    ${have && !capJob ? '<div class="cap-actions"><button class="btn ghost" data-act="redo">Redo all captions</button></div>' : ''}
    ${!have && !capJob ? '<p class="sheet-tip">The first time, the phone downloads the caption engine (about 80 MB). After that it works offline.</p>' : ''}`;
  const setHi = c => {
    pushUndo();
    state.cap.hi = c || null;
    saveSession();
    renderSheet();
    if (!ed.playing) drawPreviewLayer(timelineTime());
  };
  body.querySelectorAll('[data-hi]').forEach(b => b.onclick = () => setHi(b.dataset.hi));
  const picker = body.querySelector('.swatches input[type=color]');
  if (picker) picker.onchange = () => setHi(picker.value);
  body.querySelectorAll('[data-style]').forEach(b => {
    drawStyleSample(b.querySelector('canvas'), b.dataset.style);
    b.onclick = () => {
      pushUndo();
      state.cap.style = b.dataset.style; state.cap.on = true;
      refreshCapBtn(); rebuildTimelineCaptions(); saveSession(); renderSheet();
      if (!ed.playing) drawPreviewLayer(timelineTime());
    };
  });
  const act = a => body.querySelector(`[data-act="${a}"]`);
  act('toggle') && (act('toggle').onclick = () => { pushUndo(); state.cap.on = !state.cap.on; refreshCapBtn(); saveSession(); renderSheet(); });
  const make = async () => {
    pushUndo();
    state.cap.on = true;
    refreshCapBtn();
    const p = captionClips();
    renderSheet();
    try { await p; toast('Captions ready — check the words below'); } catch {}
    renderSheet();
  };
  act('make') && (act('make').onclick = make);
  act('redo') && (act('redo').onclick = () => { if (!confirm('Redo captions for every clip? Your word fixes will be lost.')) return; state.clips.forEach(c => { c.captions = null; }); make(); });

  rebuildTimelineCaptions();
  const box = body.querySelector('.cap-lines');
  tlLines.forEach(L => {
    const row = document.createElement('div');
    row.className = 'cap-row';
    row.innerHTML = `<small>${fmt1(L.s)}</small><input value="${esc(L.ref.words.map(w => w.w).join(' '))}" enterkeyhint="done"><button aria-label="Remove line">✕</button>`;
    const input = row.querySelector('input');
    input.onfocus = () => { pausePreview(); seekTimeline(L.s + 0.05); };
    input.onchange = () => { pushUndo(); Captions.setLineText(L.ref, input.value); rebuildTimelineCaptions(); saveSession(); };
    input.onkeydown = e => { if (e.key === 'Enter') input.blur(); };
    row.querySelector('button').onclick = () => { pushUndo(); Captions.setLineText(L.ref, ''); rebuildTimelineCaptions(); saveSession(); renderSheet(); };
    box.appendChild(row);
  });
}

const HI_COLORS = ['#ffe500', '#2ee6d6', '#ff3b4e', '#7c3aed', '#3ddc84', '#ff8a00', '#ff4fd8', '#3b82f6', '#ffffff'];

// Little live preview of a caption style for the picker.
const SAMPLE = 'nobody talks about this part'.split(' ').map((w, i) => ({ w, s: i * 0.3, e: i * 0.3 + 0.28 }));
let sampleCanvas;
function drawStyleSample(cv, style) {
  const sg = cv.getContext('2d');
  sg.fillStyle = '#1d1d22'; sg.fillRect(0, 0, cv.width, cv.height);
  // draw it at real size (1080 wide), then zoom in on the caption so the tile is readable
  sampleCanvas = sampleCanvas || document.createElement('canvas');
  sampleCanvas.width = 1080; sampleCanvas.height = 900;
  const og = sampleCanvas.getContext('2d');
  og.clearRect(0, 0, 1080, 900);
  const box = Captions.draw(og, { s: 0, e: 2, words: SAMPLE }, 1.25, style, 0.5, 1080, 900, state.cap.hi);
  if (!box) return;
  const bw = box.x2 - box.x1, bh = box.y2 - box.y1;
  const s = Math.min((cv.width * 0.9) / bw, (cv.height * 0.85) / bh, 1.2);
  sg.drawImage(sampleCanvas, box.x1, box.y1, bw, bh, (cv.width - bw * s) / 2, (cv.height - bh * s) / 2, bw * s, bh * s);
}

function seekTimeline(tt) {
  let off = 0;
  for (let i = 0; i < state.clips.length; i++) {
    const c = state.clips[i], len = clipLen(c);
    if (tt < off + len || i === state.clips.length - 1) { loadPreview(i, c.in + clamp(tt - off, 0, len), false); return; }
    off += len;
  }
}

function renderSetup(body) {
  const appURL = location.origin + location.pathname;
  const cmd = [
    'cd ~/Documents',
    'rm -f reaction-video.mp4',
    'yt-dlp --no-playlist --force-overwrites -f "b[ext=mp4][vcodec^=avc]/bv*[vcodec^=avc][height<=1920]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4 -o reaction-video.mp4 "LINK"',
    'open "shortcuts://run-shortcut?name=ReactionStudioSave"',
  ].join('\n');
  const back = 'x-safari-' + appURL + '?got=1';
  const copy = (text, label = 'Copy') => `<pre>${esc(text)}</pre><button class="copy" data-copy="${esc(text)}">${label}</button>`;
  body.innerHTML = `<div class="setup">
    <p class="sheet-tip">Do this once. After that, in Instagram, TikTok or YouTube tap <b>Share → Reaction Studio</b> and the video lands here.
    It uses <b>two</b> shortcuts: one downloads, the other saves the video and brings you back.</p>

    <h3>1 · The downloader (a-Shell)</h3>
    <ol>
      <li>Install <b>a-Shell</b> from the App Store (free). Use the full a-Shell, not "mini": Instagram sends picture and sound separately, and only the full one can join them.</li>
      <li>Open a-Shell, paste this, press <b>return</b>, and wait for "Successfully installed":
        ${copy('pip install yt-dlp')}</li>
    </ol>

    <h3>2 · Shortcut 1: "Reaction Studio" (downloads)</h3>
    <ol>
      <li>Open <b>Shortcuts</b> → tap <b>+</b> (top right). Tap the name at the top → <b>Rename</b> → <b>Reaction Studio</b>.</li>
      <li>Tap the name at the top again (the little <b>⌄</b>) → <b>Details</b> → turn on <b>Show in Share Sheet</b> → Done.</li>
      <li>A block appears at the top: "Receive <b>Any</b> input from Share Sheet". Tap <b>Any</b> → keep only <b>URLs</b> and <b>Text</b>.
        Tap "If there's no input: <b>Continue</b>" → choose <b>Get Clipboard</b>.</li>
      <li>Tap <b>Search Actions</b> at the bottom → type <b>Execute Command</b> → tap the one with the a-Shell icon.</li>
      <li>Tap the blue word <b>Command</b> and paste this (it's 4 lines):
        ${copy(cmd)}
        Then double-tap the word <b>LINK</b> (3rd line) and tap <b>Shortcut Input</b> in the bar above the keyboard. It must stay between the quotes.</li>
      <li>In the same block, set <b>"Open the app to execute the commands?"</b> to <b>Yes</b>.</li>
      <li>Tap <b>‹</b> (top left) to save.</li>
    </ol>

    <h3>3 · Shortcut 2: "ReactionStudioSave" (saves + brings you back)</h3>
    <ol>
      <li>In Shortcuts tap <b>+</b> again. Rename it to exactly this (no spaces):
        ${copy('ReactionStudioSave', 'Copy name')}</li>
      <li>Search Actions → <b>Get File from Folder</b>. Tap <b>Folder</b> → On My iPhone → <b>a-Shell</b> → Open. Tap <b>File Path</b> and type:
        ${copy('reaction-video.mp4')}</li>
      <li>Search Actions → <b>Save to Photo Album</b> (leave it as it is).</li>
      <li>Search Actions → <b>Open URLs</b>. Tap <b>URL</b> and paste this (the <i>x-safari-</i> part makes it open in Safari even if Chrome is your default browser):
        ${copy(back)}</li>
      <li>Leave "Show in Share Sheet" <b>off</b> for this one. Tap <b>‹</b> to save.</li>
    </ol>

    <h3>4 · Try it</h3>
    <ol>
      <li>In Instagram open a <b>Reel</b> → <b>Share</b> → scroll the row of apps (or tap More) → <b>Reaction Studio</b>.</li>
      <li>The first time, tap <b>Allow</b> on each question (a-Shell folder, Photos, opening the website).</li>
      <li>a-Shell shows the download, then Safari opens this app on <b>Tap to choose your video</b>. The new video is the first one in the list.</li>
    </ol>
    <p class="note">If links stop working one day, open a-Shell and run <code>pip install -U yt-dlp</code> (sites change often). Some Instagram videos need a login and won't download. Instagram and TikTok work best; YouTube may not.</p>
    <div class="cap-actions"><button class="btn primary" data-act="done">I've set it up</button></div>
  </div>`;
  body.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => { b.textContent = t; }, 1500); }
    catch { toast('Long-press the text to copy it'); }
  });
  body.querySelector('[data-act="done"]').onclick = () => { save('setupDone', true); closeSheet(); toast('Now share a Reel to "Reaction Studio", or paste a link and tap Get video'); };
}

// ---------------- player + saving to Photos ----------------
let playerItem = null, playerURL = null;
function openPlayer(item) {
  playerItem = item;
  el.src.pause();
  pausePreview();
  el.savePlayer.hidden = item.mode === 'clip';
  el.newReaction.hidden = item.mode !== 'final';
  if (playerURL) URL.revokeObjectURL(playerURL);
  playerURL = item.blob ? URL.createObjectURL(item.blob) : null;
  el.playerVideo.src = playerURL || item.url;
  el.player.hidden = false;
  el.playerVideo.play().catch(() => {});
}
function closePlayer() {
  el.playerVideo.pause(); el.playerVideo.removeAttribute('src'); el.playerVideo.load();
  if (playerURL) { URL.revokeObjectURL(playerURL); playerURL = null; }
  el.player.hidden = true;
}
el.closePlayer.onclick = closePlayer;
el.savePlayer.onclick = () => playerItem && playerItem.blob && saveToPhone(playerItem.blob, playerItem.name);
el.newReaction.onclick = async () => {
  if (!confirm('Start a new reaction? Your clips will be cleared (the finished video stays in My videos).')) return;
  closePlayer();
  resetSession();
  await clearSession();
  show('load');
  checkResume();
};

async function saveToPhone(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) {
      if (e.name === 'AbortError') return;
      if (e.name === 'NotAllowedError') { toast('Tap Save again'); return; }
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function resetSession() {
  for (const c of state.clips) URL.revokeObjectURL(c.url);
  state.clips = [];
  state.resumeOnRec = false;
  state.srcIn = 0; state.srcOut = null; state.srcStrip = null;
  clearOverlays();
  state.cap = { on: false, style: state.cap.style, y: state.cap.y };
  ed.sel = -1; ed.idx = 0;
  undoStack.length = 0; redoStack.length = 0; refreshUndo();
  el.reviewVideo.removeAttribute('src'); el.reviewVideo.dataset.src = ''; el.reviewVideo.load();
  el.src.pause();
  el.resumeBtn.hidden = true;
  renderClips();
}

// ---------------- overlays (photos / videos on top) ----------------
// Each overlay: { id, kind, blob, url, start, dur, vin, natDur, x, y, w, aspect, sound, thumb }
//   start/dur = when it shows on the timeline (seconds); vin = where a video overlay starts playing from
//   x, y = centre (0..1 of the frame); w = width (0..1 of the frame)
const ovMedia = new Map();   // id → <img> or <video>
let ovSel = null;            // selected overlay id
let ovMonitor = null;        // overlay sound to the speakers (muted while saving)

function ovEnsureAudio(o, m) {
  if (o.kind !== 'video' || !ac || m._node) return;
  try {
    m._node = ac.createMediaElementSource(m);
    if (!ovMonitor) { ovMonitor = ac.createGain(); ovMonitor.connect(ac.destination); }
    if (!workDest) workDest = ac.createMediaStreamDestination();
    m._node.connect(ovMonitor);
    m._node.connect(workDest);
  } catch (e) { console.warn('overlay audio', e); }
}

async function loadOverlayMedia(o) {
  if (ovMedia.has(o.id)) return ovMedia.get(o.id);
  let m;
  if (o.kind === 'image') {
    m = new Image();
    m.src = o.url;
    await m.decode().catch(() => once(m, 'load'));
    o.aspect = o.aspect || (m.naturalWidth / m.naturalHeight) || 1;
  } else {
    m = document.createElement('video');
    m.playsInline = true; m.preload = 'auto'; m.className = 'offscreen';
    m.muted = !o.sound;
    document.body.appendChild(m);
    m.src = o.url;
    await Promise.race([once(m, 'loadeddata'), new Promise(r => setTimeout(r, 8000))]);
    o.aspect = o.aspect || (m.videoWidth / m.videoHeight) || 1;
    o.natDur = o.natDur || (Number.isFinite(m.duration) ? m.duration : 5);
    ovEnsureAudio(o, m);
  }
  ovMedia.set(o.id, m);
  return m;
}

const ovById = id => state.overlays.find(o => o.id === id);
const ovActive = (o, tt) => tt >= o.start && tt < o.start + o.dur;
function ovRect(o) {
  const w = o.w * W, h = w / (o.aspect || 1);
  return { x: o.x * W - w / 2, y: o.y * H - h / 2, w, h };
}

function drawOverlays(g2, tt, preview) {
  for (const o of state.overlays) {
    if (!ovActive(o, tt)) continue;
    const m = ovMedia.get(o.id);
    if (!m) continue;
    const r = ovRect(o);
    g2.save();
    g2.shadowColor = 'rgba(0,0,0,.4)'; g2.shadowBlur = 24; g2.shadowOffsetY = 6;
    if ((m.tagName === 'VIDEO' && m.readyState >= 2) || (m.tagName === 'IMG' && m.complete)) {
      g2.drawImage(m, r.x, r.y, r.w, r.h);
    }
    g2.restore();
    if (preview && o.id === ovSel) {
      g2.save();
      g2.lineWidth = 6; g2.strokeStyle = '#fff'; g2.setLineDash([22, 14]);
      g2.strokeRect(r.x - 6, r.y - 6, r.w + 12, r.h + 12);
      g2.restore();
    }
  }
}

// Keep overlay videos in step with the timeline.
function syncOverlays(tt, playing) {
  for (const o of state.overlays) {
    if (o.kind !== 'video') continue;
    const m = ovMedia.get(o.id);
    if (!m) continue;
    m.muted = !o.sound;
    if (!ovActive(o, tt)) { if (!m.paused) m.pause(); continue; }
    const want = o.vin + (tt - o.start);
    if (playing) {
      if (Math.abs(m.currentTime - want) > 0.35) m.currentTime = want;
      if (m.paused) m.play().catch(() => {});
    } else {
      if (!m.paused) m.pause();
      if (Math.abs(m.currentTime - want) > 0.05) m.currentTime = want;
    }
  }
}
function pauseOverlays() { for (const m of ovMedia.values()) if (m.tagName === 'VIDEO') m.pause(); }

// add
el.ovAddBtn.onclick = () => { pausePreview(); el.ovInput.click(); };
el.ovInput.onchange = async () => {
  const f = el.ovInput.files[0];
  el.ovInput.value = '';
  if (!f) return;
  ensureAudio();
  const kind = f.type.startsWith('video') ? 'video' : 'image';
  const total = totalLen();
  const start = clamp(timelineTime(), 0, Math.max(0, total - 0.5));
  const o = { id: uid(), kind, blob: f, url: URL.createObjectURL(f), start, dur: 3, vin: 0, x: 0.5, y: 0.33, w: 0.55, sound: false };
  busy(true, 'Adding overlay…');
  try {
    const m = await loadOverlayMedia(o);
    o.dur = Math.max(0.5, Math.min(kind === 'video' ? o.natDur : 3, total - start));
    if (o.aspect < 0.8) o.w = 0.42; // tall things a bit narrower
    o.thumb = thumbOf(m, o.aspect);
  } catch (e) { busy(false); toast('Couldn\'t open that file.'); return; }
  busy(false);
  pushUndo();
  state.overlays.push(o);
  Store.set('ov:' + o.id, { blob: o.blob }).catch(() => toast('Phone storage is full — the overlay won\'t survive closing the app.'));
  selectOverlay(o.id);
  renderOvLane();
  saveSession();
  toast('Drag it to move · pinch to resize');
};
function thumbOf(m, aspect) {
  try {
    const c = document.createElement('canvas');
    c.height = 64; c.width = Math.round(64 * (aspect || 1));
    c.getContext('2d').drawImage(m, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6);
  } catch { return ''; }
}

// select / panel
function selectOverlay(id) {
  ovSel = id;
  const o = id && ovById(id);
  el.ovPanel.hidden = !o;
  if (o) {
    if (ed.sel >= 0) selectClip(-1);
    el.clipPanel.hidden = true;
    el.tlTip.hidden = true;
    el.ovTitle.textContent = `${o.kind === 'video' ? 'Video' : 'Photo'} overlay · ${o.dur.toFixed(1)}s`;
    el.ovSound.hidden = o.kind !== 'video';
    el.ovSound.textContent = o.sound ? 'Sound on' : 'Sound off';
    el.ovSize.value = Math.round(o.w * 100);
    // jump to where it shows
    const tt = timelineTime();
    if (!ovActive(o, tt)) seekTimeline(o.start + 0.05);
  } else if (ed.sel < 0) el.tlTip.hidden = false;
  renderOvLane();
  if (!ed.playing) drawPreviewLayer(timelineTime());
  // make sure its bar is on screen when the timeline is zoomed in
  const bar = o && el.ovLane.querySelector(`[data-id="${o.id}"]`);
  if (bar && ed.zoom > 1) {
    const v = el.timeline;
    if (bar.offsetLeft < v.scrollLeft || bar.offsetLeft + Math.min(bar.offsetWidth, v.clientWidth) > v.scrollLeft + v.clientWidth) v.scrollLeft = bar.offsetLeft - 24;
  }
}
el.ovDone.onclick = () => selectOverlay(null);
el.ovDelete.onclick = () => {
  const o = ovById(ovSel);
  if (!o) return;
  pushUndo();
  removeOverlay(o);
};
function removeOverlay(o) {
  state.overlays = state.overlays.filter(x => x !== o);
  const m = ovMedia.get(o.id);
  if (m && m.tagName === 'VIDEO') m.pause(); // kept so Undo can bring it back
  selectOverlay(null);
  saveSession();
}
el.ovSound.onclick = () => {
  const o = ovById(ovSel); if (!o) return;
  pushUndo();
  o.sound = !o.sound;
  el.ovSound.textContent = o.sound ? 'Sound on' : 'Sound off';
  saveSession();
};
el.ovFront.onclick = () => {
  const o = ovById(ovSel); if (!o) return;
  pushUndo();
  state.overlays = state.overlays.filter(x => x !== o).concat(o);
  renderOvLane(); saveSession();
  if (!ed.playing) drawPreviewLayer(timelineTime());
};
el.ovSize.addEventListener('pointerdown', () => { if (ovById(ovSel)) pushUndo(); });
el.ovSize.oninput = () => {
  const o = ovById(ovSel); if (!o) return;
  o.w = el.ovSize.value / 100;
  if (!ed.playing) drawPreviewLayer(timelineTime());
};
el.ovSize.onchange = () => saveSession();

// the overlay lane under the clips: bars you drag in time
function renderOvLane() {
  const total = totalLen() || 1;
  el.ovLane.hidden = !state.overlays.length;
  el.ovLane.innerHTML = '';
  state.overlays.forEach(o => {
    const bar = document.createElement('div');
    bar.className = 'ov-bar' + (o.id === ovSel ? ' sel' : '');
    bar.dataset.id = o.id;
    bar.style.left = (o.start / total * 100) + '%';
    bar.style.width = (Math.min(o.dur, total - o.start) / total * 100) + '%';
    if (o.thumb) bar.style.backgroundImage = `url("${o.thumb}")`;
    bar.innerHTML = '<i class="e l"></i><i class="e r"></i>';
    el.ovLane.appendChild(bar);
  });
}
let ovLaneDrag = null;
el.ovLane.addEventListener('pointerdown', e => {
  const bar = e.target.closest('.ov-bar');
  if (!bar) return;
  e.stopPropagation();
  el.ovLane.setPointerCapture(e.pointerId);
  const o = ovById(bar.dataset.id);
  const r = bar.getBoundingClientRect();
  const mode = e.clientX - r.left < 16 ? 'l' : (r.right - e.clientX < 16 ? 'r' : 'move');
  ovLaneDrag = { o, mode, x0: e.clientX, start: o.start, dur: o.dur, vin: o.vin, laneW: el.ovLane.getBoundingClientRect().width, moved: false };
  pausePreview();
});
el.ovLane.addEventListener('pointermove', e => {
  const d = ovLaneDrag; if (!d) return;
  const dt = (e.clientX - d.x0) / d.laneW * totalLen();
  if (!d.moved && Math.abs(e.clientX - d.x0) > 6) { d.moved = true; pushUndo(); }
  if (!d.moved) return;
  const o = d.o, total = totalLen();
  const maxDur = o.kind === 'video' ? o.natDur - o.vin : Infinity;
  if (d.mode === 'move') o.start = clamp(d.start + dt, 0, Math.max(0, total - 0.3));
  else if (d.mode === 'r') o.dur = clamp(d.dur + dt, 0.5, Math.min(total - o.start, o.kind === 'video' ? o.natDur - o.vin : 60));
  else {
    // left edge: later start, shorter; a video also skips its first part
    const delta = clamp(dt, -Math.min(d.start, o.kind === 'video' ? d.vin : d.start), d.dur - 0.5);
    o.start = d.start + delta; o.dur = d.dur - delta;
    if (o.kind === 'video') o.vin = d.vin + delta;
  }
  if (o.dur > maxDur) o.dur = maxDur;
  renderOvLane();
  seekTimeline(d.mode === 'r' ? o.start + o.dur - 0.05 : o.start + 0.02);
  syncOverlays(o.start + 0.02, false);
});
const endOvLane = () => {
  const d = ovLaneDrag; if (!d) return;
  ovLaneDrag = null;
  selectOverlay(d.o.id);
  if (d.moved) saveSession();
};
el.ovLane.addEventListener('pointerup', endOvLane);
el.ovLane.addEventListener('pointercancel', endOvLane);

// save / load
const ovMeta = o => ({ id: o.id, kind: o.kind, start: o.start, dur: o.dur, vin: o.vin, natDur: o.natDur, x: o.x, y: o.y, w: o.w, aspect: o.aspect, sound: o.sound, thumb: o.thumb });
async function restoreOverlays(list) {
  state.overlays = [];
  for (const meta of list || []) {
    const data = await Store.get('ov:' + meta.id).catch(() => null);
    if (!data) continue;
    const o = { ...meta, blob: data.blob, url: URL.createObjectURL(data.blob) };
    state.overlays.push(o);
    loadOverlayMedia(o).catch(() => {});
  }
}
function clearOverlays() {
  for (const m of ovMedia.values()) if (m.tagName === 'VIDEO') { m.pause(); m.removeAttribute('src'); m.load(); m.remove(); }
  for (const o of state.overlays) URL.revokeObjectURL(o.url);
  ovMedia.clear();
  state.overlays = [];
  ovSel = null;
}

// ---------------- misc ----------------
el.backBtn.onclick = async () => {
  if (state.clips.length) {
    // clips are saved on the phone, so going home is safe
    stopRec();
    saveSession(true);
    show('load');
    checkResume();
    return;
  }
  stopRec();
  show('load');
};

document.addEventListener('keydown', e => {
  if (!el.studio.classList.contains('active') || e.target.tagName === 'INPUT' || e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.key === 'r' || e.key === 'R') state.recording ? stopRec() : startRec();
});

async function requestWakeLock() { try { await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (el.studio.classList.contains('active') || el.review.classList.contains('active'))) requestWakeLock();
  if (document.visibilityState === 'hidden') {
    if (state.recording) stopRec(); // phones freeze the page in the background
    if (rendering) { renderAbort = true; toast('Saving stopped because the app went to the background. Tap Save again.', 6000); }
    saveSession(true);
  }
});

setTimeout(() => {
  if (load('hinted', false)) return;
  const showHint = () => {
    if (!el.studio.classList.contains('active')) return setTimeout(showHint, 800);
    el.hint.classList.add('show');
    setTimeout(() => el.hint.classList.remove('show'), 3500);
    save('hinted', true);
  };
  showHint();
}, 500);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

renderClips();
checkResume();
