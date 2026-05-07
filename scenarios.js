// scenarios.js — climate/disaster two-tier chip picker.
//
// Side-car of app.js: waits for the viewer to expose appState on
// window.__viewer, then fetches scenarios.json and renders a category
// chip row + intensity chip row inside #scenario-controls.

const SCENARIO_KEY = 'scenarioId';

// Tiny monochrome SVG icons (currentColor) — drawn in 24×24 viewBox.
const ICONS = {
  // Earth-ish ring + small dot for "normal"
  normal: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
  // Radioactive trefoil: center dot + three wedges 120° apart
  nuclear: '<circle cx="12" cy="12" r="2" fill="currentColor"/>'
    + '<path fill="currentColor" d="M12 3 a9 9 0 0 1 7.79 4.5 l-5.2 3 A3 3 0 0 0 12 9 z"/>'
    + '<path fill="currentColor" d="M19.79 16.5 a9 9 0 0 1 -15.58 0 l5.2 -3 A3 3 0 0 0 14.59 13.5 z"/>'
    + '<path fill="currentColor" d="M4.21 7.5 A9 9 0 0 1 12 3 v6 A3 3 0 0 0 9.41 10.5 z"/>',
  // Sun: filled circle + 8 rays
  heat: '<circle cx="12" cy="12" r="3.5" fill="currentColor"/>'
    + '<g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">'
    + '<line x1="12" y1="2.5" x2="12" y2="5.5"/>'
    + '<line x1="12" y1="18.5" x2="12" y2="21.5"/>'
    + '<line x1="2.5" y1="12" x2="5.5" y2="12"/>'
    + '<line x1="18.5" y1="12" x2="21.5" y2="12"/>'
    + '<line x1="5.2" y1="5.2" x2="7.3" y2="7.3"/>'
    + '<line x1="16.7" y1="16.7" x2="18.8" y2="18.8"/>'
    + '<line x1="5.2" y1="18.8" x2="7.3" y2="16.7"/>'
    + '<line x1="16.7" y1="7.3" x2="18.8" y2="5.2"/>'
    + '</g>',
  // Snowflake: 6-line star with small notches at the tips
  cold: '<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none">'
    + '<line x1="12" y1="3" x2="12" y2="21"/>'
    + '<line x1="4.2" y1="7.5" x2="19.8" y2="16.5"/>'
    + '<line x1="4.2" y1="16.5" x2="19.8" y2="7.5"/>'
    + '<path d="M10 4.5 L12 6 L14 4.5"/>'
    + '<path d="M10 19.5 L12 18 L14 19.5"/>'
    + '<path d="M3.6 9.2 L4.5 7 L6.7 7.5"/>'
    + '<path d="M17.3 16.5 L19.5 17 L20.4 14.8"/>'
    + '<path d="M3.6 14.8 L4.5 17 L6.7 16.5"/>'
    + '<path d="M17.3 7.5 L19.5 7 L20.4 9.2"/>'
    + '</g>',
  // Skull: dome + 2 eye sockets + simple jaw
  extinct: '<path fill="currentColor" d="M12 3a7 7 0 0 0-7 7v3.2l1.5 1.8v3h2v-2h1v2h3v-2h1v2h2v-3l1.5-1.8V10a7 7 0 0 0-7-7z"/>'
    + '<circle cx="9.3" cy="10.5" r="1.4" fill="#0c1118"/>'
    + '<circle cx="14.7" cy="10.5" r="1.4" fill="#0c1118"/>',
  // Mushroom: cap + stem + spots
  fungus: '<path fill="currentColor" d="M5 11a7 7 0 0 1 14 0v1H5z"/>'
    + '<rect x="10" y="12" width="4" height="8" rx="1.2" fill="currentColor"/>'
    + '<circle cx="9" cy="9" r="1" fill="#0c1118"/>'
    + '<circle cx="13.5" cy="8" r="0.8" fill="#0c1118"/>'
    + '<circle cx="15.5" cy="10" r="0.7" fill="#0c1118"/>',
};

