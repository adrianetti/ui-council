#!/usr/bin/env node
// UI council helper for the /ui-council skill.
// - capture: screenshots plus objective design checks (contrast, overflow, token drift)
// - judge:   external judges (Codex CLI, Antigravity CLI `agy`, Gemini CLI) score the
//            screenshots blind and compare them with the last accepted round
// - prompt:  prompts for the Claude subagent judges
// - tally:   pass rules, regression detection, and the NEXT step
// Run it from the project root. All state lives in ./council.

import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative, extname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = fileURLToPath(new URL('.', import.meta.url));
const DIR = resolve('council');
// Pinned so the browser build matches the one this Playwright version expects.
const PLAYWRIGHT = 'playwright@1.61.1';
const RUNTIME = join(SKILL_DIR, '.runtime');
const JUDGE_TIMEOUT_MS = 15 * 60 * 1000;
const EXTERNAL = ['codex', 'agy', 'gemini'];
// agy can also run Claude and GPT models. Keep a Gemini model so the council has a third provider.
const AGY_MODEL = 'gemini-4-argon-high';
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const CATEGORIES = {
  hierarchy: 'The most important thing on each screen is obvious; secondary items recede.',
  typography: 'Font choice, a small clear type scale, weights, line height, readable body text.',
  color_contrast: 'Readable contrast in every theme; purposeful accent color; not washed out, muddy, or flat gray.',
  spacing_layout: 'Consistent spacing rhythm, alignment, and a density that fits the task.',
  consistency: 'The same thing looks and is named the same everywhere: radii, borders, buttons, labels, indicators.',
  iconography: 'Icons are clear, share one style and weight, and are sized and aligned with their text.',
  affordance: 'Interactive elements look interactive; the primary action stands out; hover, focus, selected and disabled states are clear.',
  taste: "Carries out the product's own design language with care and distinction; never generic. Choices the language calls for are not flaws.",
};
const CAT_KEYS = Object.keys(CATEGORIES);

// Taste exam defaults. Judges below either bar stop counting toward a pass.
// skip: recipe names to leave out, for tells the design language uses on purpose.
const DEFAULT_EXAM = { size: 12, historyPairs: 4, minAgreement: 0.75, minConsistency: 0.75, skip: [] };

// Ways to make a screen worse, for the taste exam. The original is the right answer.
// "flaw": worse under any taste. "tell": worse under the taste rules (generic AI-template look).
// "style": the screen's own design language swapped for a generic kit. Only a design that
// already carries its language well is a fair original, so these need `exam build --trusted`
// or the user's picks.
const DEGRADATIONS = {
  'low-contrast': { kind: 'flaw', css: (dark) => `body, body * { color: ${dark ? '#5c5c5c' : '#a8a8a8'} !important; }` },
  cramped: { kind: 'flaw', css: () => 'body * { padding: 1px !important; margin: 0 !important; gap: 0 !important; line-height: 1.05 !important; }' },
  'mixed-radii': {
    kind: 'flaw',
    css: () => 'body *:nth-child(3n) { border-radius: 0 !important; } body *:nth-child(3n+1) { border-radius: 20px !important; } body *:nth-child(3n+2) { border-radius: 5px !important; }',
  },
  'type-chaos': {
    kind: 'flaw',
    css: () => 'body *:nth-child(odd) { font-size: 15px !important; font-family: Georgia, serif !important; } body *:nth-child(even) { font-size: 11px !important; font-family: "Courier New", monospace !important; }',
  },
  misaligned: { kind: 'flaw', css: () => 'body *:nth-child(3n) { margin-left: 9px !important; } body *:nth-child(4n) { transform: translateX(-6px); }' },
  'assistant-palette': {
    kind: 'tell',
    css: () =>
      'a, button, [role="button"], [class*="btn"], [class*="button"] { background: linear-gradient(135deg, #6366f1, #a855f7) !important; color: #fff !important; border: 0 !important; border-radius: 12px !important; } ' +
      'h1, h2 { background: linear-gradient(90deg, #6366f1, #a855f7); -webkit-background-clip: text; background-clip: text; color: transparent !important; }',
  },
  'shadows-glow': {
    kind: 'tell',
    css: () => 'div, section, article, aside, nav, header, li, button { box-shadow: 0 12px 32px -12px rgba(99, 102, 241, 0.45), 0 0 0 1px rgba(99, 102, 241, 0.08) !important; }',
  },
  'tiny-caps': {
    kind: 'tell',
    css: () => 'h2, h3, h4, h5, h6, th, label, small, nav a { text-transform: uppercase !important; letter-spacing: 0.16em !important; font-size: 10px !important; }',
  },
  glass: {
    kind: 'tell',
    css: (dark) =>
      'body { background-image: radial-gradient(circle at 15% 10%, #c7d2fe 0, transparent 40%), radial-gradient(circle at 85% 25%, #f5d0fe 0, transparent 38%) !important; } ' +
      `nav, aside, header, [class*="card"] { backdrop-filter: blur(14px) !important; background: ${dark ? 'rgba(30, 30, 40, 0.45)' : 'rgba(255, 255, 255, 0.4)'} !important; border: 1px solid rgba(255, 255, 255, 0.45) !important; border-radius: 18px !important; }`,
  },
  'generic-kit': {
    kind: 'style',
    css: () =>
      '* { font-family: Inter, -apple-system, "Segoe UI", Roboto, sans-serif !important; letter-spacing: normal !important; text-shadow: none !important; } ' +
      'body { background: #f8f8f8 !important; color: #111827 !important; } body * { background-image: none !important; } ' +
      'h1, h2, h3, h4 { color: #111827 !important; font-weight: 600 !important; } ' +
      'section, article, aside, header, footer, [class*="card"] { background-color: #ffffff !important; border: 1px solid #e5e7eb !important; border-radius: 12px !important; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05) !important; } ' +
      'a, button, [role="button"], [class*="btn"], [class*="button"] { background: #4f46e5 !important; color: #ffffff !important; border: 0 !important; border-radius: 8px !important; box-shadow: none !important; }',
  },
  emoji: {
    kind: 'tell',
    css: () => '',
    js: () => {
      for (const h of document.querySelectorAll('h1, h2, h3')) h.textContent = `✨ ${h.textContent}`;
    },
  },
  // Numbered mono eyebrows above headings, and headings that end in periods.
  eyebrows: {
    kind: 'tell',
    css: () => '',
    js: () => {
      let k = 0;
      for (const h of document.querySelectorAll('h1, h2, h3')) {
        const text = h.textContent.trim();
        if (!text) continue;
        k++;
        const tag = document.createElement('div');
        tag.textContent = `${String(k).padStart(2, '0')} · ${text.split(/\s+/).slice(0, 2).join(' ')}`;
        tag.style.cssText = 'font: 600 11px/1.2 ui-monospace, Menlo, monospace; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.65; margin: 0 0 8px;';
        h.before(tag);
        if (!/[.!?]$/.test(text)) h.textContent = `${text}.`;
      }
    },
  },
  'serif-italic': {
    kind: 'tell',
    css: () => 'h1, h2, h3 { font-family: "Instrument Serif", "Iowan Old Style", Georgia, serif !important; font-style: italic !important; font-weight: 400 !important; letter-spacing: -0.035em !important; }',
  },
};

// Objective checks. A limit of null turns that check off.
const DEFAULT_CHECKS = {
  contrast: true,
  overflow: true,
  maxFontSizes: 10,
  maxFontFamilies: 3,
  maxFontWeights: 4,
  maxRadii: 6,
  // AI-slop tells: warnings, not gates. List names the design language uses on purpose in allowTells.
  tells: true,
  allowTells: [],
};

// What the tells check looks for. Names match the keys in the page audit.
const TELLS = {
  'period-titles': 'headings that end with a period',
  eyebrows: 'small uppercase labels right above headings',
  'caps-subtitles': 'long ALL CAPS lines',
  'negative-tracking': 'text with negative letter-spacing',
  'instrument-serif': 'Instrument Serif type',
  'mono-overuse': 'monospace text outside code',
  'italic-overuse': 'italic text in many places',
  'gradient-backgrounds': 'large gradient backgrounds',
  pills: 'many pill-shaped tags or buttons',
  'section-numbers': 'numbered section labels such as "01 ·"',
};

const CONFIG_TEMPLATE = {
  product: 'ours',
  screens: [{ name: 'home', url: 'http://localhost:3000/' }],
  themes: ['light', 'dark'],
  viewport: { width: 1440, height: 900 },
  waitMs: 1500,
  fullPage: false,
  // Full-page screens are cut into viewport-sized tiles for the judges, so text reaches
  // them at real size instead of shrunk to fit an image limit.
  tiles: true,
  storageState: null,
  threshold: 9,
  beatRefs: true,
  maxRounds: 8,
  checks: DEFAULT_CHECKS,
  exam: DEFAULT_EXAM,
  judges: ['codex', 'claude', 'agy'],
  models: { codex: null, agy: AGY_MODEL, gemini: null },
  // Reasoning effort per judge. `models --apply` sets the best model and effort available now.
  efforts: { codex: null, agy: null, claude: null },
};

// ---------- helpers ----------

function die(msg) {
  console.error(`ui-council: ${msg}`);
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const rel = (p) => relative(process.cwd(), p) || '.';
const fmt = (x) => x.toFixed(1);
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

function tail(s, lines = 3) {
  return String(s || '').trim().split('\n').filter(Boolean).slice(-lines).join('\n     ');
}

function loadConfig() {
  const p = join(DIR, 'config.json');
  if (!existsSync(p)) die('no council/config.json here. Run `init` from the project root first.');
  const file = readJson(p);
  return {
    ...CONFIG_TEMPLATE,
    ...file,
    checks: { ...DEFAULT_CHECKS, ...file.checks },
    exam: { ...DEFAULT_EXAM, ...file.exam },
    models: { ...CONFIG_TEMPLATE.models, ...file.models },
    efforts: { ...CONFIG_TEMPLATE.efforts, ...file.efforts },
  };
}

const EXAM_DIR = join(DIR, 'exam');

// The project's taste rules, or the skill's defaults when the project has none.
function taste() {
  const p = join(DIR, 'taste.md');
  const text = readFileSync(existsSync(p) ? p : join(SKILL_DIR, 'taste.md'), 'utf8');
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/^# .*$/m, '').trim();
}

// The project's design language. Judges judge within it; the builder follows it.
function style() {
  const fallback = 'Not described. Infer the design language from the screenshots, and judge within it.';
  const p = join(DIR, 'style.md');
  if (!existsSync(p)) return fallback;
  const text = readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/^# .*$/m, '');
  // Keep only sections that have content, as sub-headings of the prompt's own section.
  const sections = text
    .split(/^(?=## )/m)
    .map((s) => s.trim())
    .filter((s) => s.replace(/^## .*$/m, '').trim());
  return sections.length ? sections.join('\n\n').replace(/^## /gm, '### ') : fallback;
}

// Fingerprint of everything that shapes a judge's taste. A taste exam taken under a
// different fingerprint is out of date.
function tasteHash(cfg) {
  const h = createHash('sha256');
  for (const f of ['rubric.md', 'compare.md', 'exam.md']) h.update(readFileSync(join(SKILL_DIR, f), 'utf8'));
  h.update(taste());
  h.update(style());
  h.update(notes());
  h.update(JSON.stringify(cfg.models));
  if (Object.values(cfg.efforts ?? {}).some((v) => v != null)) h.update(JSON.stringify(cfg.efforts));
  return h.digest('hex').slice(0, 16);
}

// Judge fitness from the taste exam. Unfit judges are shown but never count.
function examStatus(cfg) {
  const p = join(EXAM_DIR, 'results.json');
  if (!existsSync(p)) return { state: 'none', unfit: new Set() };
  const r = readJson(p);
  if (r.hash !== tasteHash(cfg)) return { state: 'stale', unfit: new Set(), results: r };
  const unfit = new Set(Object.entries(r.judges).filter(([, j]) => j.fit === false).map(([k]) => k));
  return { state: 'ok', unfit, results: r };
}

function roundDir(n) {
  if (!/^\d+$/.test(String(n ?? ''))) die(`round must be a number, got "${n ?? ''}"`);
  return join(DIR, 'rounds', String(n));
}

function run(cmd, args, { input, timeoutMs = JUDGE_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: `${stderr}\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// Seeded shuffle, so a judge's labels and image order are stable within a round
// but differ between judges and rounds.
function rng(seed) {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function fill(template, vars) {
  const all = { TASTE: taste(), STYLE: style(), NOTES: notes(), ...vars };
  return readFileSync(join(SKILL_DIR, template), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => all[k] ?? m);
}

// ---------- images and rounds ----------

function listImages(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => IMG_EXT.has(extname(f).toLowerCase())).sort();
}

function shotsOf(n) {
  const dir = join(roundDir(n), 'shots');
  return listImages(dir).map((f) => ({ name: basename(f, extname(f)), path: join(dir, f) }));
}

function images(n, cfg) {
  const ours = shotsOf(n).map((s) => ({ path: s.path, product: cfg.product, view: s.name }));
  if (!ours.length) die(`round ${n} has no screenshots. Run \`capture ${n}\` first.`);
  const refs = listImages(join(DIR, 'refs')).map((f) => {
    if (/\s/.test(f)) die(`rename council/refs/${f}: file names must not contain spaces.`);
    const stem = basename(f, extname(f));
    const cut = stem.indexOf('--');
    return {
      path: join(DIR, 'refs', f),
      product: cut > 0 ? stem.slice(0, cut) : stem,
      view: cut > 0 ? stem.slice(cut + 2) : 'main',
    };
  });
  return [...ours, ...refs];
}

function productNames(imgs, cfg) {
  return [cfg.product, ...new Set(imgs.map((i) => i.product).filter((p) => p !== cfg.product))];
}

// The most recent earlier round whose changes were kept. Round 1 is the baseline.
function baselineRound(n) {
  for (let k = Number(n) - 1; k >= 1; k--) {
    if (!shotsOf(k).length) continue;
    if (k === 1) return 1;
    const t = join(roundDir(k), 'tally.json');
    if (existsSync(t) && readJson(t).accepted === true) return k;
  }
  return null;
}

function commonScreens(n, base) {
  const prev = new Set(shotsOf(base).map((s) => s.name));
  return shotsOf(n).map((s) => s.name).filter((s) => prev.has(s)).sort();
}

function notes() {
  const p = join(DIR, 'notes.md');
  if (!existsSync(p)) return 'None given.';
  const text = readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/^#.*$/gm, '').trim();
  return text || 'None given.';
}

// ---------- prompts ----------

// Copies images to neutral names, so file paths reveal nothing to the judge:
// not which product is the user's, and not which version is newer.
function blindCopies(dir, items) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return items.map((it, k) => {
    const path = join(dir, `img-${String(k + 1).padStart(2, '0')}${extname(it.path).toLowerCase()}`);
    copyFileSync(it.path, path);
    return { ...it, path };
  });
}

function manifest(judge, items) {
  if (judge === 'codex') {
    return 'The images are attached in this order:\n' + items.map((it, k) => `- Image ${k + 1}: ${it.label}`).join('\n');
  }
  if (judge === 'claude') return items.map((it) => `- ${it.path} : ${it.label}`).join('\n');
  return items.map((it) => `- @${rel(it.path)} : ${it.label}`).join('\n');
}

function output(judge, shapeText, outPath) {
  if (judge === 'claude') {
    return [
      'Use the Read tool to view every image listed above. Do not read any other file.',
      `Then use the Write tool to write only one JSON object, in exactly this shape, to ${outPath}:`,
      '',
      shapeText,
      '',
      'After writing the file, reply with the single word: done',
    ].join('\n');
  }
  const lead = judge === 'codex'
    ? 'Reply with only the JSON object. It must match the provided output schema:'
    : 'Reply with only one JSON object in exactly this shape. No prose, no code fences.';
  return `${lead}\n\n${shapeText}`;
}

function scoreShape(letters) {
  const scores = CAT_KEYS.map((k) => `"${k}": <0-10>`).join(', ');
  const rows = letters.map((l) => `    { "name": "${l}", "scores": { ${scores} } }`).join(',\n');
  return [
    '{',
    '  "products": [',
    rows,
    '  ],',
    '  "issues": [',
    `    { "product": "<one of: ${letters.join(', ')}>", "screen": "<screen>", "where": "<section and element>", "category": "<one of: ${CAT_KEYS.join(', ')}>", "severity": "high | medium | low", "problem": "<what is wrong>", "fix": "<one concrete change>" }`,
    '  ],',
    '  "summary": "<2-3 sentences comparing the products>"',
    '}',
  ].join('\n');
}

function scoreSchema(letters) {
  const scoreProps = Object.fromEntries(CAT_KEYS.map((k) => [k, { type: 'number' }]));
  return {
    type: 'object',
    additionalProperties: false,
    required: ['products', 'issues', 'summary'],
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'scores'],
          properties: {
            name: { type: 'string', enum: letters },
            scores: { type: 'object', additionalProperties: false, required: CAT_KEYS, properties: scoreProps },
          },
        },
      },
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['product', 'screen', 'where', 'category', 'severity', 'problem', 'fix'],
          properties: {
            product: { type: 'string', enum: letters },
            screen: { type: 'string' },
            where: { type: 'string' },
            category: { type: 'string', enum: CAT_KEYS },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            problem: { type: 'string' },
            fix: { type: 'string' },
          },
        },
      },
      summary: { type: 'string' },
    },
  };
}

