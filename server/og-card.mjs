// server/og-card.mjs
// "Acid Deck" social card: a record-label release card crossed with a
// drum-machine display. Self-contained 1200×630 HTML (inline CSS + Google Fonts,
// no app bundle) rendered to a PNG by server/render-card.mjs. Two motifs are
// generated deterministically from the song's content — an oscilloscope waveform
// ("the sound") and a 16-step sequencer grid ("the pattern") — so every track
// gets a unique, recognizable card that reads even as a chat thumbnail.
import { escapeHtml } from './og.mjs';

const FONTS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300..800&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

const SHELL = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="${FONTS}" rel="stylesheet" />
<style>
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  .card {
    --bg:#0c0d0a; --ink:#e9edda; --dim:#7c856e; --acid:#c8f53c; --hot:#ff5ca8; --line:#2b2f20;
    position:relative; width:1200px; height:630px; overflow:hidden;
    background:
      radial-gradient(1300px 620px at 82% -22%, #202a12 0%, transparent 58%),
      radial-gradient(900px 500px at 8% 118%, #1a1320 0%, transparent 55%),
      var(--bg);
    color:var(--ink); font-family:'IBM Plex Mono', monospace;
  }
  .card::before { content:""; position:absolute; inset:0; pointer-events:none;
    background:repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,.018) 3px 4px);
    mix-blend-mode:overlay; }
  .card::after { content:""; position:absolute; inset:0; pointer-events:none; opacity:.45;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E");
    mix-blend-mode:soft-light; }
  .code { position:absolute; inset:0; padding:54px 60px; z-index:0;
    font-size:26px; line-height:1.55; white-space:pre-wrap; word-break:break-word;
    color:var(--acid); opacity:.10; pointer-events:none; user-select:none;
    -webkit-mask-image:linear-gradient(165deg, #000 0%, #000 34%, transparent 70%);
            mask-image:linear-gradient(165deg, #000 0%, #000 34%, transparent 70%); }
  .scope { position:absolute; left:0; right:0; top:150px; height:220px; z-index:1; pointer-events:none; opacity:.32; }
  .scope svg { width:100%; height:100%; display:block; }
  .scope path { fill:none; stroke:var(--acid); stroke-width:3; stroke-linejoin:round; stroke-linecap:round;
    filter:drop-shadow(0 0 8px rgba(200,245,60,.6)); }
  .scope .base { stroke:var(--line); stroke-width:2; opacity:.7; filter:none; }
  .frame { position:absolute; inset:0; z-index:2; padding:56px 60px 0; display:flex; flex-direction:column; height:100%; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; }
  .wordmark { font-family:'Bricolage Grotesque', sans-serif; font-weight:800; font-size:27px; letter-spacing:-.02em; line-height:1; }
  .wordmark b { color:var(--acid); }
  .cat { text-align:right; font-size:18px; line-height:1.5; letter-spacing:.14em; color:var(--dim); text-transform:uppercase; }
  .cat .k { color:var(--acid); }
  .hero { margin-top:auto; }
  .kicker { display:flex; align-items:center; gap:12px; margin-bottom:16px; font-size:19px; letter-spacing:.2em; text-transform:uppercase; color:var(--dim); }
  .kicker .dot { width:9px; height:9px; border-radius:50%; background:var(--acid); box-shadow:0 0 14px var(--acid); }
  .title { font-family:'Bricolage Grotesque', sans-serif; font-weight:800;
    font-size:104px; line-height:.92; letter-spacing:-.035em; max-width:980px; text-wrap:balance;
    overflow:hidden; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
  .by { margin-top:18px; font-size:25px; color:var(--ink); }
  .by span { color:var(--hot); }
  .seq { margin-top:30px; display:flex; flex-direction:column; gap:9px; }
  .seqrow { display:flex; align-items:center; gap:14px; }
  .seqlbl { width:42px; font-size:15px; letter-spacing:.12em; color:var(--dim); }
  .steps { display:grid; grid-template-columns:repeat(16, 1fr); gap:7px; flex:1; }
  .step { height:18px; border-radius:3px; background:#171a11; border:1px solid var(--line); }
  .step.beat { border-color:#3a4029; }
  .step.on { background:var(--acid); border-color:var(--acid); box-shadow:0 0 12px rgba(200,245,60,.55); }
  .step.on.hot { background:var(--hot); border-color:var(--hot); box-shadow:0 0 12px rgba(255,92,168,.5); }
  .foot { margin-top:30px; margin-bottom:36px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .chip { font-size:23px; padding:9px 20px; border:2px solid var(--line); border-radius:999px; color:var(--ink); background:rgba(19,21,14,.65); }
  .chip.lead { border-color:var(--acid); color:var(--acid); }
  .bar { position:absolute; left:0; right:0; bottom:0; height:12px; z-index:3;
    background:linear-gradient(90deg, var(--acid) 0%, var(--acid) 62%, var(--hot) 100%); }
</style></head><body><div class="card">${body}<div class="bar"></div></div></body></html>`;

// FNV-1a seed → mulberry32 PRNG. Deterministic for a given seed string.
function rng(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
}

const seedOf = (item) => `${item.title ?? ''}|${item.code ?? ''}|${item.meta?.genre ?? ''}|${item.meta?.bpm ?? ''}`;

// 16 deterministic step hits at the given density; downbeats (every 4th) biased on.
export function seqRow(seed, density) {
  const r = rng(seed);
  return Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? r() < density + 0.25 : r() < density));
}

// Oscilloscope path ('d') in a 1200×220 viewBox: four seeded sines summed under a
// sine envelope so the line tapers at both ends. Deterministic per seed.
export function scopePath(seed) {
  const r = rng(seed);
  const W = 1200, mid = 110, N = 120, pad = 60, step = (W - pad * 2) / N;
  const waves = Array.from({ length: 4 }, () => ({ f: 0.4 + r() * 3.2, p: r() * 6.28, a: r() }));
  const amp = waves.reduce((s, w) => s + w.a, 0) || 1;
  let d = `M ${pad} ${mid}`;
  for (let i = 1; i <= N; i++) {
    const x = pad + i * step, t = (i / N) * 6.28;
    let y = 0; for (const w of waves) y += w.a * Math.sin(t * w.f * 2 + w.p);
    const env = Math.sin((i / N) * Math.PI);
    d += ` L ${x.toFixed(1)} ${(mid - (y / amp) * 88 * env).toFixed(1)}`;
  }
  return d;
}

function stepsHtml(row, hot) {
  return row
    .map((on, i) => `<div class="step${i % 4 === 0 ? ' beat' : ''}${on ? (hot ? ' on hot' : ' on') : ''}"></div>`)
    .join('');
}

function scopeSvg(seed) {
  return `<div class="scope"><svg viewBox="0 0 1200 220" preserveAspectRatio="none">
      <line class="base" x1="60" y1="110" x2="1140" y2="110" />
      <path d="${scopePath(seed)}" /></svg></div>`;
}

function seqHtml(seed) {
  return `<div class="seq">
        <div class="seqrow"><div class="seqlbl">KCK</div><div class="steps">${stepsHtml(seqRow(seed + ':kick', 0.32), false)}</div></div>
        <div class="seqrow"><div class="seqlbl">HAT</div><div class="steps">${stepsHtml(seqRow(seed + ':hat', 0.5), true)}</div></div>
      </div>`;
}

// Cap the backdrop so it stays legible + the screenshot stays fast/small.
export function codeArt(code) {
  return escapeHtml(String(code ?? '').slice(0, 1100));
}

export function chipsHtml(meta = {}) {
  const items = [meta.genre, meta.bpm && `${meta.bpm} bpm`, meta.key, meta.mood].filter(Boolean);
  return items
    .map((v, i) => `<span class="chip${i === 0 ? ' lead' : ''}">${escapeHtml(v)}</span>`)
    .join('');
}

export function songCardHtml(item) {
  const seed = seedOf(item);
  const meta = item.meta ?? {};
  const artist = item.artistName
    ? `<div class="by">by <span>${escapeHtml(item.artistName)}</span></div>` : '';
  const kicker = meta.genre ? escapeHtml(meta.genre) : 'from the crate';
  return SHELL(`
    <div class="code">${codeArt(item.code)}</div>
    ${scopeSvg(seed)}
    <div class="frame">
      <div class="top">
        <div class="wordmark">STRUDEL<b>/</b>CRATE</div>
        <div class="cat">CRATE · ${escapeHtml(String(meta.bpm ?? '—'))} BPM<br /><span class="k">${escapeHtml(meta.key ?? '∞')}</span></div>
      </div>
      <div class="hero">
        <div class="kicker"><span class="dot"></span> ${kicker}</div>
        <div class="title">${escapeHtml(item.title || 'untitled')}</div>
        ${artist}
        ${seqHtml(seed)}
        <div class="foot">${chipsHtml(meta)}</div>
      </div>
    </div>`);
}

export function brandCardHtml() {
  const seed = 'STRUDEL/CRATE/deck';
  return SHELL(`
    ${scopeSvg(seed)}
    <div class="frame">
      <div class="top">
        <div class="wordmark">STRUDEL<b>/</b>CRATE</div>
        <div class="cat">A CRATE OF<br /><span class="k">CODE-MUSIC</span></div>
      </div>
      <div class="hero">
        <div class="kicker"><span class="dot"></span> live-coded with strudel</div>
        <div class="title">AI music<br />you remix<br />in code</div>
        ${seqHtml(seed)}
        <div class="foot"><span class="chip lead">play</span><span class="chip">remix</span><span class="chip">export</span></div>
      </div>
    </div>`);
}