function iconSvg(id) {
  const inner = ICONS[id] || '';
  return `<svg class="scenario-icon" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

const CATS = [
  {
    id: 'normal',
    label: 'Normal',
    options: [{ id: 'default', label: 'Normal' }],
  },
  {
    id: 'nuclear',
    label: 'Nuclear war',
    options: [
      { id: 'nuclear_t6h',    label: '+6 hours' },
      { id: 'nuclear_t1d',    label: '+1 day' },
      { id: 'nuclear_t50d',   label: '+50 days' },
      { id: 'nuclear_t1y',    label: '+1 year' },
      { id: 'nuclear_t5y',    label: '+5 years' },
      { id: 'nuclear_t100y',  label: '+100 years' },
      { id: 'nuclear_t1000y', label: '+1000 years' },
    ],
  },
  {
    id: 'heat',
    label: 'Heating',
    options: [
      { id: 'heat_p3',  label: '+3°' },
      { id: 'heat_p6',  label: '+6°' },
      { id: 'heat_p10', label: '+10°' },
      { id: 'heat_p20', label: '+20°' },
      { id: 'heat_p30', label: '+30°' },
      { id: 'heat_p50', label: '+50°' },
    ],
  },
  {
    id: 'cold',
    label: 'Cooling',
    options: [
      { id: 'cold_m3',  label: '−3°' },
      { id: 'cold_m6',  label: '−6°' },
      { id: 'cold_m10', label: '−10°' },
      { id: 'cold_m30', label: '−30°' },
      { id: 'cold_m50', label: '−50°' },
    ],
  },
  {
    id: 'extinct',
    label: 'Extinction',
    options: [
      { id: 'extinct_t1y',     label: '+1 year' },
      { id: 'extinct_t100y',   label: '+100 years' },
      { id: 'extinct_t10000y', label: '+10 000 years' },
    ],
  },
  {
    id: 'fungus',
    label: 'Fungus takeover',
    options: [
      { id: 'fungus_t5d',   label: '+5 days' },
      { id: 'fungus_t10d',  label: '+10 days' },
      { id: 'fungus_t30d',  label: '+30 days' },
      { id: 'fungus_t100d', label: '+100 days' },
    ],
  },
];

const OPTION_TO_CAT = (() => {
  const m = new Map();
  for (const cat of CATS) {
    for (const opt of cat.options) m.set(opt.id, cat.id);
  }
  return m;
})();

// --------------- atmosphere recipe per scenario ---------------
//
// Style fields: { color, intensity, power, sparkle, sparkleColor }.
// All optional — missing fields revert to atmosphere defaults
// (color=#6aa3ff, intensity=0.35, power=3.0, sparkle=0).
//
// Lower power = thicker rim glow; higher power = thinner rim. Sparkle adds
// twinkling spore-cloud pops at the rim (only used by fungus tiers).
const ATMOSPHERE_STYLES = {
  default:           { color: 0x6aa3ff, intensity: 0.35, power: 3.0 },

  // Nuclear: hot orange firestorm haze → soot black → brown smog → recovery.
  nuclear_t6h:       { color: 0xff5a18, intensity: 0.70, power: 2.2 },
  nuclear_t1d:       { color: 0xc0381a, intensity: 0.50, power: 2.4 },
  nuclear_t50d:      { color: 0x1a0e08, intensity: 0.18, power: 2.0 },
  nuclear_t1y:       { color: 0x4a3018, intensity: 0.22, power: 2.4 },
  nuclear_t5y:       { color: 0x8a6a4a, intensity: 0.26, power: 2.7 },
  nuclear_t100y:     { color: 0x6a8aa6, intensity: 0.30, power: 3.0 },
  nuclear_t1000y:    { color: 0x6aa3ff, intensity: 0.34, power: 3.0 },

  // Heating: cool blue → faint warm tint → soft pink → orange → molten red.
  // Curve held cool/neutral until +20°; the strong red only really kicks in
  // at +30° and lands as molten at +50°.
  heat_p3:           { color: 0x88abe5, intensity: 0.36, power: 3.0 },
  heat_p6:           { color: 0x9caedc, intensity: 0.38, power: 2.95 },
  heat_p10:          { color: 0xb4a8c8, intensity: 0.40, power: 2.85 },
  heat_p20:          { color: 0xd0a0a8, intensity: 0.46, power: 2.7 },
  heat_p30:          { color: 0xe88058, intensity: 0.55, power: 2.4 },
  heat_p50:          { color: 0xff4818, intensity: 0.75, power: 2.0 },

  // Cooling: progressively bleaker grey halo, slightly thinner each step.
  cold_m3:           { color: 0xcdd8e5, intensity: 0.32, power: 3.1 },
  cold_m6:           { color: 0xb0bcc8, intensity: 0.32, power: 3.2 },
  cold_m10:          { color: 0x98a4b0, intensity: 0.34, power: 3.3 },
  cold_m30:          { color: 0x828a96, intensity: 0.36, power: 3.4 },
  cold_m50:          { color: 0x707682, intensity: 0.40, power: 3.5 },

  // Extinction: cleaner air over time → slightly brighter, bluer.
  extinct_t1y:       { color: 0x6aa3ff, intensity: 0.34, power: 3.0 },
  extinct_t100y:     { color: 0x80b5ff, intensity: 0.40, power: 2.9 },
  extinct_t10000y:   { color: 0x95c5ff, intensity: 0.45, power: 2.8 },

  // Fungus: rainbow aurora wrapping the planet — gentle hue cycling driven
  // by world position. Sparkle is kept very subtle (faint twinkle, not a
  // dazzle). Earlier tiers stay close to the violet base; later tiers crank
  // up the rainbow to a full glowing band of color.
  fungus_t5d:        { color: 0xb0a0d0, intensity: 0.38, power: 2.9,
                       rainbow: 0.20, sparkle: 0.05, sparkleColor: 0xffe0ff },
  fungus_t10d:       { color: 0xc890e0, intensity: 0.45, power: 2.7,
                       rainbow: 0.45, sparkle: 0.10, sparkleColor: 0xffe0ff },
  fungus_t30d:       { color: 0xd070d8, intensity: 0.55, power: 2.5,
                       rainbow: 0.75, sparkle: 0.18, sparkleColor: 0xffe8ff },
  fungus_t100d:      { color: 0xe060e0, intensity: 0.65, power: 2.3,
                       rainbow: 1.00, sparkle: 0.25, sparkleColor: 0xffd0ff },
};

function applyAtmosphereForScenario(scenarioId) {
  const style = ATMOSPHERE_STYLES[scenarioId] || ATMOSPHERE_STYLES.default;
  const fn = window.__viewer?.setAtmosphereStyle;
  if (typeof fn === 'function') fn(style);
}

async function whenReady(predicate, timeoutMs = 15000) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const v = predicate();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function hidePicker() {
  const sec = document.getElementById('scenario-controls');
  if (sec) sec.hidden = true;
}

function showPicker() {
  const sec = document.getElementById('scenario-controls');
  if (sec) sec.hidden = false;
}

async function init() {
  const ready = await whenReady(() =>
    window.__viewer?.appState?.bodyColorTable instanceof Array
      ? window.__viewer.appState
      : null
  );
  if (!ready) {
    console.warn('[scenarios] appState not exposed by app.js — picker disabled');
    hidePicker();
    return;
  }

  let scenarios = null;
  const cb = window.__assetCacheBuster || ('?v=' + Date.now());
  try {
    const res = await fetch('scenarios.json' + cb, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    scenarios = await res.json();
  } catch (e) {
    console.info('[scenarios] scenarios.json not available — picker hidden:', e.message);
    hidePicker();
    return;
  }
  if (!scenarios?.bodies || typeof scenarios.bodies !== 'object') {
    console.warn('[scenarios] scenarios.json malformed — picker hidden');
    hidePicker();
    return;
  }

  const catsEl = document.getElementById('scenario-cats');
  const intsEl = document.getElementById('scenario-intensities');
  if (!catsEl || !intsEl) {
    console.warn('[scenarios] picker DOM missing');
    hidePicker();
    return;
  }

  const validIds = new Set((scenarios.scenarios || []).map((s) => s.id));
  const stored = localStorage.getItem(SCENARIO_KEY);
  let currentOptionId = (stored && validIds.has(stored)) ? stored : 'default';
  let currentCatId = OPTION_TO_CAT.get(currentOptionId) || 'normal';
  // Remember last-picked option per category so returning to a category
  // restores the user's previous intensity choice.
  const lastByCat = new Map();
  lastByCat.set(currentCatId, currentOptionId);

  function applyScenario(id) {
    let n_swapped = 0;
    let n_default_fallback = 0;
    for (const e of ready.bodyColorTable) {
      const perScenario = scenarios.bodies[e.mesh.name];
      if (!perScenario) continue;
      const next = perScenario[id];
      if (next && next.length === 12) {
        e.colors = next;
        n_swapped++;
      } else if (perScenario.default && perScenario.default.length === 12) {
        e.colors = perScenario.default;
        n_default_fallback++;
      }
    }
    // Recolor at the current month using the viewer's hoisted helper,
    // or fall back to a manual recolor if it isn't exposed yet.
    const recolor = window.__viewer?.recolorAtCurrentMonth;
    if (typeof recolor === 'function') {
      recolor();
    } else {
      const m = ready.monthIndex ?? 0;
      for (const e of ready.bodyColorTable) e.mesh.material.color.set(e.colors[m]);
    }
    if (n_default_fallback) {
      console.info(`[scenarios] ${id}: swapped ${n_swapped}, ` +
        `${n_default_fallback} fell back to default`);
    }
    applyAtmosphereForScenario(id);
  }

  function renderCats() {
    catsEl.replaceChildren();
    for (const cat of CATS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scenario-chip scenario-cat';
      btn.dataset.cat = cat.id;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', cat.id === currentCatId ? 'true' : 'false');
      // Icon + label
      btn.innerHTML = iconSvg(cat.id)
        + `<span class="scenario-label">${cat.label}</span>`;
      btn.addEventListener('click', () => onCatPick(cat.id));
      catsEl.appendChild(btn);
    }
  }

  function renderIntensities() {
    const cat = CATS.find((c) => c.id === currentCatId);
    // Only one option => no intensity row needed.
    const opts = (cat && cat.options.length > 1) ? cat.options : [];

    intsEl.classList.add('is-swapping');
    // Allow CSS transition to start before swapping content. setTimeout
    // (rather than rAF) so this still fires when the tab is in the
    // background, e.g. while the user reviews the picker briefly.
    setTimeout(() => {
      intsEl.replaceChildren();
      for (const opt of opts) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'scenario-chip scenario-intensity';
        btn.dataset.option = opt.id;
        btn.setAttribute('aria-pressed', opt.id === currentOptionId ? 'true' : 'false');
        btn.textContent = opt.label;
        btn.addEventListener('click', () => onOptionPick(opt.id));
        intsEl.appendChild(btn);
      }
      setTimeout(() => intsEl.classList.remove('is-swapping'), 16);
    }, 140);
  }

  function setSelected(catId, optionId) {
    currentCatId = catId;
    currentOptionId = optionId;
    lastByCat.set(catId, optionId);
    localStorage.setItem(SCENARIO_KEY, optionId);
    // Update aria states without re-rendering everything.
    for (const c of catsEl.children) {
      c.setAttribute('aria-selected', c.dataset.cat === catId ? 'true' : 'false');
    }
    for (const i of intsEl.children) {
      i.setAttribute('aria-pressed', i.dataset.option === optionId ? 'true' : 'false');
    }
  }

  function onCatPick(catId) {
    const cat = CATS.find((c) => c.id === catId);
    if (!cat) return;
    const remembered = lastByCat.get(catId);
    const optionId = (remembered && cat.options.some((o) => o.id === remembered))
      ? remembered
      : cat.options[0].id;
    const catChanged = catId !== currentCatId;
    setSelected(catId, optionId);
    if (catChanged) renderIntensities();
    applyScenario(optionId);
  }

  function onOptionPick(optionId) {
    const catId = OPTION_TO_CAT.get(optionId) || currentCatId;
    setSelected(catId, optionId);
    applyScenario(optionId);
  }

  renderCats();
  renderIntensities();
  showPicker();

  // Apply the restored scenario on load (no-op if 'default').
  if (currentOptionId !== 'default') applyScenario(currentOptionId);
}

init();