function compareShape(screens) {
  return [
    '{',
    '  "screens": [',
    `    { "screen": "<one of: ${screens.join(', ')}>", "winner": "X | Y | tie", "reason": "<one sentence>" }`,
    '  ],',
    '  "overall": "X | Y | tie",',
    '  "reason": "<one sentence>"',
    '}',
    '',
    'Include every screen exactly once.',
  ].join('\n');
}

function compareSchema(screens) {
  const pick = { type: 'string', enum: ['X', 'Y', 'tie'] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['screens', 'overall', 'reason'],
    properties: {
      screens: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['screen', 'winner', 'reason'],
          properties: { screen: { type: 'string', enum: screens }, winner: pick, reason: { type: 'string' } },
        },
      },
      overall: pick,
      reason: { type: 'string' },
    },
  };
}

// Blind scoring: products become letters and images are shuffled, per judge and round.
function scoreTask(n, judge, cfg) {
  const dir = roundDir(n);
  const imgs = images(n, cfg);
  const rand = rng(`${n}:${judge}:score`);
  const order = shuffle(productNames(imgs, cfg), rand);
  const letters = Object.fromEntries(order.map((p, i) => [String.fromCharCode(65 + i), p]));
  const letterOf = Object.fromEntries(Object.entries(letters).map(([l, p]) => [p, l]));
  writeJson(join(dir, `${judge}.blind.json`), { letters });
  const items = blindCopies(
    join(dir, 'blind', `${judge}-score`),
    shuffle(imgs, rand).map((img) => ({ path: img.path, label: `Product ${letterOf[img.product]}, screen "${img.view}"` })),
  );
  const keys = Object.keys(letters);
  const prompt = fill('rubric.md', {
    IMAGES: manifest(judge, items),
    CATEGORIES: CAT_KEYS.map((k) => `- ${k}: ${CATEGORIES[k]}`).join('\n'),
    OUTPUT: output(judge, scoreShape(keys), join(dir, `${judge}.raw.json`)),
  });
  return {
    dir,
    tag: 'score',
    prompt,
    schema: scoreSchema(keys),
    images: items.map((i) => i.path),
    outFile: `${judge}.json`,
    rawFile: `${judge}.raw.json`,
    decode: (obj) => decodeScores(obj, letters, cfg),
  };
}

// Blind comparison with the last accepted round: versions become X and Y at random.
function compareTask(n, judge, cfg) {
  const base = baselineRound(n);
  if (!base) return null;
  const screens = commonScreens(n, base);
  if (!screens.length) return null;
  const dir = roundDir(n);
  const rand = rng(`${n}:${judge}:compare`);
  const xIsCurrent = rand() < 0.5;
  const versions = { X: xIsCurrent ? 'current' : 'previous', Y: xIsCurrent ? 'previous' : 'current' };
  writeJson(join(dir, `${judge}.compare.blind.json`), { versions, baseline: base });
  const shotPath = (round, screen) => shotsOf(round).find((s) => s.name === screen).path;
  const items = blindCopies(
    join(dir, 'blind', `${judge}-compare`),
    shuffle(screens, rand).flatMap((screen) =>
      ['X', 'Y'].map((v) => ({
        path: shotPath(versions[v] === 'current' ? n : base, screen),
        label: `Version ${v}, screen "${screen}"`,
      })),
    ),
  );
  const prompt = fill('compare.md', {
    IMAGES: manifest(judge, items),
    OUTPUT: output(judge, compareShape(screens), join(dir, `${judge}.compare.raw.json`)),
  });
  return {
    dir,
    tag: 'compare',
    prompt,
    schema: compareSchema(screens),
    images: items.map((i) => i.path),
    outFile: `${judge}.compare.json`,
    rawFile: `${judge}.compare.raw.json`,
    decode: (obj) => decodeCompare(obj, versions, base),
  };
}

// ---------- parsing and decoding ----------

function extractJson(text) {
  const s = String(text).replace(/```(?:json)?/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('no JSON object in reply');
  return JSON.parse(s.slice(a, b + 1));
}

const normName = (s) => String(s ?? '').trim().replace(/^product\s+/i, '').toLowerCase();

// names: the product names that must be present, in their canonical spelling.
function validateScores(obj, names) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.products)) throw new Error('missing "products" array');
  const byName = new Map(obj.products.map((p) => [normName(p?.name), p]));
  const canon = new Map(names.map((n) => [normName(n), n]));
  const products = names.map((name) => {
    const p = byName.get(normName(name));
    if (!p) throw new Error(`no scores for product "${name}"`);
    const scores = {};
    for (const k of CAT_KEYS) {
      const v = Number(p.scores?.[k]);
      if (!Number.isFinite(v) || v < 0 || v > 10) throw new Error(`bad score ${name}.${k}: ${p.scores?.[k]}`);
      scores[k] = v;
    }
    return { name, scores };
  });
  const issues = (Array.isArray(obj.issues) ? obj.issues : []).map((i) => ({
    product: canon.get(normName(i?.product)) ?? null,
    screen: String(i?.screen ?? ''),
    where: String(i?.where ?? ''),
    category: String(i?.category ?? ''),
    severity: String(i?.severity ?? 'medium').toLowerCase(),
    problem: String(i?.problem ?? ''),
    fix: String(i?.fix ?? ''),
  }));
  return { products, issues, summary: String(obj.summary ?? '') };
}

function decodeScores(obj, letters, cfg) {
  const v = validateScores(obj, Object.keys(letters));
  const text = (s) => s.replace(/\bProduct ([A-Z])\b/g, (m, l) => letters[l] ?? m);
  return {
    products: v.products.map((p) => ({ name: letters[p.name], scores: p.scores })),
    issues: v.issues
      .filter((i) => letters[i.product] === cfg.product)
      .map(({ product, ...i }) => ({ ...i, where: text(i.where), problem: text(i.problem), fix: text(i.fix) })),
    summary: text(v.summary),
  };
}

function decodeCompare(obj, versions, baseline) {
  const pick = (w) => {
    const s = String(w ?? '').trim().replace(/^version\s+/i, '').toUpperCase();
    if (s === 'X' || s === 'Y') return versions[s];
    return s === 'TIE' ? 'tie' : null;
  };
  // Bare X and Y are decoded too: judges often drop the word "Version".
  const text = (s) => String(s ?? '').replace(/\b(?:Version )?([XY])\b/g, (m, v) => `the ${versions[v]} version`);
  const overall = pick(obj?.overall);
  if (!overall) throw new Error(`bad "overall" pick: ${obj?.overall}`);
  return {
    baseline,
    overall,
    reason: text(obj.reason),
    screens: (Array.isArray(obj.screens) ? obj.screens : []).map((x) => ({
      screen: String(x?.screen ?? ''),
      winner: pick(x?.winner) ?? 'tie',
      reason: text(x?.reason),
    })),
  };
}

// Reads a judge's decoded result. Claude subagents write raw letter-labeled files;
// those are decoded here on first read.
function loadResult(n, judge, kind, cfg) {
  const dir = roundDir(n);
  const suffix = kind === 'compare' ? '.compare' : '';
  const out = join(dir, `${judge}${suffix}.json`);
  const raw = join(dir, `${judge}${suffix}.raw.json`);
  if (existsSync(raw) && (!existsSync(out) || statSync(raw).mtimeMs > statSync(out).mtimeMs)) {
    const map = readJson(join(dir, `${judge}${suffix}.blind.json`));
    const obj = extractJson(readFileSync(raw, 'utf8'));
    writeJson(out, kind === 'compare' ? decodeCompare(obj, map.versions, map.baseline) : decodeScores(obj, map.letters, cfg));
  }
  return existsSync(out) ? readJson(out) : null;
}

function stats(scores) {
  let minK = CAT_KEYS[0];
  let sum = 0;
  for (const k of CAT_KEYS) {
    sum += scores[k];
    if (scores[k] < scores[minK]) minK = k;
  }
  return { avg: sum / CAT_KEYS.length, min: scores[minK], minK };
}

// ---------- external judges ----------

class FatalError extends Error {}

// Every external judge call appends one line to council/usage.jsonl: tokens and time,
// so the tally and the gallery can show what each round cost.
function logUsage(judge, cfg, task, tokens, seconds) {
  const line = {
    at: new Date().toISOString(),
    where: relative(DIR, task.dir) || '.',
    judge,
    kind: task.tag,
    model: cfg.models?.[judge] ?? null,
    effort: cfg.efforts?.[judge] ?? null,
    input: tokens?.input ?? null,
    cached: tokens?.cached ?? null,
    output: tokens?.output ?? null,
    reasoning: tokens?.reasoning ?? null,
    total: tokens ? (tokens.input ?? 0) + (tokens.output ?? 0) : null,
    seconds: Math.round(seconds ?? 0),
  };
  appendFileSync(join(DIR, 'usage.jsonl'), JSON.stringify(line) + '\n');
}

function readUsage() {
  const p = join(DIR, 'usage.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

// `codex exec --json` prints one event per line. Token counts are on turn.completed.
function codexEvents(stdout) {
  return String(stdout).split('\n').flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

function codexTokens(events) {
  const turns = events.filter((e) => e.type === 'turn.completed' && e.usage);
  if (!turns.length) return null;
  const sum = (k) => turns.reduce((a, e) => a + (e.usage[k] ?? 0), 0);
  return { input: sum('input_tokens'), cached: sum('cached_input_tokens'), output: sum('output_tokens'), reasoning: sum('reasoning_output_tokens') };
}

function codexError(events, stderr) {
  const failed = events.filter((e) => e.type === 'turn.failed' || e.type === 'error').map((e) => e.error?.message ?? e.message).filter(Boolean);
  return failed.length ? failed.join(' | ') : tail(stderr);
}

async function callExternal(judge, cfg, task) {
  const base = join(task.dir, `${judge}.${task.tag}`);
  const rawPath = `${base}.raw.txt`;
  const schemaPath = `${base}.schema.json`;
  writeJson(schemaPath, task.schema);
  const started = Date.now();

  if (judge === 'codex') {
    rmSync(rawPath, { force: true });
    const args = ['exec', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--json', '--output-schema', schemaPath, '-o', rawPath];
    if (cfg.models?.codex) args.push('-m', cfg.models.codex);
    if (cfg.efforts?.codex) args.push('-c', `model_reasoning_effort="${cfg.efforts.codex}"`);
    for (const p of task.images) args.push('-i', p);
    // No positional prompt: codex exec reads the prompt from stdin.
    const r = await run('codex', args, { input: task.prompt });
    const events = codexEvents(r.stdout);
    logUsage(judge, cfg, task, codexTokens(events), (Date.now() - started) / 1000);
    if (r.timedOut) throw new FatalError('codex timed out');
    if (!existsSync(rawPath)) throw new FatalError(`codex exited ${r.code}: ${codexError(events, r.stderr)}`);
    return readFileSync(rawPath, 'utf8');
  }

  if (judge === 'agy') {
    // Plan mode is read-only. The @paths in the prompt attach the screenshots.
    const args = [
      '-p', task.prompt,
      '--mode', 'plan',
      '--output-format', 'json',
      '--json-schema', schemaPath,
      '--model', cfg.models?.agy ?? AGY_MODEL,
      '--disable-slash-commands',
    ];
    if (cfg.efforts?.agy) args.push('--effort', cfg.efforts.agy);
    const r = await run('agy', args);
    writeFileSync(rawPath, r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''));
    if (r.timedOut) throw new FatalError('agy timed out');
    let wrapper;
    try {
      wrapper = extractJson(r.stdout);
    } catch {
      logUsage(judge, cfg, task, null, (Date.now() - started) / 1000);
      throw new FatalError(`agy exited ${r.code}: ${tail(r.stderr || r.stdout)}. If it is not signed in, run \`agy\` once in a terminal.`);
    }
    const u = wrapper.usage;
    logUsage(judge, cfg, task, u ? { input: u.input_tokens, cached: u.cache_read_tokens, output: u.output_tokens, reasoning: u.thinking_tokens } : null, wrapper.duration_seconds ?? (Date.now() - started) / 1000);
    if (wrapper.status !== 'SUCCESS' || typeof wrapper.response !== 'string') {
      throw new Error(`agy status ${wrapper.status}: ${tail(wrapper.response ?? r.stderr)}`);
    }
    return wrapper.response;
  }

  // gemini: needs a paid GEMINI_API_KEY. --skip-trust keeps plan (read-only) mode in headless runs.
  const args = ['--skip-trust', '--approval-mode', 'plan', '-o', 'json'];
  if (cfg.models?.gemini) args.push('-m', cfg.models.gemini);
  args.push('-p', task.prompt);
  const r = await run('gemini', args);
  writeFileSync(rawPath, r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : ''));
  if (r.timedOut) throw new FatalError('gemini timed out');
  if (/IneligibleTierError|Error authenticating/.test(r.stderr)) {
    throw new FatalError(
      'gemini sign-in rejected. The Gemini CLI no longer accepts Google AI Pro or free accounts. ' +
        'Set a paid GEMINI_API_KEY, or use the agy judge instead.',
    );
  }
  let text = r.stdout;
  try {
    const wrapper = extractJson(r.stdout);
    if (typeof wrapper.response === 'string') text = wrapper.response;
  } catch {
    // Not wrapped; parse stdout as the reply itself.
  }
  if (!text.trim()) throw new FatalError(`gemini exited ${r.code}: ${tail(r.stderr)}`);
  return text;
}

// ---------- objective checks (runs inside the page) ----------

