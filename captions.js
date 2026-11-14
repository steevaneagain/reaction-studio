'use strict';
/* Captions: turn a clip's mic audio into words (on the phone), group them into short lines,
   and draw them onto a canvas — the same drawing is used for the preview and the saved video. */
const Captions = (() => {
  let worker = null, seq = 0;
  const pending = new Map();
  let progressFn = null;
  const files = new Map(); // model download progress per file

  function getWorker() {
    if (worker) return worker;
    worker = new Worker('captions-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        const p = data.p || {};
        if (p.file && p.total) files.set(p.file, { loaded: p.loaded || 0, total: p.total });
        if (p.status === 'done' && p.file && files.has(p.file)) files.get(p.file).loaded = files.get(p.file).total;
        let loaded = 0, total = 0;
        for (const f of files.values()) { loaded += f.loaded; total += f.total; }
        if (progressFn && total) progressFn({ phase: 'download', frac: loaded / total, mb: total / 1e6 });
        return;
      }
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      data.type === 'done' ? job.resolve(data.words) : job.reject(new Error(data.error));
    };
    worker.onerror = e => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'The caption engine could not start.'));
      pending.clear();
      worker = null;
    };
    return worker;
  }

  function run(audio) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, audio }, audio ? [audio.buffer] : []);
    });
  }

  // Decode any audio/video blob to 16 kHz mono floats (what Whisper wants).
  async function audioFrom(blob, ctx) {
    const own = !ctx;
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    try {
      const buf = await new Promise((res, rej) => {
        blob.arrayBuffer().then(ab => {
          const p = ctx.decodeAudioData(ab, res, rej);
          if (p && p.then) p.then(res, rej);
        }, rej);
      });
      const n = buf.length, ch = buf.numberOfChannels;
      const mono = new Float32Array(n);
      for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ch; }
      const ratio = buf.sampleRate / 16000;
      const outLen = Math.floor(n / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        // average the samples that fall into this output sample (simple low-pass + resample)
        const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
        let s = 0;
        for (let j = a; j < b; j++) s += mono[j];
        out[i] = b > a ? s / (b - a) : mono[a] || 0;
      }
      return out;
    } finally { if (own) ctx.close?.(); }
  }

  async function transcribe(blob, ctx) {
    const audio = await audioFrom(blob, ctx);
    if (audio.length < 16000 * 0.3) return [];
    return run(audio);
  }

  // Short punchy lines: up to 3 words / ~18 letters, new line on pauses and sentence ends.
  function toLines(words) {
    const lines = [];
    let cur = null;
    for (const w of words) {
      const last = cur && cur.words[cur.words.length - 1];
      const text = cur ? cur.words.map(x => x.w).join(' ') + ' ' + w.w : w.w;
      if (!cur || w.s - cur.e > 0.6 || cur.words.length >= 3 || text.length > 18 || /[.!?,;:]$/.test(last.w)) {
        cur = { s: w.s, e: w.e, words: [{ ...w }] };
        lines.push(cur);
      } else {
        cur.words.push({ ...w });
        cur.e = w.e;
      }
    }
    return lines;
  }

  // After typing a fix: spread the new words over the line's time, by length.
  function setLineText(line, text) {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) { line.words = []; return; }
    const total = parts.reduce((s, p) => s + p.length + 1, 0);
    let t = line.s;
    const span = Math.max(line.e - line.s, 0.3);
    line.words = parts.map(p => {
      const d = span * (p.length + 1) / total;
      const w = { w: p, s: t, e: t + d };
      t += d;
      return w;
    });
  }

  // ---------- drawing ----------
  const FONT = '-apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif';
  const STYLES = {
    pop:   { upper: true,  size: 78, weight: 900, fill: '#ffffff', hi: '#ffe14d', stroke: '#000000', strokeW: 16 },
    box:   { upper: false, size: 62, weight: 800, fill: '#ffffff', hi: '#ff3b4e', box: 'rgba(0,0,0,0.82)' },
    clean: { upper: false, size: 60, weight: 700, fill: '#ffffff', shadow: true },
    pill:  { upper: true,  size: 72, weight: 900, fill: '#ffffff', hiText: '#ffffff', pill: '#7c3aed', stroke: '#000000', strokeW: 12 },
    single:{ upper: true,  size: 120, weight: 900, fill: '#ffe14d', stroke: '#000000', strokeW: 20, single: true },
    reveal:{ upper: false, size: 68, weight: 800, fill: '#ffffff', hi: '#3ddc84', stroke: '#000000', strokeW: 12, reveal: true },
    neon:  { upper: true,  size: 74, weight: 900, fill: '#e9fbff', hi: '#ff4fd8', glow: '#22d3ee' },
  };

  // ---------- stacked "editorial" styles ----------
  // One key word big, the rest small around it, mixed colours, some serif italics.
  const SERIF = 'ui-serif, "New York", Georgia, "Times New Roman", serif';
  const C = { y: '#ffe500', t: '#2ee6d6', w: '#ffffff', r: '#ff453a' };
  const STACKED = {
    stack:   { lead: C.w, key: C.y, tail: C.w, align: 'left',    keyScale: 2.3 },
    tealbig: { lead: C.w, key: C.t, tail: C.y, align: 'right',   keyScale: 2.5 },
    serif:   { lead: C.t, key: C.y, tail: C.w, align: 'cascade', keyScale: 1.9, keySerif: true },
    cascade: { lead: C.t, key: C.y, tail: C.w, align: 'cascade', keyScale: 1.5, mixLead: true },
    punch:   { lead: C.w, key: C.t, tail: C.w, align: 'center',  keyScale: 2.4, grow: true },
    glow:    { lead: C.w, key: C.w, tail: C.t, align: 'left',    keyScale: 2.7, keySerif: true, glow: true },
    tri:     { rowColors: [C.t, C.w, C.y, C.r], align: 'center', keyScale: 1.9 },
    cursor:  { lead: C.y, key: C.t, tail: C.w, align: 'center',  keyScale: 2.1, cursor: true, inlineLead: true },
  };
  const STOP = new Set(("a an the and or but so to of in on at for with from by is are was were be been am i i'm im you you're your we our " +
    "they their it it's its this that these those my me he she his her them us what how why when where who which there here just do does " +
    "did not no yes if then than as up out about into over like can will would should could get got have has had let let's oh okay ok um uh " +
    "yeah wait gonna really very").split(' '));
  const clean = w => w.toLowerCase().replace(/[^a-z0-9']/g, '');

  function pickKey(words) {
    let best = 0, score = -1;
    words.forEach((w, i) => {
      const c = clean(w.w);
      const s = (STOP.has(c) ? 0.3 : 1) * c.length + (/\d/.test(c) ? 4 : 0) + i * 0.01; // later word wins ties
      if (s > score) { score = s; best = i; }
    });
    return best;
  }

  function buildRows(words, cfg, base) {
    const k = pickKey(words);
    const lead = words.slice(0, k), tail = words.slice(k + 1);
    const rows = [];
    const keyItem = { w: words[k], role: 'key', size: base * cfg.keyScale };
    const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
    if (cfg.inlineLead && lead.length && lead.length <= 2) {
      rows.push([...lead.map(w => ({ w, role: 'lead', size: base * 0.85 })), keyItem]);
    } else {
      const leadRows = chunks(lead, 3);
      leadRows.forEach((r, i) => rows.push(r.map((w, j) => ({
        w, role: cfg.mixLead && j === r.length - 1 ? 'tail' : 'lead',
        size: base * (cfg.grow ? 0.8 + 0.35 * (i / Math.max(1, leadRows.length - 1)) * (leadRows.length > 1 ? 1 : 0) : 1),
      }))));
      rows.push([keyItem]);
    }
    if (tail.length) {
      const first = tail.slice(0, Math.min(3, tail.length));
      rows.push(first.map(w => ({ w, role: 'tail', size: base * 1.15 })));
      chunks(tail.slice(first.length), 4).forEach(r => rows.push(r.map(w => ({ w, role: 'tail', size: base * 0.8 }))));
    }
    return rows;
  }

  function drawStacked(g, line, t, cfg, y, W, H) {
    const words = line.words;
    const base = 58 * (W / 1080);
    const rows = buildRows(words, cfg, base);
    const fontOf = it => it.role === 'key' && cfg.keySerif
      ? `italic 500 ${it.size}px ${SERIF}`
      : `${it.role === 'key' ? 900 : 800} ${it.size}px ${FONT}`;
    // measure
    let blockW = 0;
    const metrics = rows.map(r => {
      let w = 0;
      r.forEach((it, i) => {
        g.font = fontOf(it);
        it.width = g.measureText(it.w.w).width;
        it.space = it.size * 0.26;
        w += it.width + (i ? it.space : 0);
      });
      const h = Math.max(...r.map(it => it.size));
      blockW = Math.max(blockW, w);
      return { w, h };
    });
    const maxW = W * 0.86;
    const fit = blockW > maxW ? maxW / blockW : 1;
    const totalH = metrics.reduce((s, m) => s + m.h * 0.98, 0);
    g.save();
    // shrink to fit, around the caption's centre
    const cy = y * H;
    g.translate(W / 2, cy); g.scale(fit, fit); g.translate(-W / 2, -cy);
    let top = cy - totalH / 2;
    const box = { x1: W, y1: H, x2: 0, y2: 0 };
    rows.forEach((r, ri) => {
      const m = metrics[ri];
      const rowH = m.h * 0.98;
      const baseY = top + rowH * 0.82;
      const left = (W - blockW) / 2;
      let x;
      if (cfg.align === 'left') x = left;
      else if (cfg.align === 'right') x = left + blockW - m.w;
      else if (cfg.align === 'cascade') x = left + (blockW - m.w) * (rows.length > 1 ? ri / (rows.length - 1) : 0.5);
      else x = (W - m.w) / 2;
      box.x1 = Math.min(box.x1, x - 20); box.x2 = Math.max(box.x2, x + m.w + 20);
      box.y1 = Math.min(box.y1, top); box.y2 = Math.max(box.y2, top + rowH);
      r.forEach((it, i) => {
        if (i) x += it.space;
        // words appear as they're said (fade + small rise)
        const a = clamp01((t - it.w.s + 0.05) / 0.18);
        if (a > 0) {
          g.save();
          g.globalAlpha = a;
          g.font = fontOf(it);
          g.textBaseline = 'alphabetic';
          const color = cfg.rowColors ? cfg.rowColors[ri % cfg.rowColors.length] : cfg[it.role];
          const yy = baseY + (1 - a) * 18;
          g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 12; g.shadowOffsetY = 2;
          if (cfg.glow && it.role === 'key') {
            g.shadowColor = 'rgba(255,255,255,0.95)'; g.shadowBlur = 44; g.shadowOffsetY = 0;
            g.fillStyle = color; g.fillText(it.w.w, x, yy);
          }
          g.fillStyle = color;
          g.fillText(it.w.w, x, yy);
          if (cfg.cursor && it.role === 'key' && Math.floor(t * 2.2) % 2 === 0) {
            g.shadowColor = 'transparent';
            g.fillRect(x + it.width + it.size * 0.08, yy - it.size * 0.78, Math.max(4, it.size * 0.06), it.size * 0.92);
          }
          g.restore();
        }
        x += it.width;
      });
      top += rowH;
    });
    g.restore();
    return box;
  }
  const clamp01 = v => Math.max(0, Math.min(1, v));

  // Stacked styles look best with longer phrases: join short lines that follow each other closely.
  function groupPhrases(lines) {
    const out = [];
    for (const L of lines) {
      const prev = out[out.length - 1];
      const lastWord = prev && prev.words[prev.words.length - 1].w;
      if (prev && L.s - prev.e < 0.7 && prev.words.length + L.words.length <= 7 && !/[.!?,;:]$/.test(lastWord)) {
        prev.words = prev.words.concat(L.words);
        prev.e = L.e;
        prev.refs.push(L.ref);
      } else out.push({ ...L, words: L.words.slice(), refs: [L.ref] });
    }
    return out;
  }

  const STYLE_LIST = [
    ['pop', 'Big pop'], ['pill', 'Highlight'], ['single', 'One word'], ['reveal', 'Word by word'], ['neon', 'Neon'],
    ['box', 'Box'], ['clean', 'Clean'],
    ['stack', 'Stack'], ['tealbig', 'Big teal'], ['serif', 'Serif mix'], ['cascade', 'Cascade'],
    ['punch', 'Punch'], ['glow', 'Glow'], ['tri', 'Tri-colour'], ['cursor', 'Cursor'],
  ];

  // hi = your highlight colour (null = the style's own). It colours the spoken / key word.
  function draw(g, line, t, styleName, y, W, H, hi) {
    if (!line || !line.words.length) return null;
    if (STACKED[styleName]) {
      const cfg = STACKED[styleName];
      return drawStacked(g, line, t, hi ? { ...cfg, key: hi, rowColors: cfg.rowColors && [hi, ...cfg.rowColors.slice(1)] } : cfg, y, W, H);
    }
    let st = STYLES[styleName] || STYLES.pop;
    if (hi) {
      st = { ...st };
      if (st.pill) st.pill = hi;
      else if (st.single) st.fill = hi;
      else st.hi = hi;
    }
    const age = t - line.s;
    const scale = age < 0.12 ? 0.88 + 0.12 * (age / 0.12) : 1; // tiny pop-in
    g.save();
    g.font = `${st.weight} ${st.size}px ${FONT}`;
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    let words = line.words.map(w => ({ ...w, text: st.upper ? w.w.toUpperCase() : w.w }));
    if (st.single) { // one big word at a time
      let k = 0;
      words.forEach((w, i) => { if (t >= w.s) k = i; });
      words = [words[k]];
    }
    const space = g.measureText(' ').width;
    // wrap into rows that fit
    const maxW = W * 0.84;
    const rows = [[]];
    let rowW = 0;
    for (const w of words) {
      w.width = g.measureText(w.text).width;
      const add = (rows[rows.length - 1].length ? space : 0) + w.width;
      if (rowW + add > maxW && rows[rows.length - 1].length) { rows.push([]); rowW = 0; }
      rows[rows.length - 1].push(w);
      rowW += (rows[rows.length - 1].length > 1 ? space : 0) + w.width;
    }
    const lh = st.size * 1.22;
    const cy = y * H;
    g.translate(W / 2, cy);
    g.scale(scale, scale);
    g.translate(-W / 2, -cy);
    let current = -1;
    words.forEach((w, i) => { if (t >= w.s) current = i; });
    const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    rows.forEach((row, r) => {
      const width = row.reduce((s, w, i) => s + w.width + (i ? space : 0), 0);
      let x = (W - width) / 2;
      const ry = cy + (r - (rows.length - 1) / 2) * lh;
      if (st.box) {
        const px = 22, py = st.size * 0.62;
        g.fillStyle = st.box;
        roundRect(g, x - px, ry - py, width + px * 2, py * 2, 18);
        g.fill();
      }
      box.x1 = Math.min(box.x1, x - 24); box.x2 = Math.max(box.x2, x + width + 24);
      box.y1 = Math.min(box.y1, ry - lh / 2); box.y2 = Math.max(box.y2, ry + lh / 2);
      for (const w of row) {
        const idx = words.indexOf(w);
        const isCur = idx === current;
        if (st.reveal && idx > current) { x += w.width + space; continue; } // not said yet
        if (st.pill && isCur) {
          g.fillStyle = st.pill;
          roundRect(g, x - 14, ry - st.size * 0.6, w.width + 28, st.size * 1.2, 16);
          g.fill();
        }
        if (st.stroke && !(st.pill && isCur)) { g.lineWidth = st.strokeW; g.strokeStyle = st.stroke; g.strokeText(w.text, x, ry); }
        if (st.shadow) { g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = 14; g.shadowOffsetY = 3; }
        if (st.glow) { g.shadowColor = isCur ? st.hi : st.glow; g.shadowBlur = 28; g.shadowOffsetY = 0; }
        g.fillStyle = isCur ? (st.hiText || st.hi || st.fill) : st.fill;
        g.fillText(w.text, x, ry);
        if (st.glow) g.fillText(w.text, x, ry); // second pass = stronger glow
        g.shadowColor = 'transparent';
        x += w.width + space;
      }
    });
    g.restore();
    return box;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  return {
    transcribe, toLines, setLineText, draw, STYLES, STYLE_LIST, groupPhrases,
    isStacked: name => !!STACKED[name],
    onProgress(fn) { progressFn = fn; },
    warmUp() { return run(null); },
  };
})();