function AUDIT({ fullPage }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  // Painting a pixel converts any CSS color (rgb, hsl, oklch, ...) to sRGB bytes.
  const rgba = (c) => {
    if (cache.has(c)) return cache.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const v = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    cache.set(c, v);
    return v;
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const lum = ({ r, g, b }) => {
    const f = (c) => {
      const x = c / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const visible = (el, rect) => {
    if (rect.width < 1 || rect.height < 1) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    if (fullPage) return true;
    return rect.bottom > 0 && rect.right > 0 && rect.top < vh && rect.left < vw;
  };
  // The solid color behind an element, from its ancestors. null when an image or gradient is behind it.
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = rgba(s.backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 1) break;
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };

  const fontSizes = new Set();
  const fontFamilies = new Set();
  const fontWeights = new Set();
  const radii = new Set();
  const fails = new Map();
  const seen = new Set();

  // AI-slop tells. Warnings only: the design language may call for any of them.
  const tells = {};
  const clip = (t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 50);
  const tell = (name, text, count = 1) => {
    const t = (tells[name] ??= { count: 0, examples: [] });
    t.count += count;
    if (text && t.examples.length < 3 && !t.examples.includes(clip(text))) t.examples.push(clip(text));
  };
  const HEADING = 'h1, h2, h3, h4, [role="heading"]';
  let textEls = 0;
  const mono = [];
  const italic = [];
  const pills = [];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !node.textContent.trim()) continue;
    seen.add(el);
    if (el.closest('script, style, noscript, template, [aria-hidden="true"], [disabled], [aria-disabled="true"]')) continue;
    const rect = el.getBoundingClientRect();
    if (!visible(el, rect)) continue;
    const s = getComputedStyle(el);
    const size = Math.round(parseFloat(s.fontSize) * 2) / 2;
    const weight = Number(s.fontWeight) || 400;
    fontSizes.add(size);
    fontWeights.add(weight);
    fontFamilies.add(s.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase());

    textEls++;
    const own = el.textContent.replace(/\s+/g, ' ').trim();
    const family = s.fontFamily.toLowerCase();
    const letters = own.replace(/[^A-Za-z]/g, '');
    const caps = letters.length >= 3 && (s.textTransform === 'uppercase' || letters === letters.toUpperCase());
    if (family.includes('instrument serif')) tell('instrument-serif', own);
    if (/mono|courier|menlo|consolas|monaco/.test(family) && !el.closest('code, pre, kbd, samp')) mono.push(own);
    if (s.fontStyle === 'italic') italic.push(own);
    const tracking = parseFloat(s.letterSpacing);
    if (Number.isFinite(tracking) && tracking < -0.01 * parseFloat(s.fontSize)) tell('negative-tracking', own);
    if (caps && own.length >= 24 && own.split(' ').length >= 3) tell('caps-subtitles', own);
    if (caps && size <= 15 && own.length <= 40 && !el.matches(HEADING)) {
      const next = el.nextElementSibling ?? el.parentElement?.nextElementSibling;
      if (next?.matches(HEADING)) tell('eyebrows', own);
    }
    if (own.length <= 60 && /^(0\d|\d{2}|§\s*\d+)\s*[·./:|—–-]/.test(own)) tell('section-numbers', own);

    if (s.backgroundClip === 'text' || s.webkitBackgroundClip === 'text') continue;
    const bg = backdrop(el);
    if (!bg) continue;
    const fg = over(rgba(s.color), bg);
    const r = ratio(fg, bg);
    const need = size >= 24 || (size >= 18.5 && weight >= 700) ? 3 : 4.5;
    if (r < need) {
      const key = `${hex(fg)}|${hex(bg)}|${size}`;
      const f = fails.get(key);
      if (f) f.count++;
      else {
        fails.set(key, {
          text: node.textContent.trim().replace(/\s+/g, ' ').slice(0, 40),
          fg: hex(fg),
          bg: hex(bg),
          size,
          ratio: Math.round(r * 100) / 100,
          need,
          count: 1,
        });
      }
    }
  }

  for (const h of document.querySelectorAll(HEADING)) {
    const text = h.textContent.replace(/\s+/g, ' ').trim();
    if (/[^.]\.$/.test(text) && visible(h, h.getBoundingClientRect())) tell('period-titles', text);
  }

  for (const el of [document.documentElement, document.body, ...document.body.querySelectorAll('*')]) {
    const s = getComputedStyle(el);
    // Plain gradients only: repeating gradients are patterns and textures.
    if (/(^|[^-])(linear|radial|conic)-gradient\(/.test(s.backgroundImage)) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= 0.15 * vw * vh) tell('gradient-backgrounds', el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : ''));
    }
    const corners = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
    if (corners.every((c) => !parseFloat(c))) continue;
    const paints =
      rgba(s.backgroundColor).a > 0 ||
      parseFloat(s.borderTopWidth) > 0 ||
      parseFloat(s.borderRightWidth) > 0 ||
      parseFloat(s.borderBottomWidth) > 0 ||
      parseFloat(s.borderLeftWidth) > 0 ||
      s.boxShadow !== 'none' ||
      s.backgroundImage !== 'none' ||
      el.tagName === 'IMG';
    if (!paints) continue;
    const rect = el.getBoundingClientRect();
    if (!visible(el, rect)) continue;
    let pill = false;
    for (const c of corners) {
      const v = parseFloat(c);
      if (!v) continue;
      const isPill = c.includes('%') || v >= Math.min(rect.width, rect.height) / 2 - 0.5;
      pill ||= isPill;
      radii.add(isPill ? 'pill' : `${Math.round(v)}px`);
    }
    const label = el.textContent.replace(/\s+/g, ' ').trim();
    if (pill && el.tagName !== 'IMG' && rect.height <= 40 && rect.width > rect.height * 1.3 && label && label.length <= 24) pills.push(label);
  }
  // These count only in bulk: one mono label or one italic quote is fine.
  const many = (name, list) => {
    tell(name, list[0], list.length);
    for (const t of list.slice(1, 3)) tell(name, t, 0);
  };
  if (mono.length >= 4 && mono.length >= 0.05 * textEls) many('mono-overuse', mono);
  if (italic.length >= 6) many('italic-overuse', italic);
  if (pills.length >= 4) many('pills', pills);

  return {
    fontSizes: [...fontSizes],
    fontFamilies: [...fontFamilies],
    fontWeights: [...fontWeights],
    radii: [...radii],
    contrast: [...fails.values()],
    overflowX: document.documentElement.scrollWidth > vw + 1,
    tells: Object.entries(tells).map(([name, t]) => ({ name, ...t })),
  };
}

function summarizeChecks(audits, limits) {
  const union = (key) => [...new Set(Object.values(audits).flatMap((a) => a[key]))].sort(natural);
  const totals = {
    fontSizes: union('fontSizes'),
    fontFamilies: union('fontFamilies'),
    fontWeights: union('fontWeights'),
    radii: union('radii'),
  };
  const contrast = Object.entries(audits).flatMap(([shot, a]) => a.contrast.map((c) => ({ shot, ...c })));
  const overflow = Object.entries(audits).filter(([, a]) => a.overflowX).map(([shot]) => shot);
  const gates = [];
  if (limits.contrast) gates.push({ name: 'contrast failures', value: contrast.reduce((s, c) => s + c.count, 0), limit: 0 });
  if (limits.overflow) gates.push({ name: 'horizontal overflow', value: overflow.length, limit: 0 });
  const counted = [
    ['fontSizes', 'maxFontSizes', 'font sizes'],
    ['fontFamilies', 'maxFontFamilies', 'font families'],
    ['fontWeights', 'maxFontWeights', 'font weights'],
    ['radii', 'maxRadii', 'corner radii'],
  ];
  for (const [key, limitKey, label] of counted) {
    if (limits[limitKey] != null) gates.push({ name: `distinct ${label}`, value: totals[key].length, limit: limits[limitKey], values: totals[key] });
  }
  for (const g of gates) g.pass = g.value <= g.limit;
  // Tells are warnings: they never fail the checks.
  const allow = new Set(limits.allowTells ?? []);
  const tells = new Map();
  if (limits.tells !== false) {
    for (const [shot, a] of Object.entries(audits)) {
      for (const t of a.tells ?? []) {
        if (allow.has(t.name)) continue;
        const e = tells.get(t.name) ?? { name: t.name, label: TELLS[t.name] ?? t.name, count: 0, examples: [], shots: [] };
        e.count += t.count;
        e.shots.push(shot);
        for (const x of t.examples) if (e.examples.length < 3 && !e.examples.includes(x)) e.examples.push(x);
        tells.set(t.name, e);
      }
    }
  }
  return { pass: gates.every((g) => g.pass), gates, totals, contrast, overflow, tells: [...tells.values()] };
}

function printChecks(checks) {
  console.log(`\nchecks: ${checks.pass ? 'PASS' : 'FAIL'}`);
  for (const g of checks.gates) {
    const vals = g.values ? `  [${g.values.join(', ')}]` : '';
    console.log(`  ${g.pass ? 'ok  ' : 'FAIL'} ${g.name.padEnd(22)} ${String(g.value).padStart(3)} / limit ${g.limit}${vals}`);
  }
  if (checks.tells?.length) {
    console.log('  AI-slop tells (warnings, not gates; fine where council/style.md calls for them):');
    for (const t of checks.tells) {
      console.log(`  warn ${t.label} [${t.name}]: ${t.count}${t.examples.length ? `, e.g. "${t.examples.join('", "')}"` : ''}`);
    }
  }
}

async function loadChromium() {
  const entry = join(RUNTIME, 'node_modules', 'playwright', 'index.mjs');
  if (!existsSync(entry)) {
    console.log(`Installing ${PLAYWRIGHT} into the skill folder (one time)...`);
    const r = await run('npm', ['install', '--prefix', RUNTIME, '--no-audit', '--no-fund', '--loglevel=error', PLAYWRIGHT], {
      timeoutMs: 10 * 60 * 1000,
    });
    if (r.code !== 0 || !existsSync(entry)) die(`npm install failed: ${tail(r.stderr || r.stdout)}`);
  }
  const { chromium } = await import(pathToFileURL(entry).href);
  return chromium;
}

// ---------- change list: what the builder did about every request ----------

// council/rounds/<N>/changes.json answers every request from round N-1: each is "done"
// (what changed, and where to mark it) or "declined" (and why). capture refuses to run
// while any request is still "todo", and marks every change on the screenshots.
const changesPath = (n) => join(roundDir(n), 'changes.json');
const loadChanges = (n) => (existsSync(changesPath(n)) ? readJson(changesPath(n)) : null);

// Numbered changes, in list order: the numbers drawn on rounds/N/marked/ and in the gallery.
function numberedChanges(changes) {
  const made = [
    ...(changes?.requests ?? []).filter((c) => c.status === 'done'),
    ...(changes?.extra ?? []).map((c, k) => ({ id: `extra-${k + 1}`, from: 'builder', ...c })),
  ];
  return made.map((c, k) => ({ ...c, num: k + 1, marks: Array.isArray(c.marks) ? c.marks : [] }));
}

const screenOf = (s) => slug(String(s ?? '')).split('--')[0];

function checkChanges(n, cfg) {
  const prev = Number(n) - 1;
  if (prev < 1) return null;
  const changes = loadChanges(n);
  const file = rel(changesPath(n));
  if (!changes) {
    const judged = cfg.judges.some((j) => existsSync(join(roundDir(prev), `${j}.json`)) || existsSync(join(roundDir(prev), `${j}.raw.json`)));
    if (judged) die(`round ${n} has no change list. Run \`fixes ${prev}\`, then make or decline every request in ${file}.`);
    return null;
  }
  const problems = [];
  const names = new Set(cfg.screens.map((s) => screenOf(s.name)));
  for (const c of changes.requests ?? []) {
    if (c.status === 'todo' || !c.status) problems.push(`${c.id}: still "todo"`);
    else if (!['done', 'declined'].includes(c.status)) problems.push(`${c.id}: status must be "done" or "declined", not "${c.status}"`);
    else if (!String(c.did ?? '').trim()) problems.push(`${c.id}: "did" is empty (say what you changed, or why you declined)`);
  }
  for (const c of numberedChanges(changes)) {
    if (!String(c.did ?? '').trim()) problems.push(`${c.id}: "did" is empty`);
    if (!c.marks.length) problems.push(`${c.id}: no "marks". Add at least one {"screen", "selector"} for the changed element`);
    for (const m of c.marks) {
      if (!m?.selector) problems.push(`${c.id}: a mark has no "selector"`);
      if (!names.has(screenOf(m?.screen))) problems.push(`${c.id}: mark screen "${m?.screen}" is not a screen in config.json (${[...names].join(', ')})`);
    }
  }
  if (problems.length) die(`${file} is not finished:\n  ${problems.join('\n  ')}`);
  return changes;
}

// Runs inside the page: numbered boxes around each changed element. Judges never see these.
function MARK(list) {
  const color = '#1463ff';
  const base = 'all: initial; position: absolute; box-sizing: border-box; pointer-events: none;';
  const layer = document.createElement('div');
  layer.style.cssText = `${base} left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;`;
  const boxes = document.createElement('div');
  const badges = document.createElement('div');
  layer.append(boxes, badges);
  document.documentElement.appendChild(layer);
  const placed = [];
  const found = [];
  for (const { num, selector } of list) {
    let els;
    try {
      els = [...document.querySelectorAll(selector)];
    } catch {
      found.push({ num, selector, count: 0, error: 'invalid selector' });
      continue;
    }
    els = els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1;
    }).slice(0, 8);
    found.push({ num, selector, count: els.length });
    els.forEach((e, k) => {
      const r = e.getBoundingClientRect();
      const x = r.left + window.scrollX;
      const y = r.top + window.scrollY;
      const box = document.createElement('div');
      box.style.cssText = `${base} left: ${x - 4}px; top: ${y - 4}px; width: ${r.width + 8}px; height: ${r.height + 8}px; border: 3px solid ${color}; border-radius: 6px; box-shadow: 0 0 0 2px #fff, inset 0 0 0 1px #fff;`;
      boxes.appendChild(box);
      if (k) return;
      let bx = Math.max(2, x - 14);
      const by = Math.max(2, y - 14);
      while (placed.some(([px, py]) => Math.abs(px - bx) < 30 && Math.abs(py - by) < 30)) bx += 32;
      placed.push([bx, by]);
      const b = document.createElement('div');
      b.textContent = String(num);
      b.style.cssText = `${base} left: ${bx}px; top: ${by}px; min-width: 30px; height: 30px; padding: 0 7px; border-radius: 15px; background: ${color}; color: #fff; font: 700 15px/26px system-ui, -apple-system, sans-serif; text-align: center; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);`;
      badges.appendChild(b);
    });
  }
  return found;
}

function cmdFixes(n, args = []) {
  const cfg = loadConfig();
  const round = Number(n);
  roundDir(n);
  const next = round + 1;
  const out = changesPath(next);
  if (existsSync(out) && !args.includes('--force')) die(`${rel(out)} already exists. Edit it, or pass --force to start it over.`);
  const { unfit } = examStatus(cfg);
  const judges = cfg.judges.filter((j) => !unfit.has(j));
  const requests = [];
  const seq = {};
  const add = (from, i) => {
    seq[from] = (seq[from] ?? 0) + 1;
    requests.push({
      id: `${from}-${seq[from]}`,
      from,
      screen: i.screen ?? '',
      where: i.where ?? '',
      category: i.category ?? '',
      severity: i.severity ?? 'medium',
      problem: i.problem ?? '',
      fix: i.fix ?? '',
      status: 'todo',
      did: '',
      marks: [],
    });
  };

  const checks = loadChecks(n);
  for (const c of checks?.contrast ?? []) {
    add('checks', { screen: c.shot, where: `text "${c.text}"`, category: 'color_contrast', severity: 'high', problem: `${c.fg} on ${c.bg} at ${c.size}px is ${c.ratio}:1 (${c.count} element${c.count > 1 ? 's' : ''})`, fix: `raise the contrast to at least ${c.need}:1` });
  }
  for (const shot of checks?.overflow ?? []) {
    add('checks', { screen: shot, where: 'whole page', category: 'spacing_layout', severity: 'high', problem: 'the page scrolls sideways', fix: 'remove the horizontal overflow' });
  }
  for (const g of (checks?.gates ?? []).filter((x) => !x.pass && x.values)) {
    add('checks', { screen: 'all', where: 'design tokens', category: 'consistency', severity: 'high', problem: `${g.value} ${g.name}: ${g.values.join(', ')}`, fix: `use at most ${g.limit}` });
  }

  const base = baselineRound(n);
  if (base) {
    for (const j of judges) {
      let c;
      try {
        c = loadResult(n, j, 'compare', cfg);
      } catch {
        continue;
      }
      for (const x of (c?.screens ?? []).filter((x) => x.winner === 'previous')) {
        add('compare', { screen: x.screen, where: 'whole screen', category: 'taste', severity: 'high', problem: `${j} preferred round ${base} on this screen: ${x.reason}`, fix: 'find what made it worse, and undo or redo that change' });
      }
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  const issues = [];
  for (const j of judges) {
    let d;
    try {
      d = loadResult(n, j, 'score', cfg);
    } catch {
      continue;
    }
    for (const i of d?.issues ?? []) issues.push({ judge: j, ...i });
  }
  issues.sort((a, b) => (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1) || judges.indexOf(a.judge) - judges.indexOf(b.judge));
  for (const { judge, ...i } of issues) add(judge, i);

  for (const t of checks?.tells ?? []) {
    add('tells', { screen: t.shots.join(', '), where: t.examples.length ? `for example "${t.examples.join('", "')}"` : '', category: 'taste', severity: 'low', problem: `AI-slop tell: ${t.label} (${t.count})`, fix: 'remove it, unless council/style.md calls for it: then decline and say so' });
  }

  mkdirSync(roundDir(next), { recursive: true });
  writeJson(out, { round: next, from: round, commit: '', requests, extra: [] });
  const count = Object.entries(seq).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`Wrote ${rel(out)}: ${requests.length} requests (${count || 'none'}).\n`);
  for (const r of requests) {
    console.log(`[${r.id}] ${r.severity} ${r.screen} / ${r.category}${r.where ? ` @ ${r.where}` : ''}\n  problem: ${r.problem}\n  fix: ${r.fix}`);
  }
  console.log(`
Answer every request in ${rel(out)}:
  done:     "status": "done", "did": "<what you changed, with values>",
            "marks": [{ "screen": "<screen name>", "selector": "<CSS selector of the changed element>" }]
  declined: "status": "declined", "did": "<why: conflicts with style.md or notes.md, reverses a change the vote kept, ...>"
Changes nobody asked for go in "extra" as { "did", "marks" }. Put the commit hash in "commit".
\`capture ${next}\` refuses to run while any request is "todo", and draws every change, numbered, on rounds/${next}/marked/.`);
}

// ---------- models and quota ----------

// Talks to `codex app-server` (JSON-RPC over stdio). Listing models and reading the
// rate limits costs no tokens.
function codexAppServer(calls, timeoutMs = 30000) {
  return new Promise((done, fail) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let buf = '';
    let id = 0;
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error('codex app-server did not answer in time'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id != null && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      }
    });
    child.stdin.on('error', () => {});
    const call = (method, params) =>
      new Promise((res) => {
        const k = ++id;
        pending.set(k, res);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: k, method, params }) + '\n');
      });
    (async () => {
      const init = await call('initialize', { clientInfo: { name: 'ui-council', title: 'UI council', version: '1.0.0' } });
      if (init.error) throw new Error(init.error.message);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
      const out = [];
      for (const [method, params] of calls) {
        const r = await call(method, params);
        if (r.error) throw new Error(`${method}: ${r.error.message}`);
        out.push(r.result);
      }
      return out;
    })()
      .then((out) => {
        clearTimeout(timer);
        child.kill();
        done(out);
      })
      .catch((e) => {
        clearTimeout(timer);
        child.kill();
        fail(e);
      });
  });
}

// Judging screenshots takes perception and taste more than long chains of reasoning, so
// judges start at "high". The deeper efforts cost far more for little gain on this task.
// A judge that fails the taste exam moves up one step (`exam score` says so).
// "ultra" is never used: it adds automatic delegation to other agents, which a judge does not need.
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const JUDGE_EFFORT = 'high';
// The target effort if the model offers it, else the nearest one below, else the nearest above.
function pickEffort(list, target = JUDGE_EFFORT) {
  const t = EFFORTS.indexOf(target);
  const ok = list.filter((e) => EFFORTS.includes(e));
  if (ok.includes(target)) return target;
  const below = ok.filter((e) => EFFORTS.indexOf(e) < t).sort((a, b) => EFFORTS.indexOf(b) - EFFORTS.indexOf(a));
  const above = ok.filter((e) => EFFORTS.indexOf(e) > t).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  return below[0] ?? above[0] ?? null;
}
const nextEffort = (e) => (EFFORTS.includes(e) ? EFFORTS[Math.min(EFFORTS.indexOf(e) + 1, EFFORTS.length - 1)] : 'xhigh');
const LIGHT = /(^|[-_ ])(flash|lite|mini|nano|spark|small|fast)([-_ ]|$)/i;

function bestCodexModel(models) {
  const rank = (m) =>
    (/frontier|most capable|most intelligent|most demanding|smartest/i.test(`${m.description} ${m.displayName}`) ? 4 : 0) +
    (m.isDefault ? 1 : 0) -
    (LIGHT.test(m.id) ? 4 : 0);
  return [...models].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

// agy model ids look like gemini-4-argon-high: provider, version, family, effort.
// Picks the newest full-size Gemini family, then the variant closest to the target effort.
function bestAgyModel(ids, target = JUDGE_EFFORT) {
  const parse = (id) => {
    const parts = id.split('-');
    const effort = EFFORTS.includes(parts.at(-1)) ? parts.at(-1) : null;
    const version = parseFloat(parts.find((p) => /^\d+(\.\d+)?$/.test(p)) ?? '0');
    return { id, effort, base: effort ? parts.slice(0, -1).join('-') : id, version, light: LIGHT.test(id) };
  };
  const rank = (a, b) => (a.light - b.light) || (b.version - a.version);
  const gemini = ids.filter((id) => /^gemini-/.test(id)).map(parse).sort(rank);
  if (!gemini.length) return { id: null, ties: [] };
  const top = gemini[0];
  // Families of the same version, for example Argon and Carbon: the names alone cannot rank them.
  const ties = [...new Set(gemini.filter((g) => rank(g, top) === 0).map((g) => g.base))];
  const variants = gemini.filter((g) => g.base === top.base);
  const effort = pickEffort(variants.map((v) => v.effort).filter(Boolean), target);
  return { id: variants.find((v) => v.effort === effort)?.id ?? top.id, ties };
}

async function agyModelIds() {
  const r = await run('agy', ['models'], { timeoutMs: 60000 });
  return r.stdout.split('\n').map((l) => l.split('\t')).filter((p) => p.length >= 2 && /^[\w.-]+$/.test(p[0])).map(([id, name]) => ({ id, name: name.trim() }));
}

async function cmdModels(args) {
  const cfg = loadConfig();
  const apply = args.includes('--apply');
  const ci = args.indexOf('--claude');
  const claudeModel = ci >= 0 ? args[ci + 1] : null;
  if (ci >= 0 && !claudeModel) die('--claude needs the model name the Agent tool takes, for example opus.');
  const ei = args.indexOf('--effort');
  const target = ei >= 0 ? args[ei + 1] : JUDGE_EFFORT;
  if (!EFFORTS.includes(target)) die(`--effort must be one of ${EFFORTS.join(', ')}.`);
  const best = { models: {}, efforts: {} };

  if (cfg.judges.includes('codex')) {
    try {
      const [list] = await codexAppServer([['model/list', {}]]);
      const models = (list?.data ?? []).filter((m) => !m.hidden);
      console.log('codex models:');
      for (const m of models) {
        const efforts = (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
        console.log(`  ${m.id.padEnd(22)} ${(m.description ?? '').slice(0, 70)}${m.isDefault ? ' (default)' : ''}\n  ${''.padEnd(22)} efforts: ${efforts.join(', ')}`);
      }
      const m = bestCodexModel(models);
      if (m) {
        best.models.codex = m.id;
        best.efforts.codex = pickEffort((m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort), target);
      }
    } catch (e) {
      console.log(`codex: could not list models (${e.message})`);
    }
  }
  if (cfg.judges.includes('agy')) {
    const ids = await agyModelIds();
    console.log(`\nagy models:\n${ids.map((m) => `  ${m.id.padEnd(28)} ${m.name}`).join('\n') || '  none listed. Is agy signed in?'}`);
    const { id, ties } = bestAgyModel(ids.map((m) => m.id), target);
    // The effort is part of an agy model id, for example gemini-4-argon-high.
    if (id) best.models.agy = id;
    if (ties.length > 1) {
      console.log(`  Several Gemini families share the newest version: ${ties.join(', ')}. Picked ${id}. If another one is better at judging design, set models.agy to it and retake the exam.`);
    }
  }
  if (claudeModel) {
    best.models.claude = claudeModel;
    best.efforts.claude = target;
  }

  const row = (j) => {
    const now = `${cfg.models?.[j] ?? (j === 'claude' ? 'session model' : 'CLI default')}${cfg.efforts?.[j] ? ` @ ${cfg.efforts[j]}` : ''}`;
    const want = best.models[j] ? `${best.models[j]}${best.efforts[j] ? ` @ ${best.efforts[j]}` : ''}` : null;
    return `  ${j.padEnd(8)} now: ${now.padEnd(30)} best: ${want ?? '-'}`;
  };
  console.log(`\n${cfg.judges.map(row).join('\n')}`);
  if (cfg.judges.includes('claude') && !claudeModel) {
    console.log('  claude: pass --claude <model> with the most capable model the Agent tool offers (for example opus).');
  }
  const changed = Object.keys(best.models).some((j) => best.models[j] !== cfg.models?.[j] || (best.efforts[j] ?? null) !== (cfg.efforts?.[j] ?? null));
  if (!apply) {
    console.log(changed ? '\nRun `models --apply` to use the best models and efforts.' : '\nThe config already uses the best models listed.');
    return;
  }
  if (!changed) return console.log('\nNothing to change.');
  const p = join(DIR, 'config.json');
  const file = readJson(p);
  file.models = { ...file.models, ...best.models };
  file.efforts = { ...file.efforts };
  for (const j of Object.keys(best.models)) file.efforts[j] = best.efforts[j] ?? null;
  writeJson(p, file);
  console.log(`\nSaved to ${rel(p)}.${existsSync(join(EXAM_DIR, 'results.json')) ? ' The taste exam is now out of date: retake the judge part.' : ''}`);
}

const pct = (x) => `${Math.round(x)}%`;
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-');
const windowName = (mins) => (mins >= 10080 ? 'weekly' : mins >= 1440 ? `${Math.round(mins / 1440)}-day` : `${Math.round(mins / 60)}-hour`);

async function codexQuota() {
  const [res] = await codexAppServer([['account/rateLimits/read', {}]]);
  const rl = res?.rateLimits ?? {};
  const buckets = ['primary', 'secondary'].map((k) => rl[k]).filter(Boolean).map((b) => ({
    name: windowName(b.windowDurationMins),
    left: 100 - b.usedPercent,
    resetsAt: b.resetsAt ? new Date(b.resetsAt * 1000).toISOString() : null,
  }));
  return { plan: rl.planType ?? null, buckets };
}

// `agy -p /usage` reports the quota of each model group. Keep the groups this judge's model draws from.
async function agyQuota(model) {
  const r = await run('agy', ['-p', '/usage', '--mode', 'plan', '--output-format', 'json', '--print-timeout', '60s'], { timeoutMs: 90000 });
  const groups = extractJson(r.stdout)?.command?.data?.groups;
  if (!Array.isArray(groups)) throw new Error(tail(r.stderr || r.stdout));
  const tokens = new Set(String(model).toLowerCase().split(/[-_.\s]+/));
  const fits = (name) => {
    const words = String(name).toLowerCase().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.every((w) => tokens.has(w));
  };
  const listed = (g) => (String(g.description ?? '').split(':')[1] ?? '').split(',');
  let mine = groups.filter((g) => fits(g.name) || listed(g).some(fits));
  if (!mine.length) mine = groups;
  return {
    plan: null,
    buckets: mine.flatMap((g) => (g.buckets ?? []).map((b) => ({
      name: `${g.name} ${b.window}`,
      left: (b.remaining_fraction ?? 0) * 100,
      resetsAt: b.reset_time ?? null,
    }))),
  };
}

// --claude "5-hour:14@2026-11-05T20:50Z,weekly:17": percent used per limit, and optionally
// when it resets, from the app's usage panel or tool.
function parseClaudeQuota(spec) {
  const buckets = String(spec).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(.+?)[:=]\s*(\d+(?:\.\d+)?)%?(?:@(\S+))?$/);
    if (!m || (m[3] && Number.isNaN(Date.parse(m[3])))) die(`bad --claude value "${s}". Use name:percent-used[@reset-time], for example "5-hour:14@2026-11-05T20:50Z,weekly:17".`);
    return { name: m[1].trim(), left: 100 - Number(m[2]), resetsAt: m[3] ? new Date(m[3]).toISOString() : null };
  });
  return { plan: null, buckets };
}

function quotaPath(n) {
  return join(roundDir(n), 'quota.json');
}

// About how many more rounds each limit allows: the average drop between recorded rounds.
// A drop only counts within the same window (same reset time, give or take an hour).
function quotaReport(n, cfg) {
  const rounds = existsSync(join(DIR, 'rounds'))
    ? readdirSync(join(DIR, 'rounds')).filter((d) => /^\d+$/.test(d)).map(Number).filter((m) => m <= Number(n)).sort((a, b) => a - b)
    : [];
  const snaps = rounds.filter((m) => existsSync(quotaPath(m))).map((m) => ({ m, q: readJson(quotaPath(m)) }));
  const last = snaps.at(-1);
  if (!last || last.m !== Number(n)) return null;
  const sameWindow = (a, b) => !a || !b || Math.abs(new Date(a) - new Date(b)) < 3600 * 1000;
  const rows = [];
  for (const [judge, info] of Object.entries(last.q.judges ?? {})) {
    for (const b of info.buckets ?? []) {
      const drops = [];
      for (let i = snaps.length - 1; i > 0 && drops.length < 3; i--) {
        const cur = snaps[i].q.judges?.[judge]?.buckets?.find((x) => x.name === b.name);
        const prev = snaps[i - 1].q.judges?.[judge]?.buckets?.find((x) => x.name === b.name);
        if (!cur || !prev || !sameWindow(cur.resetsAt, prev.resetsAt)) continue;
        const drop = (prev.left - cur.left) / (snaps[i].m - snaps[i - 1].m);
        if (drop > 0) drops.push(drop);
      }
      const perRound = drops.length ? drops.reduce((a, x) => a + x, 0) / drops.length : null;
      rows.push({ judge, name: b.name, left: b.left, resetsAt: b.resetsAt, perRound, roundsLeft: perRound ? Math.floor(b.left / perRound) : null });
    }
  }
  const low = rows.filter((r) => r.left < 10 || (r.roundsLeft != null && r.roundsLeft < 2));
  return { round: last.m, at: last.q.at, rows, low, errors: last.q.errors ?? {} };
}

function printQuota(report) {
  console.log(`\nquota left after round ${report.round} (about how many more rounds at the recent rate):`);
  for (const r of report.rows) {
    const est = r.roundsLeft != null ? `~${r.roundsLeft} rounds (${r.perRound.toFixed(1)}% a round)` : 'rate not known yet';
    console.log(`  ${r.judge.padEnd(8)} ${r.name.padEnd(28)} ${pct(r.left).padStart(4)} left  resets ${when(r.resetsAt).padEnd(16)} ${est}`);
  }
  for (const [j, e] of Object.entries(report.errors)) console.log(`  ${j.padEnd(8)} could not read: ${e}`);
}

async function cmdQuota(args) {
  const cfg = loadConfig();
  const n = args.find((a) => /^\d+$/.test(a));
  const ci = args.indexOf('--claude');
  const snap = { at: new Date().toISOString(), judges: {}, errors: {} };
  if (n && existsSync(quotaPath(n))) Object.assign(snap.judges, readJson(quotaPath(n)).judges);
  const jobs = [];
  if (cfg.judges.includes('codex')) jobs.push(['codex', () => codexQuota()]);
  if (cfg.judges.includes('agy')) jobs.push(['agy', () => agyQuota(cfg.models?.agy ?? AGY_MODEL)]);
  await Promise.all(jobs.map(async ([j, f]) => {
    try {
      snap.judges[j] = await f();
    } catch (e) {
      snap.errors[j] = e.message;
    }
  }));
  if (ci >= 0) snap.judges.claude = parseClaudeQuota(args[ci + 1] ?? '');
  if (!n) {
    printQuota({ round: 'now', rows: Object.entries(snap.judges).flatMap(([judge, q]) => q.buckets.map((b) => ({ judge, ...b, perRound: null, roundsLeft: null }))), errors: snap.errors });
    return;
  }
  if (!existsSync(roundDir(n))) die(`round ${n} does not exist yet.`);
  writeJson(quotaPath(n), snap);
  printQuota(quotaReport(n, cfg));
  if (cfg.judges.includes('claude') && !snap.judges.claude) {
    console.log('  claude   not recorded. Add --claude "5-hour:<used>,weekly:<used>" from the usage panel.');
  }
}

// Serves council/ on this machine only, so the gallery opens in any browser.
async function cmdServe(portArg) {
  const { createServer } = await import('node:http');
  const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
  if (!existsSync(DIR)) die('no council/ here. Run `init` from the project root first.');
  const server = createServer((req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return res.writeHead(400).end();
    }
    if (path === '/') path = '/gallery/index.html';
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(DIR, `.${path}`);
    // Never serve the login cookies.
    if (!file.startsWith(DIR + '/') || basename(file) === 'auth.json' || !existsSync(file) || !statSync(file).isFile()) {
      return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    }
    res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  let port = Number(portArg) || 8766;
  const max = port + 10;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < max) server.listen(++port, '127.0.0.1');
    else die(e.message);
  });
  server.on('listening', () => console.log(`serving council/ at http://127.0.0.1:${port}/gallery/index.html  (Ctrl-C stops it)`));
  server.listen(port, '127.0.0.1');
}

// ---------- commands ----------

function cmdInit() {
  mkdirSync(join(DIR, 'refs'), { recursive: true });
  mkdirSync(join(DIR, 'rounds'), { recursive: true });
  const write = (p, content) => {
    if (existsSync(p)) return console.log(`keep ${rel(p)}`);
    writeFileSync(p, content);
    console.log(`new  ${rel(p)}`);
  };
  write(join(DIR, 'config.json'), JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n');
  write(
    join(DIR, 'notes.md'),
    '# Design direction\n\n<!-- Taste notes for the builder and the judges. Example: "Too grayscale: keep the brand color on primary actions." -->\n',
  );
  write(join(DIR, 'style.md'), readFileSync(join(SKILL_DIR, 'style.md'), 'utf8'));
  write(join(DIR, 'taste.md'), readFileSync(join(SKILL_DIR, 'taste.md'), 'utf8'));
  write(join(DIR, '.gitignore'), 'auth.json\nrounds/\nexam/blind/\n');
  console.log(`new  ${rel(join(DIR, 'refs'))}/  (put reference screenshots here: <app>--<screen>.png)`);
}

async function cmdCapture(n) {
  const cfg = loadConfig();
  const dir = roundDir(n);
  const out = join(dir, 'shots');
  const fullDir = join(dir, 'full');
  const markDir = join(dir, 'marked');
  // Every request from the round before must be answered first.
  const changes = checkChanges(n, cfg);
  const numbered = numberedChanges(changes);
  rmSync(out, { recursive: true, force: true });
  rmSync(fullDir, { recursive: true, force: true });
  rmSync(markDir, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const marks = [];
  if (cfg.storageState && !existsSync(cfg.storageState)) die(`storageState file not found: ${cfg.storageState}`);
  const chromium = await loadChromium();
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    die(/Executable doesn't exist/.test(e.message) ? `browser missing. Run: npx -y ${PLAYWRIGHT} install chromium` : e.message);
  }
  const themes = cfg.themes?.length ? cfg.themes : [null];
  const audits = {};
  let failed = 0;
  try {
    for (const s of cfg.screens) {
      const name = String(s.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
      for (const theme of themes) {
        const shot = theme ? `${name}--${theme}` : name;
        const file = join(out, `${shot}.png`);
        const url = theme ? s.url.replaceAll('{theme}', theme) : s.url;
        const fullPage = Boolean(s.fullPage ?? cfg.fullPage);
        const context = await browser.newContext({
          viewport: cfg.viewport,
          colorScheme: theme === 'dark' ? 'dark' : 'light',
          storageState: cfg.storageState || undefined,
        });
        try {
          const page = await context.newPage();
          await page.goto(url, { waitUntil: 'load', timeout: 60000 });
          if (s.waitForSelector) await page.waitForSelector(s.waitForSelector, { timeout: 30000 });
          await page.waitForTimeout(s.waitMs ?? cfg.waitMs);
          if (fullPage && cfg.tiles !== false) {
            // The full image is for people; the judges get viewport-sized tiles.
            mkdirSync(fullDir, { recursive: true });
            await page.screenshot({ path: join(fullDir, `${shot}.png`), fullPage: true });
            const { width: vw, height: vh } = cfg.viewport;
            const height = await page.evaluate(() => document.documentElement.scrollHeight);
            const count = Math.max(1, Math.ceil(height / vh));
            for (let k = 0; k < count; k++) {
              // The last tile ends at the page bottom, overlapping the one before it.
              const y = height > vh ? Math.min(k * vh, height - vh) : 0;
              const part = join(out, `${shot}--part${k + 1}.png`);
              await page.screenshot({ path: part, fullPage: true, clip: { x: 0, y, width: vw, height: Math.min(vh, height) } });
            }
            console.log(`ok   ${rel(join(fullDir, `${shot}.png`))} (${count} tiles for judges)`);
          } else {
            await page.screenshot({ path: file, fullPage });
            console.log(`ok   ${rel(file)}`);
          }
          audits[shot] = await page.evaluate(AUDIT, { fullPage });
          // After the clean shots: a copy for people with every change boxed and numbered.
          const mine = numbered.flatMap((c) => c.marks.filter((m) => screenOf(m.screen) === screenOf(name)).map((m) => ({ num: c.num, id: c.id, selector: m.selector })));
          if (mine.length) {
            mkdirSync(markDir, { recursive: true });
            const found = await page.evaluate(MARK, mine.map(({ num, selector }) => ({ num, selector })));
            await page.screenshot({ path: join(markDir, `${shot}.png`), fullPage });
            found.forEach((f, k) => marks.push({ ...f, id: mine[k].id, shot }));
          }
        } catch (e) {
          failed++;
          console.log(`FAIL ${rel(file)} <- ${url}\n     ${tail(e.message, 2)}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  const checks = summarizeChecks(audits, cfg.checks);
  writeJson(join(dir, 'checks.json'), checks);
  printChecks(checks);
  if (changes) {
    writeJson(join(dir, 'marks.json'), marks);
    const declined = (changes.requests ?? []).filter((c) => c.status === 'declined').length;
    console.log(`\nchanges: ${numbered.length} made, ${declined} declined. Marked on ${rel(markDir)}/`);
    // A change is unmarked when none of its selectors matched on any screen.
    const hit = new Set(marks.filter((m) => m.count).map((m) => m.id));
    for (const c of numbered.filter((c) => !hit.has(c.id))) {
      console.log(`  warn ${c.num} (${c.id}): no selector matched. Fix its "marks" in ${rel(changesPath(n))} and capture again.`);
    }
  }
  if (failed) process.exitCode = 1;
}

// Runs external judge tasks in parallel. Each task writes its decoded result to task.dir/task.outFile.
async function runJobs(cfg, jobs) {
  const results = await Promise.all(
    jobs.map(async ([j, task]) => {
      const file = join(task.dir, task.outFile);
      rmSync(file, { force: true });
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const text = await callExternal(j, cfg, task);
          writeJson(file, task.decode(extractJson(text)));
          return `${j} ${task.tag}: ok -> ${rel(file)}`;
        } catch (e) {
          if (e instanceof FatalError || attempt === 2) return `${j} ${task.tag}: FAILED - ${e.message}`;
        }
      }
    }),
  );
  console.log(results.join('\n'));
  if (results.some((r) => r.includes('FAILED'))) process.exitCode = 1;
}

function checkExternal(list) {
  for (const j of list) {
    if (j === 'claude') die('the claude judge runs as fresh subagents. Use the matching `prompt` command and give its output to a subagent.');
    if (!EXTERNAL.includes(j)) die(`unknown judge "${j}". External judges: ${EXTERNAL.join(', ')}`);
  }
}

async function cmdJudge(n, names) {
  const cfg = loadConfig();
  const { unfit } = examStatus(cfg);
  const list = names.length ? names : cfg.judges.filter((j) => EXTERNAL.includes(j) && !unfit.has(j));
  checkExternal(list);
  const jobs = [];
  for (const j of list) {
    jobs.push([j, scoreTask(n, j, cfg)]);
    const c = compareTask(n, j, cfg);
    if (c) jobs.push([j, c]);
  }
  await runJobs(cfg, jobs);
}

// Printed on stderr, so it never ends up in a prompt saved with `>`.
const claudeHint = (cfg) =>
  `ui-council: give this prompt to a new subagent with model ${cfg.models?.claude ?? '(the most capable the Agent tool offers)'} and effort ${cfg.efforts?.claude ?? JUDGE_EFFORT}.`;

function cmdPrompt(n, kind = 'claude') {
  const cfg = loadConfig();
  const compare = kind.endsWith('-compare');
  const judge = compare ? kind.slice(0, -'-compare'.length) : kind;
  const task = compare ? compareTask(n, judge, cfg) : scoreTask(n, judge, cfg);
  if (!task) die(`round ${n} has no earlier accepted round with matching screens to compare with.`);
  // A new prompt means a new judgment: clear the old result so tally never reads a stale one.
  for (const f of [task.outFile, task.rawFile]) rmSync(join(roundDir(n), f), { force: true });
  if (judge === 'claude') console.error(claudeHint(cfg));
  console.log(task.prompt);
}

function scoreRow(n, j, cfg, products) {
  let data;
  try {
    data = loadResult(n, j, 'score', cfg);
    if (!data) return { judge: j, status: 'not run' };
    data = validateScores(data, products);
  } catch (e) {
    return { judge: j, status: 'invalid', error: e.message };
  }
  const ours = data.products.find((x) => x.name === cfg.product);
  const refs = data.products.filter((x) => x.name !== cfg.product).map((x) => ({ name: x.name, ...stats(x.scores) }));
  const o = stats(ours.scores);
  const bestRef = refs.reduce((best, r) => (!best || r.avg > best.avg ? r : best), null);
  const meetsBar = o.min >= cfg.threshold;
  const beatsRefs = !cfg.beatRefs || !bestRef || o.avg > bestRef.avg;
  return { judge: j, status: meetsBar && beatsRefs ? 'pass' : 'not yet', ours: { ...o, scores: ours.scores }, bestRef, meetsBar, beatsRefs };
}

function compareRow(n, j, cfg) {
  try {
    const c = loadResult(n, j, 'compare', cfg);
    return c ? { judge: j, status: 'ok', ...c } : { judge: j, status: 'not run' };
  } catch (e) {
    return { judge: j, status: 'invalid', error: e.message };
  }
}

function examLine(exam, cfg) {
  if (exam.state === 'none') return 'taste exam: not taken. Judges are unverified (run `exam build`).';
  if (exam.state === 'stale') return 'taste exam: out of date (taste rules, notes, prompts or models changed). Retake it with `exam run`.';
  const parts = cfg.judges.map((j) => {
    const r = exam.results.judges[j];
    if (!r || r.agreement == null) return `${j} not tested`;
    return `${j} ${Math.round(r.agreement * 100)}% agree, ${r.consistency == null ? '?' : Math.round(r.consistency * 100)}% consistent${r.fit ? '' : ' UNFIT'}`;
  });
  return `taste exam: ${parts.join('; ')}`;
}

function loadChecks(n) {
  const p = join(roundDir(n), 'checks.json');
  return existsSync(p) ? readJson(p) : null;
}

// Categories that stayed under the threshold, with almost no gain, over the last three
// accepted rounds (this round included). Small fixes are not moving them.
function stuckCategories(n, cfg, judges) {
  const series = [Number(n)];
  for (let m = Number(n) - 1; m >= 1 && series.length < 3; m--) {
    const p = join(roundDir(m), 'tally.json');
    if (existsSync(p) && readJson(p).accepted) series.unshift(m);
  }
  if (series.length < 3) return [];
  const meanOf = (m) => Object.fromEntries(CAT_KEYS.map((k) => {
    const vals = judges.map((j) => {
      let res = null;
      try {
        res = loadResult(m, j, 'score', cfg);
      } catch {}
      return res?.products?.find((p) => p.name === cfg.product)?.scores?.[k];
    }).filter((v) => typeof v === 'number');
    return [k, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null];
  }));
  const means = series.map(meanOf);
  return CAT_KEYS
    .filter((k) => means.every((x) => x[k] != null && x[k] < cfg.threshold) && means[2][k] - means[0][k] < 0.25)
    .map((k) => ({ category: k, rounds: series, means: means.map((x) => Math.round(x[k] * 10) / 10) }));
}

function cmdTally(n) {
  const cfg = loadConfig();
  const round = Number(n);
  const products = productNames(images(n, cfg), cfg);
  const exam = examStatus(cfg);
  // Judges that failed the taste exam are shown, but never count toward a pass or a vote.
  const rows = cfg.judges.map((j) => ({ ...scoreRow(n, j, cfg, products), unfit: exam.unfit.has(j) }));
  const counted = rows.filter((r) => !r.unfit);
  const ran = counted.filter((r) => r.ours);
  const notRun = counted.filter((r) => r.status === 'not run');
  const base = baselineRound(n);
  const needCompare = Boolean(base && commonScreens(n, base).length);
  const compares = needCompare ? ran.map((r) => compareRow(n, r.judge, cfg)) : [];
  const checks = loadChecks(n);

  const refRule = cfg.beatRefs && products.length > 1 ? ', and average above the best reference app' : '';
  console.log(`Round ${n}. Pass rule per judge: every category >= ${cfg.threshold}${refRule}.\n`);
  for (const r of rows) {
    const tag = r.unfit ? '  (failed the taste exam: ignored)' : '';
    if (!r.ours) {
      console.log(`${r.judge.padEnd(8)} ${r.status}${r.error ? ` (${r.error})` : ''}${tag}`);
      continue;
    }
    const ref = r.bestRef ? `best ref ${r.bestRef.name} ${fmt(r.bestRef.avg)}` : 'no refs';
    console.log(`${r.judge.padEnd(8)} ${r.status.toUpperCase().padEnd(8)} avg ${fmt(r.ours.avg)}  weakest ${r.ours.minK} ${fmt(r.ours.min)}  ${ref}${tag}`);
  }
  if (ran.length) {
    console.log(`\n${'category'.padEnd(16)}${ran.map((r) => r.judge.padStart(9)).join('')}`);
    for (const k of CAT_KEYS) {
      const cells = ran.map((r) => `${r.ours.scores[k] < cfg.threshold ? '*' : ' '}${fmt(r.ours.scores[k])}`.padStart(9));
      console.log(`${k.padEnd(16)}${cells.join('')}`);
    }
    console.log(`(* below ${cfg.threshold})`);
  }

  if (checks) printChecks(checks);
  else console.log('\nchecks: not run (capture writes them)');

  const votes = { current: 0, previous: 0, tie: 0 };
  for (const c of compares) if (c.status === 'ok') votes[c.overall]++;
  const regression = needCompare && votes.previous > votes.current;
  if (needCompare) {
    console.log(`\ncompare with round ${base} (last accepted):`);
    for (const c of compares) {
      const what = c.status === 'ok' ? `prefers ${c.overall === 'tie' ? 'neither (tie)' : `the ${c.overall} version`}. ${c.reason}` : c.status;
      console.log(`  ${c.judge.padEnd(8)} ${what}${c.error ? ` (${c.error})` : ''}`);
    }
    console.log(`  votes: current ${votes.current}, previous ${votes.previous}, tie ${votes.tie} -> ${regression ? 'REGRESSION' : 'kept'}`);
  }

  const changes = loadChanges(n);
  if (changes) {
    const done = (changes.requests ?? []).filter((c) => c.status === 'done').length;
    const declined = (changes.requests ?? []).filter((c) => c.status === 'declined').length;
    console.log(`\nchanges for this round (requests from round ${changes.from}): ${done} done, ${declined} declined, ${(changes.extra ?? []).length} extra`);
  }

  console.log(`\n${examLine(exam, cfg)}`);

  const stuck = ran.length ? stuckCategories(n, cfg, ran.map((r) => r.judge)) : [];
  if (stuck.length) {
    console.log(`\nstuck: under ${cfg.threshold} with almost no gain over rounds ${stuck[0].rounds.join(', ')} (mean of the judges):`);
    for (const s of stuck) console.log(`  ${s.category.padEnd(16)} ${s.means.map(fmt).join(' -> ')}`);
    console.log('  Small fixes are not moving these. Make one structural change for each in the next round.');
  }

  const quota = quotaReport(n, cfg);
  if (quota) printQuota(quota);
  else console.log(`\nquota: not recorded for round ${n}. Run \`quota ${n}\` after judging.`);

  const invalid = [...counted, ...compares].filter((r) => r.status === 'invalid').map((r) => r.judge);
  const missingCompare = compares.filter((c) => c.status === 'not run').map((c) => c.judge);
  const allPass = ran.length > 0 && ran.every((r) => r.status === 'pass');
  const checksPass = checks ? checks.pass : true;
  const atMax = round >= cfg.maxRounds;
  let next;
  if (!counted.length) next = 'STOP: no judge passed the taste exam. Ask the user: try other models, or edit the taste rules and retake it';
  else if (invalid.length) next = `rerun judge ${[...new Set(invalid)].join(', ')} on round ${n} (invalid output)`;
  // Every judge that passed the taste exam judges every round.
  else if (notRun.length) next = `run judge ${notRun.map((r) => r.judge).join(', ')} on round ${n}: every judge scores every round`;
  else if (missingCompare.length) next = `run the comparison for ${missingCompare.join(', ')} on round ${n}`;
  else if (regression) {
    next = atMax
      ? `STOP: max rounds (${cfg.maxRounds}) reached. Revert round ${n}'s commit first: judges prefer round ${base}`
      : `REGRESSION: judges prefer round ${base}. Revert round ${n}'s commit, run \`fixes ${n}\` and try different fixes, then capture round ${round + 1}`;
  } else if (allPass && checksPass) next = 'PASS: every judge passes and every check passes';
  else if (atMax) next = `STOP: max rounds (${cfg.maxRounds}) reached without a pass`;
  else {
    next = `run \`fixes ${n}\`, make or decline every request, then capture round ${round + 1}`;
    if (stuck.length) next += `. Stuck: ${stuck.map((s) => s.category).join(', ')}: make one structural change for each`;
  }
  if (quota?.low.length && !next.startsWith('PASS')) {
    const low = quota.low.map((r) => `${r.judge} ${r.name} ${pct(r.left)} left${r.roundsLeft != null ? ` (~${r.roundsLeft} rounds)` : ''}, resets ${when(r.resetsAt)}`);
    next += `. QUOTA LOW: ${low.join('; ')}. Ask the user before round ${round + 1}`;
  }
  console.log(`\nNEXT: ${next}`);

  const complete = !invalid.length && ran.length > 0 && !notRun.length && !missingCompare.length;
  const accepted = round === 1 || (complete && !regression);
  writeJson(join(roundDir(n), 'tally.json'), {
    round,
    threshold: cfg.threshold,
    baseline: base,
    accepted,
    votes: needCompare ? votes : null,
    checksPass: checks ? checks.pass : null,
    stuck,
    next,
    judges: rows,
  });
}

function cmdIssues(n) {
  const cfg = loadConfig();
  const { unfit } = examStatus(cfg);
  const judges = cfg.judges.filter((j) => !unfit.has(j));
  const checks = loadChecks(n);
  if (checks && !checks.pass) {
    console.log('== Objective check failures (fix all of these) ==');
    for (const c of checks.contrast) {
      console.log(`[check] contrast ${c.shot}: "${c.text}" ${c.fg} on ${c.bg} at ${c.size}px = ${c.ratio}:1, needs ${c.need}:1 (${c.count} element${c.count > 1 ? 's' : ''})`);
    }
    for (const shot of checks.overflow) console.log(`[check] horizontal overflow on ${shot}`);
    for (const g of checks.gates.filter((x) => !x.pass && x.values)) {
      console.log(`[check] ${g.value} ${g.name}, limit ${g.limit}: ${g.values.join(', ')}`);
    }
    console.log('');
  }

  const base = baselineRound(n);
  if (base) {
    const perScreen = new Map();
    for (const j of judges) {
      let c;
      try {
        c = loadResult(n, j, 'compare', cfg);
      } catch {
        continue;
      }
      for (const s of c?.screens ?? []) {
        const e = perScreen.get(s.screen) ?? { current: 0, previous: 0, tie: 0, reasons: [] };
        e[s.winner]++;
        if (s.winner === 'previous') e.reasons.push(`${j}: ${s.reason}`);
        perScreen.set(s.screen, e);
      }
    }
    const worse = [...perScreen].filter(([, e]) => e.previous > e.current);
    if (worse.length) {
      console.log(`== Screens that got worse than round ${base} ==`);
      for (const [screen, e] of worse) console.log(`[worse] ${screen} (previous ${e.previous}, current ${e.current})\n  ${e.reasons.join('\n  ')}`);
      console.log('');
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  const all = [];
  for (const j of judges) {
    let d;
    try {
      d = loadResult(n, j, 'score', cfg);
    } catch {
      continue;
    }
    if (!d) continue;
    if (d.summary) console.log(`${j} summary: ${d.summary}\n`);
    for (const i of d.issues ?? []) all.push({ judge: j, ...i });
  }
  all.sort((a, b) => (rank[a.severity] ?? 1) - (rank[b.severity] ?? 1) || a.screen.localeCompare(b.screen));
  if (all.length) console.log('== Judge issues ==');
  for (const i of all) {
    console.log(`[${i.severity}] ${i.screen} / ${i.category} (${i.judge})${i.where ? ` @ ${i.where}` : ''}\n  problem: ${i.problem}\n  fix: ${i.fix}`);
  }
  if (!all.length) console.log('No judge issues found. Run the judges first.');
  if (checks?.tells?.length) {
    console.log('\n== AI-slop tells (remove them, unless council/style.md calls for them) ==');
    for (const t of checks.tells) console.log(`[tell] ${t.label} [${t.name}] x${t.count} on ${t.shots.join(', ')}${t.examples.length ? `: "${t.examples.join('", "')}"` : ''}`);
  }
  console.log(`\nRun \`fixes ${n}\` to turn all of this into the change list for round ${Number(n) + 1}.`);
}

function cmdHistory() {
  const cfg = loadConfig();
  const base = join(DIR, 'rounds');
  const rounds = existsSync(base)
    ? readdirSync(base).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b)
    : [];
  if (!rounds.length) return console.log('No rounds yet.');
  console.log('Our scores per judge, as average / weakest category.\n');
  console.log(`${'round'.padEnd(7)}${cfg.judges.map((j) => j.padStart(13)).join('')}  checks  votes(c/p/t)  kept`);
  for (const n of rounds) {
    const cells = cfg.judges.map((j) => {
      try {
        const d = loadResult(n, j, 'score', cfg);
        if (!d) return '-'.padStart(13);
        const s = stats(d.products.find((x) => x.name === cfg.product).scores);
        return `${fmt(s.avg)} / ${fmt(s.min)}`.padStart(13);
      } catch {
        return 'invalid'.padStart(13);
      }
    });
    const t = join(roundDir(n), 'tally.json');
    const tally = existsSync(t) ? readJson(t) : {};
    const checks = tally.checksPass == null ? '-' : tally.checksPass ? 'pass' : 'fail';
    const votes = tally.votes ? `${tally.votes.current}/${tally.votes.previous}/${tally.votes.tie}` : '-';
    const kept = tally.accepted == null ? '-' : tally.accepted ? 'yes' : 'no';
    console.log(`${String(n).padEnd(7)}${cells.join('')}  ${checks.padEnd(6)}  ${votes.padEnd(12)}  ${kept}`);
  }
}

// ---------- taste exam ----------

const examPath = (...p) => join(EXAM_DIR, ...p);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');

function loadExam() {
  const p = examPath('exam.json');
  if (!existsSync(p)) die('no taste exam yet. Run `exam build` first.');
  return readJson(p);
}

async function shoot(browser, cfg, screen, theme, file, deg) {
  const context = await browser.newContext({
    viewport: cfg.viewport,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    storageState: cfg.storageState || undefined,
  });
  try {
    const page = await context.newPage();
    const url = theme ? screen.url.replaceAll('{theme}', theme) : screen.url;
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (screen.waitForSelector) await page.waitForSelector(screen.waitForSelector, { timeout: 30000 });
    await page.waitForTimeout(screen.waitMs ?? cfg.waitMs);
    if (deg) {
      const css = deg.css(theme === 'dark');
      if (css) await page.addStyleTag({ content: css });
      if (deg.js) await page.evaluate(deg.js);
      await page.waitForTimeout(300);
    }
    return await page.screenshot({ path: file, fullPage: Boolean(screen.fullPage ?? cfg.fullPage) });
  } finally {
    await context.close();
  }
}

async function cmdExamBuild(args = []) {
  const cfg = loadConfig();
  // --trusted: the current screens carry the design language well, so "made generic" has a right answer.
  const trusted = args.includes('--trusted');
  if (!cfg.screens?.length) die('no screens in council/config.json');
  if (cfg.storageState && !existsSync(cfg.storageState)) die(`storageState file not found: ${cfg.storageState}`);
  rmSync(EXAM_DIR, { recursive: true, force: true });
  mkdirSync(examPath('pairs'), { recursive: true });
  const id = Date.now().toString(36);
  const rand = rng(`exam:${id}`);
  const theme = cfg.themes?.[0] ?? null;
  const skip = new Set(cfg.exam.skip ?? []);
  const ofKind = (kind) => shuffle(Object.keys(DEGRADATIONS).filter((k) => DEGRADATIONS[k].kind === kind && !skip.has(k)), rand);
  const pools = [ofKind('flaw'), ofKind('tell')].filter((p) => p.length);
  const screens = shuffle(cfg.screens, rand);
  // Alternate flaws and tells across screens, without repeating a screen and recipe.
  const plan = [];
  const seen = new Set();
  for (let i = 0; plan.length < cfg.exam.size && i < cfg.exam.size * 4; i++) {
    const pool = pools[i % pools.length];
    const deg = pool[Math.floor(i / pools.length) % pool.length];
    const screen = screens[i % screens.length];
    if (seen.has(`${screen.name}|${deg}`)) continue;
    seen.add(`${screen.name}|${deg}`);
    plan.push({ screen, deg });
  }
  // One "made generic" pair per screen, up to three: does the judge value the product's own language?
  if (!skip.has('generic-kit')) for (const screen of screens.slice(0, 3)) plan.push({ screen, deg: 'generic-kit' });
  // Neutral file names, so nothing in a path tells which image is the original.
  const fileName = (tag) => `${createHash('sha1').update(`${id}:${tag}`).digest('hex').slice(0, 10)}.png`;

  const chromium = await loadChromium();
  let browser;
  try {
    browser = await chromium.launch();
  } catch (e) {
    die(/Executable doesn't exist/.test(e.message) ? `browser missing. Run: npx -y ${PLAYWRIGHT} install chromium` : e.message);
  }
  const items = [];
  const originals = new Map();
  try {
    for (const { screen, deg } of plan) {
      const name = slug(screen.name);
      try {
        if (!originals.has(name)) {
          const file = fileName(`original:${name}`);
          originals.set(name, { file, buf: await shoot(browser, cfg, screen, theme, examPath('pairs', file)) });
        }
        const original = originals.get(name);
        const file = fileName(`${name}:${deg}`);
        const buf = await shoot(browser, cfg, screen, theme, examPath('pairs', file), DEGRADATIONS[deg]);
        if (buf.equals(original.buf)) {
          rmSync(examPath('pairs', file));
          console.log(`skip ${name} / ${deg}: no visible change`);
          continue;
        }
        const kind = DEGRADATIONS[deg].kind;
        const expected = kind === 'style' && !trusted ? null : 'a';
        items.push({ kind, note: deg, screen: name, a: `pairs/${original.file}`, b: `pairs/${file}`, expected });
        console.log(`ok   ${name} / ${deg}`);
      } catch (e) {
        console.log(`FAIL ${name} / ${deg}: ${tail(e.message, 1)}`);
      }
    }
  } finally {
    await browser.close();
  }

  // Real before/after pairs from past rounds. Only your picks can answer these.
  const roundsDir = join(DIR, 'rounds');
  const rounds = existsSync(roundsDir) ? readdirSync(roundsDir).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b) : [];
  const kept = rounds.filter((k) => {
    const t = join(roundDir(k), 'tally.json');
    return shotsOf(k).length && (k === 1 || (existsSync(t) && readJson(t).accepted === true));
  });
  const last = kept.at(-1);
  if (last > 1 && kept[0] === 1) {
    for (const screen of commonScreens(last, 1).slice(0, cfg.exam.historyPairs)) {
      const fa = fileName(`round1:${screen}`);
      const fb = fileName(`round${last}:${screen}`);
      copyFileSync(shotsOf(1).find((s) => s.name === screen).path, examPath('pairs', fa));
      copyFileSync(shotsOf(last).find((s) => s.name === screen).path, examPath('pairs', fb));
      items.push({ kind: 'history', note: `round 1 vs round ${last}`, screen, a: `pairs/${fa}`, b: `pairs/${fb}`, expected: null });
    }
  }
  if (!items.length) die('no exam pairs could be made. Check that the screens load.');
  items.forEach((it, k) => { it.id = `q${String(k + 1).padStart(2, '0')}`; });

  const page = shuffle(items, rand).map((it) => ({ id: it.id, leftIsA: rand() < 0.5 }));
  const exam = { id, created: new Date().toISOString(), theme, items, page };
  writeJson(examPath('exam.json'), exam);
  writeFileSync(examPath('index.html'), examPage(exam));
  const count = (k) => items.filter((i) => i.kind === k).length;
  console.log(`\nExam ${id}: ${items.length} pairs (${count('flaw')} flaws, ${count('tell')} AI tells, ${count('style')} made generic, ${count('history')} from past rounds).`);
  console.log(`Your part: open ${rel(examPath('index.html'))} in a browser, pick the better screen in each pair, then paste the code.`);
}

function examPage(exam) {
  const byId = Object.fromEntries(exam.items.map((it) => [it.id, it]));
  const data = {
    id: exam.id,
    items: exam.page.map((p) => {
      const it = byId[p.id];
      return p.leftIsA ? { left: it.a, right: it.b } : { left: it.b, right: it.a };
    }),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Taste exam</title>
<style>
:root { --bg: #f6f6f4; --card: #ffffff; --ink: #1b1b1a; --muted: #5f5f5b; --line: #d9d9d4; }
@media (prefers-color-scheme: dark) { :root { --bg: #141413; --card: #1d1d1b; --ink: #ededea; --muted: #a3a39e; --line: #33332f; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 1600px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0; }
p { color: var(--muted); margin: 8px 0 16px; }
.progress { color: var(--muted); font-variant-numeric: tabular-nums; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 800px) { .pair { grid-template-columns: 1fr; } }
.side { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
.side img { width: 100%; height: auto; display: block; border-radius: 4px; }
button { font: inherit; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--ink); cursor: pointer; }
button.pick { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.row { display: flex; gap: 8px; justify-content: center; margin-top: 16px; flex-wrap: wrap; }
textarea { width: 100%; font: 14px ui-monospace, Menlo, monospace; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--ink); }
</style>
</head>
<body>
<main>
<header><h1>Taste exam</h1><span class="progress" id="progress"></span></header>
<p>Pick the better-designed screen in each pair. Go with your eye. Click a screen to open it full size. Keys: left arrow, right arrow, down arrow for "can't tell", Backspace to go back.</p>
<section id="q">
  <div class="pair">
    <div class="side"><a id="la" target="_blank" rel="noopener"><img id="li" alt="Left screen"></a><button class="pick" id="lb">Left is better</button></div>
    <div class="side"><a id="ra" target="_blank" rel="noopener"><img id="ri" alt="Right screen"></a><button class="pick" id="rb">Right is better</button></div>
  </div>
  <div class="row"><button id="tb">Can't tell</button><button id="bb">Back</button></div>
</section>
<section id="done" hidden>
  <h2>Done</h2>
  <p>Copy this code and paste it into the chat with Claude.</p>
  <textarea id="code" rows="2" readonly></textarea>
  <div class="row"><button class="pick" id="copy">Copy code</button><button id="redo">Start over</button></div>
</section>
</main>
<script>
const EXAM = ${json};
const KEY = 'ui-council-exam-' + EXAM.id;
const $ = (id) => document.getElementById(id);
let answers = [];
try { answers = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { answers = []; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(answers)); } catch (e) {} }
function show() {
  const i = answers.length;
  const done = i >= EXAM.items.length;
  $('q').hidden = done;
  $('done').hidden = !done;
  if (done) {
    $('progress').textContent = 'Done';
    $('code').value = EXAM.id + ':' + answers.join('');
    return;
  }
  const it = EXAM.items[i];
  $('li').src = $('la').href = it.left;
  $('ri').src = $('ra').href = it.right;
  $('progress').textContent = (i + 1) + ' of ' + EXAM.items.length;
  window.scrollTo(0, 0);
}
function pick(c) { if (answers.length < EXAM.items.length) { answers.push(c); save(); show(); } }
function back() { answers.pop(); save(); show(); }
$('lb').onclick = () => pick('L');
$('rb').onclick = () => pick('R');
$('tb').onclick = () => pick('T');
$('bb').onclick = back;
$('redo').onclick = () => { answers = []; save(); show(); };
$('copy').onclick = async () => {
  $('code').select();
  try { await navigator.clipboard.writeText($('code').value); } catch (e) { document.execCommand('copy'); }
  $('copy').textContent = 'Copied';
};
document.addEventListener('keydown', (e) => {
  if ($('q').hidden) return;
  if (e.key === 'ArrowLeft') pick('L');
  else if (e.key === 'ArrowRight') pick('R');
  else if (e.key === 'ArrowDown') pick('T');
  else if (e.key === 'Backspace') { e.preventDefault(); back(); }
});
show();
</script>
</body>
</html>
`;
}

function cmdExamAnswer(code) {
  const exam = loadExam();
  const m = /^([a-z0-9]+):([LRT]+)$/i.exec(String(code ?? '').trim());
  if (!m) die('the code should look like "<exam id>:<letters>", as shown at the end of the exam page.');
  if (m[1] !== exam.id) die(`that code is for exam ${m[1]}, but the current exam is ${exam.id}. Take the exam page again.`);
  const picks = m[2].toUpperCase();
  if (picks.length !== exam.page.length) die(`the code has ${picks.length} answers, but the exam has ${exam.page.length} pairs.`);
  const answers = {};
  exam.page.forEach((p, k) => {
    const c = picks[k];
    answers[p.id] = c === 'T' ? 'tie' : (c === 'L') === p.leftIsA ? 'a' : 'b';
  });
  writeJson(examPath('answers.json'), { examId: exam.id, answers });
  const ties = Object.values(answers).filter((a) => a === 'tie').length;
  console.log(`Saved ${picks.length} picks (${ties} "can't tell"). Run \`exam score\` after the judges take the exam.`);
}

function decodeExam(obj, order, xIsA) {
  if (!obj || !Array.isArray(obj.pairs)) throw new Error('missing "pairs" array');
  const picks = {};
  for (const x of obj.pairs) {
    const it = order[parseInt(String(x?.pair ?? '').replace(/\D/g, ''), 10) - 1];
    if (!it) continue;
    const s = String(x?.pick ?? '').trim().replace(/^version\s+/i, '').toUpperCase();
    if (s === 'TIE') picks[it.id] = 'tie';
    else if (s === 'X') picks[it.id] = xIsA[it.id] ? 'a' : 'b';
    else if (s === 'Y') picks[it.id] = xIsA[it.id] ? 'b' : 'a';
  }
  const answered = Object.keys(picks).length;
  if (answered < order.length * 0.75) throw new Error(`answered only ${answered} of ${order.length} pairs`);
  return { picks };
}

// Pass 1 and pass 2 show every pair with X and Y swapped, in a different order.
function examTask(judge, pass, cfg) {
  const exam = loadExam();
  const p = Number(pass);
  if (p !== 1 && p !== 2) die('exam pass must be 1 or 2');
  const mapRand = rng(`exam:${exam.id}:${judge}:map`);
  const xIsA = Object.fromEntries(exam.items.map((it) => [it.id, mapRand() < 0.5]));
  if (p === 2) for (const k of Object.keys(xIsA)) xIsA[k] = !xIsA[k];
  const order = shuffle(exam.items, rng(`exam:${exam.id}:${judge}:order${p}`));
  const tag = `p${p}`;
  const hash = tasteHash(cfg);
  writeJson(examPath(`${judge}.${tag}.blind.json`), { order: order.map((it) => it.id), xIsA, hash });
  const items = blindCopies(
    examPath('blind', `${judge}-${tag}`),
    order.flatMap((it, k) =>
      ['X', 'Y'].map((v) => ({ path: examPath((v === 'X') === xIsA[it.id] ? it.a : it.b), label: `Pair ${k + 1}, Version ${v}` })),
    ),
  );
  const numbers = order.map((_, k) => String(k + 1));
  const shapeText = [
    '{',
    '  "pairs": [',
    `    { "pair": "<1 to ${order.length}>", "pick": "X | Y | tie" }`,
    '  ]',
    '}',
    '',
    'Include every pair exactly once.',
  ].join('\n');
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['pairs'],
    properties: {
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['pair', 'pick'],
          properties: { pair: { type: 'string', enum: numbers }, pick: { type: 'string', enum: ['X', 'Y', 'tie'] } },
        },
      },
    },
  };
  return {
    dir: EXAM_DIR,
    tag,
    prompt: fill('exam.md', { IMAGES: manifest(judge, items), OUTPUT: output(judge, shapeText, examPath(`${judge}.${tag}.raw.json`)) }),
    schema,
    images: items.map((i) => i.path),
    outFile: `${judge}.${tag}.json`,
    rawFile: `${judge}.${tag}.raw.json`,
    decode: (obj) => ({ ...decodeExam(obj, order, xIsA), hash }),
  };
}

function loadExamResult(judge, tag) {
  const out = examPath(`${judge}.${tag}.json`);
  const raw = examPath(`${judge}.${tag}.raw.json`);
  if (existsSync(raw) && (!existsSync(out) || statSync(raw).mtimeMs > statSync(out).mtimeMs)) {
    const map = readJson(examPath(`${judge}.${tag}.blind.json`));
    const decoded = decodeExam(extractJson(readFileSync(raw, 'utf8')), map.order.map((id) => ({ id })), map.xIsA);
    writeJson(out, { ...decoded, hash: map.hash });
  }
  return existsSync(out) ? readJson(out) : null;
}

async function cmdExamRun(names) {
  const cfg = loadConfig();
  loadExam();
  const list = names.length ? names : cfg.judges.filter((j) => EXTERNAL.includes(j));
  checkExternal(list);
  await runJobs(cfg, list.flatMap((j) => [[j, examTask(j, 1, cfg)], [j, examTask(j, 2, cfg)]]));
}

function cmdExamPrompt(judge = 'claude', pass) {
  const cfg = loadConfig();
  const task = examTask(judge, pass, cfg);
  for (const f of [task.outFile, task.rawFile]) rmSync(examPath(f), { force: true });
  if (judge === 'claude') console.error(claudeHint(cfg));
  console.log(task.prompt);
}

function cmdExamScore() {
  const cfg = loadConfig();
  const exam = loadExam();
  const hash = tasteHash(cfg);
  const answersFile = examPath('answers.json');
  const saved = existsSync(answersFile) ? readJson(answersFile) : null;
  const user = saved?.examId === exam.id ? saved.answers : {};
  // The right answer: the user's pick when there is one, else the built-in answer.
  const truth = {};
  for (const it of exam.items) {
    const t = user[it.id] ?? it.expected;
    if (t === 'a' || t === 'b') truth[it.id] = t;
  }

  const judges = {};
  for (const j of cfg.judges) {
    const passes = ['p1', 'p2'].map((tag) => {
      try {
        const r = loadExamResult(j, tag);
        return r && r.hash === hash ? r.picks : null;
      } catch {
        return null;
      }
    });
    if (!passes[0] && !passes[1]) {
      judges[j] = { agreement: null, consistency: null, fit: null, note: 'not taken, or taken under old taste rules' };
      continue;
    }
    let correct = 0;
    let total = 0;
    const byKind = {};
    for (const it of exam.items) {
      if (!truth[it.id]) continue;
      for (const picks of passes) {
        if (!picks?.[it.id]) continue;
        const ok = picks[it.id] === truth[it.id];
        const k = (byKind[it.kind] ??= { correct: 0, total: 0 });
        total++;
        k.total++;
        if (ok) {
          correct++;
          k.correct++;
        }
      }
    }
    let same = 0;
    let both = 0;
    if (passes[0] && passes[1]) {
      for (const it of exam.items) {
        const [x, y] = [passes[0][it.id], passes[1][it.id]];
        if (x && y) {
          both++;
          if (x === y) same++;
        }
      }
    }
    const agreement = total ? correct / total : null;
    const consistency = both ? same / both : null;
    const fit = agreement == null || consistency == null
      ? null
      : agreement >= cfg.exam.minAgreement && consistency >= cfg.exam.minConsistency;
    judges[j] = { agreement, consistency, fit, byKind, note: passes[0] && passes[1] ? '' : 'only one pass taken' };
  }

  const ruleItems = exam.items.filter((it) => it.expected && (user[it.id] === 'a' || user[it.id] === 'b'));
  const disagreed = ruleItems.filter((it) => user[it.id] !== it.expected);
  const answered = Object.keys(user).length;
  writeJson(examPath('results.json'), {
    examId: exam.id,
    hash,
    scoredAt: new Date().toISOString(),
    userAnswered: answered,
    minAgreement: cfg.exam.minAgreement,
    minConsistency: cfg.exam.minConsistency,
    judges,
    user: {
      ruleItems: ruleItems.length,
      agreedWithRules: ruleItems.length - disagreed.length,
      disagreed: disagreed.map((it) => ({ kind: it.kind, note: it.note, screen: it.screen })),
    },
  });

  const pct = (x) => (x == null ? '  -' : `${Math.round(x * 100)}%`.padStart(4));
  const frac = (b) => (b ? `${b.correct}/${b.total}` : '-');
  const count = (k) => exam.items.filter((i) => i.kind === k).length;
  console.log(`Taste exam ${exam.id}: ${exam.items.length} pairs (${count('flaw')} flaws, ${count('tell')} AI tells, ${count('style')} made generic, ${count('history')} from past rounds).`);
  console.log(answered ? `Right answers: your ${answered} picks first, then the built-in answers.` : 'Right answers: built-in only. You have not taken the exam yet.');
  console.log(`Fit means at least ${pct(cfg.exam.minAgreement).trim()} agreement and ${pct(cfg.exam.minConsistency).trim()} consistency when pairs are swapped.\n`);
  console.log(`${'judge'.padEnd(8)} agree  consistent  flaws   tells   generic rounds  verdict`);
  for (const j of cfg.judges) {
    const r = judges[j];
    const verdict = r.fit == null ? (r.note || 'unknown') : r.fit ? 'fit' : 'UNFIT: ignored by tally';
    console.log(`${j.padEnd(8)} ${pct(r.agreement)}   ${pct(r.consistency)}        ${frac(r.byKind?.flaw).padEnd(7)} ${frac(r.byKind?.tell).padEnd(7)} ${frac(r.byKind?.style).padEnd(7)} ${frac(r.byKind?.history).padEnd(7)} ${verdict}`);
  }
  // Judges start at a moderate effort. One that fails moves up a step before anything else changes.
  for (const j of cfg.judges.filter((x) => judges[x].fit === false)) {
    const now = j === 'agy' ? (cfg.models?.agy ?? AGY_MODEL).split('-').at(-1) : (cfg.efforts?.[j] ?? 'default');
    const up = nextEffort(now);
    console.log(
      up === now
        ? `\n${j} is unfit at its deepest effort. Try another model for it in models.${j}, then retake its part.`
        : `\n${j} is unfit at effort ${now}. Raise it one step to ${up} (${j === 'agy' ? `the models.agy variant ending in -${up}, if agy lists one` : `efforts.${j}`}), then retake its part.`,
    );
  }
  if (!answered) {
    console.log(`\nJudges were checked against the built-in answers only. Take the exam yourself: open ${rel(examPath('index.html'))}.`);
  } else if (ruleItems.length) {
    console.log(`\nYou agreed with the built-in answer on ${ruleItems.length - disagreed.length} of ${ruleItems.length} pairs.`);
    for (const d of disagreed) {
      console.log(`  You preferred the "${d.note}" version (${d.kind === 'tell' ? 'an AI tell' : 'a flaw'}) on ${d.screen}.`);
    }
    if (disagreed.some((d) => d.kind === 'tell')) {
      console.log('  Where that is your real taste, edit council/taste.md, then retake the judge part with `exam run`.');
    }
  }
}

// ---------- gallery ----------

const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// council/gallery/index.html: every round's screenshots with numbered changes, scores, checks, votes and requests.
function cmdGallery() {
  const cfg = loadConfig();
  const base = join(DIR, 'rounds');
  const rounds = existsSync(base) ? readdirSync(base).filter((d) => /^\d+$/.test(d)).map(Number).sort((a, b) => a - b) : [];
  if (!rounds.length) die('no rounds yet.');
  const t = cfg.threshold;
  const catName = (k) => ({ color_contrast: 'Color & contrast', spacing_layout: 'Spacing & layout' })[k] ?? k[0].toUpperCase() + k.slice(1);
  const one = (x) => (x == null ? '' : x.toFixed(1));
  const tryResult = (n, j) => {
    try {
      return loadResult(n, j, 'score', cfg);
    } catch {
      return null;
    }
  };

  const data = rounds.filter((n) => shotsOf(n).length).map((n) => {
    const dir = roundDir(n);
    const read = (f) => (existsSync(join(dir, f)) ? readJson(join(dir, f)) : null);
    const tally = read('tally.json') ?? {};
    const changes = read('changes.json');
    const results = Object.fromEntries(cfg.judges.map((j) => [j, tryResult(n, j)]));
    const scores = Object.fromEntries(cfg.judges.map((j) => {
      const ours = results[j]?.products?.find((p) => p.name === cfg.product);
      return [j, ours ? { scores: ours.scores, ...stats(ours.scores) } : null];
    }));
    // People see the full page; with marks when this round has them.
    const view = existsSync(join(dir, 'full')) ? 'full' : 'shots';
    const shots = listImages(join(dir, view)).map((f) => ({
      name: basename(f, extname(f)),
      clean: `${view}/${f}`,
      marked: existsSync(join(dir, 'marked', f)) ? `marked/${f}` : null,
    }));
    const md = existsSync(join(dir, 'changes.md')) ? readFileSync(join(dir, 'changes.md'), 'utf8') : '';
    return { n, tally, checks: loadChecks(n), changes, numbered: numberedChanges(changes), md, results, scores, shots };
  });

  const verdict = (r) => {
    const next = r.tally.next ?? '';
    if (next.startsWith('PASS')) return ['pass', 'Council passed'];
    if (r.n === 1) return ['base', 'Starting point'];
    if (r.tally.votes && r.tally.votes.previous > r.tally.votes.current) return ['rejected', 'Judged worse: reverted'];
    if (r.tally.accepted === false) return ['base', 'Incomplete'];
    if (r.tally.accepted) return ['kept', 'Kept, more to fix'];
    return ['base', 'Not tallied'];
  };
  const passed = data.find((r) => (r.tally.next ?? '').startsWith('PASS'));

  const progress = `<table class="grid"><thead><tr><th>Round</th>${cfg.judges.map((j) => `<th>${esc(j)}<span>avg / lowest</span></th>`).join('')}<th>Checks</th><th>Changes<span>done / declined</span></th><th>Verdict</th></tr></thead><tbody>
${data.map((r) => {
  const [cls, text] = verdict(r);
  const cells = cfg.judges.map((j) => {
    const s = r.scores[j];
    return s ? `<td class="${s.min >= t ? 'ok' : 'low'}">${one(s.avg)} / ${one(s.min)}</td>` : '<td class="none">not run</td>';
  }).join('');
  const declined = (r.changes?.requests ?? []).filter((c) => c.status === 'declined').length;
  const ch = r.changes ? `${r.numbered.length} / ${declined}` : '-';
  return `<tr><th><a href="#r${r.n}">Round ${r.n}</a></th>${cells}<td class="${r.checks?.pass ? 'ok' : 'low'}">${r.checks ? (r.checks.pass ? 'pass' : 'fail') : '-'}</td><td>${ch}</td><td><span class="chip ${cls}">${text}</span></td></tr>`;
}).join('\n')}</tbody></table>`;

  // What each round cost, from council/usage.jsonl, and the quota left after the latest recorded round.
  const usage = readUsage();
  const kTok = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : `${Math.round(x / 1000)}k`);
  const costOf = (n) => {
    const by = {};
    for (const u of usage.filter((x) => x.where === `rounds/${n}`)) {
      const b = (by[u.judge] ??= { total: 0, seconds: 0, calls: 0 });
      b.total += u.total ?? 0;
      b.seconds += u.seconds ?? 0;
      b.calls++;
    }
    return by;
  };
  const withQuota = data.filter((r) => existsSync(quotaPath(r.n))).at(-1);
  const quota = withQuota ? quotaReport(withQuota.n, cfg) : null;
  const perRound = {};
  for (const r of data) for (const [j, c] of Object.entries(costOf(r.n))) (perRound[j] ??= []).push(c.total);
  const avgTok = Object.entries(perRound).map(([j, xs]) => `${esc(j)} about ${kTok(xs.reduce((a, x) => a + x, 0) / xs.length)} tokens a round`).join(', ');
  const quotaPanel = quota
    ? `<section class="quota"><h2>Quota left after round ${quota.round}</h2>
<table class="grid"><thead><tr><th>Judge</th><th>Limit</th><th>Left</th><th>Resets</th><th>More rounds<span>at the recent rate</span></th></tr></thead><tbody>
${quota.rows.map((q) => `<tr><th>${esc(q.judge)}</th><td>${esc(q.name)}</td><td class="${q.left < 10 || (q.roundsLeft != null && q.roundsLeft < 2) ? 'low' : 'ok'}">${pct(q.left)}</td><td>${esc(when(q.resetsAt))}</td><td>${q.roundsLeft != null ? `about ${q.roundsLeft}` : '<span class="muted">not known yet</span>'}</td></tr>`).join('\n')}
</tbody></table>${avgTok ? `<p class="src">${avgTok}. Claude judges run as subagents of the session, so their tokens are not counted here.</p>` : ''}</section>`
    : '';

  const sections = data.map((r) => {
    const [cls, text] = verdict(r);
    const cost = Object.entries(costOf(r.n));
    const costLine = cost.length
      ? `<p class="src">Cost: ${cost.map(([j, c]) => `${esc(j)} ${kTok(c.total)} tokens in ${Math.round(c.seconds / 60)} min`).join(', ')}.</p>`
      : '';
    const ran = cfg.judges.filter((j) => r.scores[j]);
    const table = ran.length
      ? `<table class="grid scores"><thead><tr><th>Category</th>${ran.map((j) => `<th>${esc(j)}</th>`).join('')}</tr></thead><tbody>${CAT_KEYS.map((k) => `<tr><th>${catName(k)}</th>${ran.map((j) => { const v = r.scores[j].scores[k]; return `<td class="${v >= t ? 'ok' : 'low'}">${one(v)}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`
      : '<p class="muted">No judge scored this round.</p>';
    const gates = (r.checks?.gates ?? []).map((g) => `<li class="${g.pass ? 'ok' : 'low'}">${esc(g.name)}: ${g.value} (limit ${g.limit})</li>`).join('');
    const tells = (r.checks?.tells ?? []).map((x) => `<li class="warn">AI tell: ${esc(x.label)} (${x.count})${x.examples.length ? `, e.g. “${esc(x.examples[0])}”` : ''}</li>`).join('');
    const votes = r.tally.votes ? `<p>Blind before/after vote against round ${r.tally.baseline}: ${r.tally.votes.current} prefer this round, ${r.tally.votes.previous} the earlier one, ${r.tally.votes.tie} tie.</p>` : '';
    const shots = r.shots.map((x) => {
      // The file's time in the URL, so a browser never shows an old capture of the same round.
      const url = (f) => `../rounds/${r.n}/${f}?v=${Math.round(statSync(join(roundDir(r.n), f)).mtimeMs)}`;
      const src = url(x.marked ?? x.clean);
      const clean = x.marked ? ` · <a href="${url(x.clean)}" target="_blank" rel="noopener">clean</a>` : '';
      return `<figure><a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="Round ${r.n}, ${esc(x.name)}${x.marked ? ', changes marked' : ''}" loading="lazy"></a><figcaption>${esc(x.name.replace(/--light$/, ''))}${x.marked ? ' · changes marked' : ''}${clean}</figcaption></figure>`;
    }).join('');

    let changes = '';
    if (r.changes) {
      const tag = (c) => `<span class="src">${esc([c.from, screenOf(c.screen) || null, c.category || null].filter(Boolean).join(' · '))}</span>`;
      const made = r.numbered.map((c) => `<li value="${c.num}">${tag(c)}<p><b>Asked:</b> ${c.fix ? esc(c.fix) : '<i>not requested: the builder\'s own change</i>'}</p><p><b>Done:</b> ${esc(c.did)}</p></li>`).join('');
      const no = (r.changes.requests ?? []).filter((c) => c.status === 'declined');
      const declined = no.length
        ? `<details><summary>Declined (${no.length})</summary><ul class="plain">${no.map((c) => `<li>${tag(c)}<p><b>Asked:</b> ${esc(c.fix)}</p><p><b>Why not:</b> ${esc(c.did)}</p></li>`).join('')}</ul></details>`
        : '';
      changes = `<div class="changes"><h3>Changes in this round</h3><p class="muted">Requested by the council in round ${r.changes.from}. Numbers match the blue boxes on the screenshots.${r.changes.commit ? ` Commit ${esc(r.changes.commit)}.` : ''}</p><ol>${made}</ol>${declined}</div>`;
    } else if (r.md) {
      changes = `<details class="changes"><summary>What changed in this round</summary><pre>${esc(r.md)}</pre></details>`;
    }

    const asked = ran.map((j) => {
      const list = r.results[j]?.issues ?? [];
      return list.length ? `<h4>${esc(j)}</h4><ul class="plain">${list.map((i) => `<li><span class="src">${esc(i.severity)} · ${esc(screenOf(i.screen))} · ${esc(i.category)}${i.where ? ` · ${esc(i.where)}` : ''}</span><p>${esc(i.problem)}</p><p><b>Fix:</b> ${esc(i.fix)}</p></li>`).join('')}</ul>` : '';
    }).join('');
    const count = ran.reduce((s, j) => s + (r.results[j]?.issues?.length ?? 0), 0);
    const requests = count ? `<details class="changes"><summary>What the council asked for after this round (${count})</summary>${asked}</details>` : '';

    return `<section class="round" id="r${r.n}">
  <header><h2>Round ${r.n}</h2><span class="chip ${cls}">${text}</span></header>
  <div class="shots">${shots}</div>
  ${changes}
  <div class="facts">
    <div>${table}</div>
    <div><h3>Objective checks</h3><ul class="gates">${gates}${tells}</ul>${votes}${costLine}</div>
  </div>
  ${requests}
</section>`;
  }).join('\n');

  const name = cfg.product[0].toUpperCase() + cfg.product.slice(1);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} council rounds</title>
<style>
:root { --bg: #f7f7f5; --card: #fff; --ink: #1d1d1b; --muted: #62625d; --line: #dededa; --ok: #1f6b3a; --ok-bg: #e5f2e8; --low: #9a3412; --low-bg: #fbeae2; --mark: #1463ff; --warn: #8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1e1e1c; --ink: #ececea; --muted: #a2a29c; --line: #34342f; --ok: #7fd19b; --ok-bg: #1d3325; --low: #f5a37c; --low-bg: #3a2219; --mark: #7aa5ff; --warn: #e8b85a; } }
* { box-sizing: border-box; }
a { color: var(--ok); }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
main { max-width: 1400px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 4px; } h2 { font-size: 22px; margin: 0; } h3 { font-size: 15px; margin: 0 0 8px; } h4 { font-size: 14px; margin: 12px 0 4px; }
.muted, .lede { color: var(--muted); }
.lede { max-width: 75ch; margin: 0 0 24px; }
.grid { border-collapse: collapse; width: 100%; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; font-variant-numeric: tabular-nums; }
.grid th, .grid td { padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left; }
.grid thead th { font-size: 13px; color: var(--muted); font-weight: 600; }
.grid thead th span { display: block; font-weight: 400; }
td.ok { color: var(--ok); } td.low { color: var(--low); } td.none { color: var(--muted); }
.chip { display: inline-block; font-size: 13px; font-weight: 600; padding: 2px 10px; border-radius: 999px; background: var(--line); }
.chip.pass, .chip.kept { background: var(--ok-bg); color: var(--ok); }
.chip.rejected { background: var(--low-bg); color: var(--low); }
.quota { margin: 0 0 32px; } .quota h2 { margin-bottom: 12px; } .quota p { margin: 8px 0 0; }
.round { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--line); }
.round header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; align-items: start; }
figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
figure img { width: 100%; height: auto; display: block; border-radius: 4px; }
figcaption { font-size: 13px; color: var(--muted); padding: 6px 2px 0; }
.facts { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 24px; margin-top: 16px; }
@media (max-width: 800px) { .facts { grid-template-columns: 1fr; } }
.gates { list-style: none; padding: 0; margin: 0 0 12px; } .gates li { padding: 2px 0; } .gates li.ok { color: var(--ok); } .gates li.low { color: var(--low); } .gates li.warn { color: var(--warn); }
.changes { margin-top: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; }
.changes ol { margin: 8px 0 0; padding-left: 0; list-style: none; counter-reset: none; }
.changes ol li { position: relative; padding: 8px 0 8px 44px; border-top: 1px solid var(--line); }
.changes ol li::before { content: attr(value); position: absolute; left: 0; top: 8px; min-width: 30px; height: 30px; border-radius: 15px; background: var(--mark); color: #fff; font: 700 14px/30px system-ui, sans-serif; text-align: center; }
.changes p { margin: 2px 0; }
.src { font-size: 13px; color: var(--muted); }
ul.plain { list-style: none; padding: 0; margin: 8px 0 0; } ul.plain li { padding: 6px 0; border-top: 1px solid var(--line); }
summary { cursor: pointer; font-weight: 600; }
pre { white-space: pre-wrap; font: 13px/1.5 ui-monospace, Menlo, monospace; margin: 8px 0 0; }
</style></head>
<body><main>
<h1>${esc(name)}: every round</h1>
<p class="lede">${data.length} rounds. The goal: every judge at ${t} or higher in every category, and every objective check passing. ${passed ? `Reached in round ${passed.n}.` : 'Not reached yet.'} Blue numbered boxes on a round's screenshots mark each change made for that round, and the list under them says which judge asked for it. Judges always score clean screenshots. Green means ${t} or higher. Click a screenshot to open it full size. <a href="#r${data.at(-1).n}">Jump to the latest round</a>.</p>
${quotaPanel}
${progress}
${sections}
</main></body></html>
`;
  mkdirSync(join(DIR, 'gallery'), { recursive: true });
  const out = join(DIR, 'gallery', 'index.html');
  writeFileSync(out, html);
  console.log(`wrote ${rel(out)} (${data.length} rounds)`);
}

// ---------- main ----------

const USAGE = `usage: node council.mjs <command>   (run from the project root)
  init                      create ./council with config.json, notes.md, refs/
  capture <round>           screenshot every screen and theme, run the objective checks
  judge <round> [judge...]  run external judges in parallel (codex, agy, gemini):
                            blind scoring, plus comparison with the last accepted round
  prompt <round> [kind]     print a Claude subagent prompt: claude (scoring) or
                            claude-compare (comparison, round 2 on)
  tally <round>             scores, checks, comparison, and the NEXT step
  issues <round>            check failures, screens that got worse, judge issues, AI tells
  fixes <round> [--force]   write rounds/<round+1>/changes.json: every request from <round>,
                            to mark "done" (what changed, where) or "declined" (why)
  history                   scores, checks, and votes across rounds
  gallery                   write council/gallery/index.html: every round, changes marked
  serve [port]              serve council/ on 127.0.0.1 (default 8766) to view the gallery
  models [--apply] [--claude <model>] [--effort <level>]
                            list each judge's models; --apply saves the most capable model
                            at the judging effort (default high)
  quota [round] [--claude "5-hour:<used>[@reset],weekly:<used>[@reset]"]
                            quota left for each judge; with a round, save it and estimate
                            how many more rounds each limit allows

taste exam (checks each judge's taste against yours):
  exam build [--trusted]    make pairs: uglified copies of your screens, plus past rounds.
                            --trusted: the screens already carry their design language well
  exam answer <code>        save your picks (the code at the end of council/exam/index.html)
  exam run [judge...]       external judges take the exam twice, pairs swapped (codex, agy, gemini)
  exam prompt claude <1|2>  print the Claude subagent exam prompt for pass 1 or 2
  exam score                agreement and consistency per judge; unfit judges stop counting`;

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'init':
    cmdInit();
    break;
  case 'capture':
    await cmdCapture(rest[0]);
    break;
  case 'judge':
    await cmdJudge(rest[0], rest.slice(1));
    break;
  case 'prompt':
    cmdPrompt(rest[0], rest[1]);
    break;
  case 'tally':
    cmdTally(rest[0]);
    break;
  case 'issues':
    cmdIssues(rest[0]);
    break;
  case 'fixes':
    cmdFixes(rest[0], rest.slice(1));
    break;
  case 'history':
    cmdHistory();
    break;
  case 'gallery':
    cmdGallery();
    break;
  case 'serve':
    await cmdServe(rest[0]);
    break;
  case 'models':
    await cmdModels(rest);
    break;
  case 'quota':
    await cmdQuota(rest);
    break;
  case 'exam': {
    const [sub, ...args] = rest;
    if (sub === 'build') await cmdExamBuild(args);
    else if (sub === 'answer') cmdExamAnswer(args.join(''));
    else if (sub === 'run') await cmdExamRun(args);
    else if (sub === 'prompt') cmdExamPrompt(args[0], args[1]);
    else if (sub === 'score') cmdExamScore();
    else {
      console.log(USAGE);
      process.exit(1);
    }
    break;
  }
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
