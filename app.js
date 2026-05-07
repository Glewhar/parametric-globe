// Earth Globe Builder -- static viewer with continent visibility, body
// labels, and a January→December season slider.
//
// Loads globe.glb (one named mesh per body, name "<continent>__<region>__<biome>_r<idx>")
// plus regions.json, biomes.json, and seasons.json. The slider reads per-body
// per-month hex colours from seasons.json and updates each mesh's
// MeshStandardMaterial.color on every `input` event (live recolour while
// dragging). May is preselected to match the master SVG. Hidden continents
// and label visibility are persisted in localStorage.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = (sel) => document.querySelector(sel);
const continentTogglesEl = $('#continent-toggles');
const toggleLabels = $('#toggle-labels');
const tooltipEl = $('#hover-tooltip');
const monthLabelEl = $('#season-month');
const playerToggle = $('#player-toggle');
const playerTrack = $('#player-track');
const playerFill = $('#player-fill');
const playerDots = $('#player-dots');
const playerSection = $('#hud-top');
const advancedDetails = $('#hud-advanced');

const HIDDEN_KEY = 'hiddenContinents';
const SHOW_LABELS_KEY = 'showLabels';
const PLAYING_KEY = 'seasonPlaying';
const MONTH_KEY = 'monthIndex';
const ADVANCED_OPEN_KEY = 'advancedOpen';
const MONTH_TICK_MS = 500;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

let regionsCfg = null;
let appState = null;
let scene, camera, renderer, controls, labelRenderer;
let labelLayer = null;
let globeMesh = null;
let R_globe = 50;

const OCEAN_HEX = '#1e507c';        // deep-water blue
const BASE_SPHERE_NAMES = new Set(['__base_sphere__', 'ocean_sphere']);

// Latitude-based "spotlight on the equator" effect: equatorial belt stays
// full-bright, polar caps get pushed down to LATITUDE_LIGHT.polarFloor.
// Tweak live: __viewer.scene.traverse(o => { const s = o.material?.userData?.shader;
//             if (s) s.uniforms.uPolarFloor.value = 0.05; });
const LATITUDE_LIGHT = {
  polarFloor: 0.45,
  falloffPow: 1.5,
};

// Earth's axial tilt; the sun's apparent latitude vs the equator follows a
// cosine of monthIndex with this amplitude.
const AXIAL_TILT_DEG = 23.5;

function patchLatitudeShading(material, sphereRadius) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSphereRadius = { value: sphereRadius };
    shader.uniforms.uPolarFloor   = { value: LATITUDE_LIGHT.polarFloor };
    shader.uniforms.uFalloffPow   = { value: LATITUDE_LIGHT.falloffPow };

    // Pass the polar-axis distance (world-space |y|, since the parent group
    // rotates CAD +Z into world +Y) through to the fragment shader.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying float vPolarAbs;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\n' +
        'vPolarAbs = abs((modelMatrix * vec4(position, 1.0)).y);');

    // Hook in after <dithering_fragment> -- the chunk name is stable across
    // every three.js version we care about. Multiplying gl_FragColor.rgb
    // post-tonemap is fine for a visualization knob (not physically lit).
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\n' +
        'varying float vPolarAbs;\n' +
        'uniform float uSphereRadius;\n' +
        'uniform float uPolarFloor;\n' +
        'uniform float uFalloffPow;')
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\n' +
        'float _polar = clamp(vPolarAbs / uSphereRadius, 0.0, 1.0);\n' +
        'float _equatorial = sqrt(max(0.0, 1.0 - _polar * _polar));\n' +
        'float _latFactor = mix(uPolarFloor, 1.0, pow(_equatorial, uFalloffPow));\n' +
        'gl_FragColor.rgb *= _latFactor;');

    material.userData.shader = shader;
  };
  material.needsUpdate = true;
}

// ---------------------------------------------------------------- state

function buildState(regionsCfg, biomeColors, seasons) {
  const continents = [];
  const byBodyName = new Map();
  const bodyToRegion = new Map();

  for (const cont of regionsCfg.continents || []) {
    const regions = [];
    for (const reg of cont.regions || []) {
      const bodies = [];
      for (const b of reg.bodies || []) {
        const meshName = `${cont.id}__${reg.id}__${b.biome_id}_r${b.region_idx}`;
        const bodyState = {
          id: `${b.biome_id}_r${b.region_idx}`,
          name: b.name || `${b.biome_id}_r${b.region_idx}`,
          meshName,
          biomeId: b.biome_id,
          elevationMm: typeof b.elevation_mm === 'number' ? b.elevation_mm : null,
          centroid: b.centroid_lonlat || [0, 0],
        };
        bodies.push(bodyState);
        byBodyName.set(meshName, bodyState);
      }
      const regionState = {
        id: reg.id,
        parentId: reg.parent_id || null,
        name: reg.name,
        contId: cont.id,
        path: `${cont.id}/${reg.id}`,
        kind: reg.kind,
        latitudeZone: reg.latitude_zone,
        centroid: reg.centroid_lonlat || [0, 0],
        isWater: !!reg.is_water,
        bodies,
      };
      bodies.forEach((b) => bodyToRegion.set(b.meshName, regionState));
      regions.push(regionState);
    }
    continents.push({
      id: cont.id,
      name: cont.name,
      regions,
    });
  }

  let hidden;
  try {
    hidden = new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]'));
  } catch {
    hidden = new Set();
  }

  // Default month index = May (0-based 4). The seasons artifact records the
  // master month it was built from; if that's a different month we still want
  // May preselected per UX spec.
  const monthIndex = 4;

  return {
    continents,
    byBodyName,
    bodyToRegion,
    biomeColors,
    seasons,
    monthIndex,
    bodyColorTable: [],
    hidden,
    showLabels: localStorage.getItem(SHOW_LABELS_KEY) === '1',
  };
}

// ---------------------------------------------------------------- 3D scene

let sunLight = null;
let fillLight = null;

function initScene() {
  const viewer = $('#viewer');
  scene = new THREE.Scene();
  // Background lives on #viewer (CSS radial gradient) plus a starfield mesh
  // added in addStarfield(); the scene itself stays transparent.
  scene.background = null;

  const aspect = viewer.clientWidth / viewer.clientHeight;
  camera = new THREE.PerspectiveCamera(38, aspect, 0.5, 5000);
  camera.position.set(140, 80, 140);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  viewer.appendChild(renderer.domElement);

  // PBR environment probe — RoomEnvironment is a procedural studio scene that
  // PMREM bakes into a mip chain. No external HDRI download; ~20 ms init.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(viewer.clientWidth, viewer.clientHeight);
  const lbl = labelRenderer.domElement;
  lbl.style.position = 'absolute';
  lbl.style.inset = '0';
  lbl.style.pointerEvents = 'none';
  viewer.appendChild(lbl);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  // Two-light rig: warm key (camera-locked + tilted by season) and a cool
  // fill on the night side so the unlit hemisphere reads as shadowed Earth
  // rather than a void. Hemisphere light gives a subtle sky/ground bounce;
  // the env probe replaces what AmbientLight used to do.
  const hemiLight = new THREE.HemisphereLight(0xcadcef, 0x141923, 0.30);
  scene.add(hemiLight);

  sunLight = new THREE.DirectionalLight(0xffe6b8, 2.6);
  sunLight.position.copy(camera.position);
  sunLight.target.position.set(0, 0, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);

  fillLight = new THREE.DirectionalLight(0x8aa6cc, 0.45);
  fillLight.position.copy(camera.position).negate();
  fillLight.target.position.set(0, 0, 0);
  scene.add(fillLight);
  scene.add(fillLight.target);

  // Expose for debugging / scripted screenshots.
  window.__viewer = { THREE, scene, camera, controls, renderer, sunLight, fillLight };

  function applyViewerSize() {
    const w = viewer.clientWidth, h = viewer.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
  }

  window.addEventListener('resize', applyViewerSize);
  requestAnimationFrame(applyViewerSize);

  function tick() {
    requestAnimationFrame(tick);
    controls.update();
    updateSunPosition();
    updateLabelVisibility();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  tick();
}

// --------------- seasonal sun tilt (camera-locked + axial tilt) ---------------

const _sunCamDir = new THREE.Vector3();
const _sunAxis = new THREE.Vector3();
const _sunUp = new THREE.Vector3(0, 1, 0);
const _sunFallbackAxis = new THREE.Vector3(1, 0, 0);

function updateSunPosition() {
  if (!sunLight) return;
  const dist = camera.position.length();
  _sunCamDir.copy(camera.position).normalize();

  // axis perpendicular to (camDir, worldUp) — rotation around it by a positive
  // angle tilts camDir toward +Y (north pole), regardless of camera orbit.
  _sunAxis.crossVectors(_sunCamDir, _sunUp);
  if (_sunAxis.lengthSq() < 1e-6) {
    _sunAxis.copy(_sunFallbackAxis);
  } else {
    _sunAxis.normalize();
  }

  // monthIndex 0 = January (~mid winter NH); cos(π * (m+0.5)/6) is +1 in Jan
  // and −1 in Jul. Multiply by −AXIAL_TILT_DEG so Jan biases the sun south.
  const m = appState ? appState.monthIndex : 4;
  const tiltRad = THREE.MathUtils.degToRad(-AXIAL_TILT_DEG)
                * Math.cos((m + 0.5) * Math.PI / 6);

  _sunCamDir.applyAxisAngle(_sunAxis, tiltRad).multiplyScalar(dist);
  sunLight.position.copy(_sunCamDir);
  if (fillLight) fillLight.position.copy(_sunCamDir).negate();
}

// ---------------- lon/lat → cartesian (CAD frame +Z = north) ----------------

function lonLatDegToXYZ(lonDeg, latDeg, R) {
  const u = ((lonDeg + 180) * Math.PI) / 180;
  const v = (latDeg * Math.PI) / 180;
  const cosV = Math.cos(v);
  return new THREE.Vector3(R * cosV * Math.cos(u),
                           R * cosV * Math.sin(u),
                           R * Math.sin(v));
}

// ---------------------------------------------------------------- GLB load

const loader = new GLTFLoader();

// --------------- atmosphere rim (back-faced sphere, additive Fresnel) ---------------
//
// Subtle blue glow at the limb. Cheap: ~6 k tris, no per-frame work, just a
// Fresnel term in the fragment shader. depthWrite is off so it never occludes
// the globe; AdditiveBlending so the night side still gets a soft hint.
function addAtmosphere(R) {
  const geom = new THREE.SphereGeometry(R * 1.08, 64, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(0x6aa3ff) },
      uIntensity: { value: 0.35 },
      uPower: { value: 3.0 },
    },
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uPower;
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        // BackSide → vNormal points inward; flip for view-facing dot.
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float fres = pow(1.0 - abs(dot(viewDir, normalize(-vNormal))), uPower);
        gl_FragColor = vec4(uColor * fres * uIntensity, fres);
      }
    `,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 1; // draw after the globe so the additive blend reads right
  scene.add(mesh);
  if (window.__viewer) window.__viewer.atmosphere = mesh;
}

// --------------- starfield ---------------
//
// ~600 points scattered on a large sphere. sizeAttenuation off so stars stay
// crisp regardless of camera distance.
function addStarfield(R) {
  const N = 600;
  const radius = R * 18;
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    // uniform on sphere via Marsaglia
    let u, v, s;
    do {
      u = Math.random() * 2 - 1;
      v = Math.random() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1);
    const f = 2 * Math.sqrt(1 - s);
    const x = u * f;
    const y = v * f;
    const z = 1 - 2 * s;
    positions[i * 3 + 0] = x * radius;
    positions[i * 3 + 1] = y * radius;
    positions[i * 3 + 2] = z * radius;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.2,
    sizeAttenuation: false,
    color: 0xffffff,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
  });
  const stars = new THREE.Points(geom, mat);
  scene.add(stars);
  if (window.__viewer) window.__viewer.stars = stars;
}

function colorForBody(meshName, body) {
  // Per-month colour from seasons.json wins; fall back to biomes.json so a
  // missing seasons.json or stale entry still renders sensibly.
  const seasonalColours = appState.seasons?.bodies?.[meshName];
  if (seasonalColours) {
    const c = seasonalColours[appState.monthIndex];
    if (c) return c;
  }
  if (body) return appState.biomeColors.get(body.biomeId) || '#888888';
  return '#888888';
}

function loadGlobe() {
  return new Promise((resolve, reject) => {
    const url = 'globe.glb' + (window.__assetCacheBuster || '');
    loader.load(url, (gltf) => {
      const root = gltf.scene;

      let unassignedSeen = 0;
      root.traverse((o) => {
        if (o.isMesh) {
          if (o.name.startsWith('unassigned__')) {
            o.visible = false;
            unassignedSeen++;
            return;
          }
          if (BASE_SPHERE_NAMES.has(o.name)) {
            o.material = new THREE.MeshStandardMaterial({
              color: new THREE.Color(OCEAN_HEX),
              roughness: 0.55,
              metalness: 0.0,
              envMapIntensity: 0.6,
              side: THREE.FrontSide,
              flatShading: false,
            });
            patchLatitudeShading(o.material, R_globe);
            if (!o.geometry.attributes.normal) {
              o.geometry.computeVertexNormals();
            }
            o.userData.isBaseSphere = true;
            return;
          }
          const region = appState.bodyToRegion.get(o.name);
          const body = appState.byBodyName.get(o.name);
          const hex = colorForBody(o.name, body);
          o.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(hex),
            roughness: 0.78,
            metalness: 0.0,
            envMapIntensity: 0.5,
            side: THREE.DoubleSide,
            flatShading: false,
          });
          patchLatitudeShading(o.material, R_globe);
          if (!o.geometry.attributes.normal) {
            o.geometry.computeVertexNormals();
          }
          o.userData.regionId = region?.id;
          o.userData.regionName = region?.name;
          o.userData.contId = region?.contId;
          o.userData.isWater = !!region?.isWater;
          o.userData.continentName = region ? appState.continents.find(
            (c) => c.id === region.contId)?.name : null;

          // Cache the per-month colour list for this mesh so the slider can
          // recolour O(n_bodies) without traversing the scene each time.
          const seasonal = appState.seasons?.bodies?.[o.name];
          if (seasonal) {
            appState.bodyColorTable.push({ mesh: o, colors: seasonal });
          }
        }
      });
      if (unassignedSeen > 0) {
        console.warn(`hid ${unassignedSeen} unassigned__* mesh(es) — `
          + `regions.json out of sync with globe.glb`);
      }

      // CAD +Z = north pole; rotate so three.js +Y points to the north pole.
      root.rotation.x = -Math.PI / 2;
      scene.add(root);
      globeMesh = root;

      addAtmosphere(R_globe);
      addStarfield(R_globe);

      rebuildLabels();
      applyVisibility();

      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3()).length();
      const center = box.getCenter(new THREE.Vector3());
      controls.target.copy(center);
      camera.near = size / 200;
      camera.far = size * 20;
      camera.updateProjectionMatrix();
      const dist = size * 1.45;
      camera.position.copy(center).add(new THREE.Vector3(dist, dist * 0.55, dist));
      controls.update();
      resolve();
    }, undefined, reject);
  });
}

// ---------------------------------------------------------------- labels

function rebuildLabels() {
  if (labelLayer) {
    while (labelLayer.children.length) {
      const o = labelLayer.children[0];
      if (o.element && o.element.parentNode) {
        o.element.parentNode.removeChild(o.element);
      }
      labelLayer.remove(o);
    }
  }
  if (!globeMesh || !appState) return;

  labelLayer = new THREE.Group();
  labelLayer.name = '__labels__';
  globeMesh.add(labelLayer);

  for (const c of appState.continents) {
    for (const r of c.regions) {
      if (r.isWater) continue;
      const div = document.createElement('div');
      div.className = 'region-label';
      div.textContent = r.name;
      const obj = new CSS2DObject(div);
      const pos = lonLatDegToXYZ(r.centroid[0], r.centroid[1], R_globe * 1.04);
      obj.position.copy(pos);
      obj.userData = { region: r };
      labelLayer.add(obj);
    }
  }
}

const _camWorld = new THREE.Vector3();
const _labelWorld = new THREE.Vector3();

function updateLabelVisibility() {
  if (!labelLayer) return;
  const showing = !!appState?.showLabels;
  labelLayer.visible = showing;
  if (!showing) {
    for (const o of labelLayer.children) o.visible = false;
    return;
  }
  camera.getWorldPosition(_camWorld);
  const hidden = appState.hidden;
  for (const o of labelLayer.children) {
    const region = o.userData?.region;
    if (region && hidden.has(region.contId)) {
      o.visible = false;
      continue;
    }
    o.getWorldPosition(_labelWorld);
    o.visible = _labelWorld.dot(_camWorld) > 0;
  }
}

// ---------------------------------------------------------------- toggles

function renderToggles() {
  continentTogglesEl.replaceChildren();
  for (const c of appState.continents) {
    continentTogglesEl.appendChild(renderToggleRow(c.id, c.name));
  }
}

function renderToggleRow(contId, contName) {
  const row = document.createElement('label');
  row.className = 'toggle-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !appState.hidden.has(contId);
  cb.addEventListener('change', () => {
    if (cb.checked) appState.hidden.delete(contId);
    else appState.hidden.add(contId);
    persistHidden();
    applyVisibility();
  });
  const span = document.createElement('span');
  span.textContent = contName;
  row.append(cb, span);
  return row;
}

function persistHidden() {
  localStorage.setItem(HIDDEN_KEY,
    JSON.stringify(Array.from(appState.hidden)));
}

// ---------------------------------------------------------------- season player
//
// Auto-runs Jan→Dec at MONTH_TICK_MS per month, looping. Play/pause button
// toggles state; clicking a track dot scrubs without changing play state.
// State (current month + playing flag) persists in localStorage.

function recolorAtCurrentMonth() {
  if (!appState) return;
  const m = appState.monthIndex;
  monthLabelEl.textContent = MONTH_NAMES[m];
  if (playerFill) playerFill.style.width = `${((m + 1) / 12) * 100}%`;
  if (playerTrack) playerTrack.setAttribute('aria-valuenow', String(m + 1));
  updateDotStates(m);
  if (!appState.bodyColorTable) return;
  for (const e of appState.bodyColorTable) {
    e.mesh.material.color.set(e.colors[m]);
  }
}

function updateDotStates(currentIdx) {
  if (!playerDots) return;
  for (const dot of playerDots.children) {
    const i = Number(dot.dataset.idx);
    let state = 'future';
    if (i === currentIdx) state = 'current';
    else if (i < currentIdx) state = 'past';
    dot.dataset.state = state;
  }
}

function buildPlayerDots() {
  if (!playerDots) return;
  playerDots.replaceChildren();
  for (let i = 0; i < 12; i++) {
    const tick = document.createElement('span');
    tick.className = 'player-dot';
    tick.dataset.idx = String(i);
    tick.setAttribute('aria-hidden', 'true');
    playerDots.appendChild(tick);
  }
}

function monthFromTrackEvent(ev) {
  const rect = playerTrack.getBoundingClientRect();
  const x = (ev.clientX ?? 0) - rect.left;
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, rect.width)));
  // 12 equal segments — round to nearest, clamp to 0..11
  return Math.max(0, Math.min(11, Math.round(ratio * 11)));
}

function setMonth(m) {
  if (!appState) return;
  appState.monthIndex = m;
  localStorage.setItem(MONTH_KEY, String(m));
  recolorAtCurrentMonth();
}

function attachTrackScrub() {
  if (!playerTrack) return;
  let active = false;

  const onPointerDown = (ev) => {
    // Left mouse / primary touch only
    if (ev.button !== undefined && ev.button !== 0) return;
    active = true;
    try { playerTrack.setPointerCapture(ev.pointerId); } catch {}
    setMonth(monthFromTrackEvent(ev));
    ev.preventDefault();
  };
  const onPointerMove = (ev) => {
    if (!active) return;
    setMonth(monthFromTrackEvent(ev));
  };
  const onPointerUp = (ev) => {
    if (!active) return;
    active = false;
    try { playerTrack.releasePointerCapture(ev.pointerId); } catch {}
  };

  playerTrack.addEventListener('pointerdown', onPointerDown);
  playerTrack.addEventListener('pointermove', onPointerMove);
  playerTrack.addEventListener('pointerup', onPointerUp);
  playerTrack.addEventListener('pointercancel', onPointerUp);

  // Keyboard scrubbing (←/→) for accessibility.
  playerTrack.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') {
      setMonth((appState.monthIndex + 11) % 12);
      ev.preventDefault();
    } else if (ev.key === 'ArrowRight') {
      setMonth((appState.monthIndex + 1) % 12);
      ev.preventDefault();
    }
  });
}

function attachSpacebarToggle() {
  document.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' && ev.key !== ' ') return;
    // Don't hijack space inside text inputs / contenteditable surfaces
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    if (!appState) return;
    appState.playing = !appState.playing;
    localStorage.setItem(PLAYING_KEY, appState.playing ? '1' : '0');
    syncToggleVisual();
    ev.preventDefault();
  });
}

function setupSeasonPlayer() {
  // Restore persisted state.
  const storedMonth = localStorage.getItem(MONTH_KEY);
  if (storedMonth !== null) {
    const m = Math.max(0, Math.min(11, parseInt(storedMonth, 10) || 0));
    appState.monthIndex = m;
  }
  appState.playing = localStorage.getItem(PLAYING_KEY) === '1'; // default false (paused)

  buildPlayerDots();
  attachTrackScrub();
  attachSpacebarToggle();
  recolorAtCurrentMonth();
  syncToggleVisual();

  if (!appState.seasons?.bodies) {
    // No seasons artifact — disable controls visually but keep layout.
    if (playerToggle) playerToggle.disabled = true;
    return;
  }

  // Play/pause button.
  if (playerToggle) {
    playerToggle.addEventListener('click', () => {
      appState.playing = !appState.playing;
      localStorage.setItem(PLAYING_KEY, appState.playing ? '1' : '0');
      syncToggleVisual();
    });
  }

  // rAF-driven tick.
  let lastTick = performance.now();
  function frame(now) {
    if (appState.playing && now - lastTick >= MONTH_TICK_MS) {
      appState.monthIndex = (appState.monthIndex + 1) % 12;
      localStorage.setItem(MONTH_KEY, String(appState.monthIndex));
      recolorAtCurrentMonth();
      lastTick = now;
    } else if (!appState.playing) {
      // Reset baseline so resuming doesn't immediately fire a stale tick.
      lastTick = now;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function syncToggleVisual() {
  if (!playerToggle) return;
  const playing = !!appState?.playing;
  playerToggle.dataset.state = playing ? 'playing' : 'paused';
  playerToggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  playerToggle.setAttribute('title', playing ? 'Pause (Space)' : 'Play (Space)');
  if (playerSection) playerSection.dataset.state = playing ? 'playing' : 'paused';
}

function setupAdvancedDetails() {
  if (!advancedDetails) return;
  const open = localStorage.getItem(ADVANCED_OPEN_KEY) === '1';
  advancedDetails.open = open;
  advancedDetails.addEventListener('toggle', () => {
    localStorage.setItem(ADVANCED_OPEN_KEY,
      advancedDetails.open ? '1' : '0');
  });
}

function applyVisibility() {
  if (!globeMesh) return;
  const hidden = appState.hidden;
  globeMesh.traverse((o) => {
    if (!o.isMesh) return;
    const contId = o.userData?.contId;
    o.visible = !contId || !hidden.has(contId);
  });
}

// ---------------- hover tooltip ----------------

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();

function attachHoverTooltip() {
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!globeMesh) { tooltipEl.hidden = true; return; }
    const rect = renderer.domElement.getBoundingClientRect();
    _ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    _ray.setFromCamera(_ndc, camera);
    // Skip the base sphere (dark-blue mid_ocean): the ray should pass through
    // it to the wedge behind, and bare ocean has nothing to probe.
    const hit = _ray.intersectObject(globeMesh, true)
      .find((h) => h.object.visible && !h.object.userData?.isBaseSphere);
    if (!hit) { tooltipEl.hidden = true; return; }
    const region = appState.bodyToRegion.get(hit.object.name);
    if (!region) { tooltipEl.hidden = true; return; }
    const body = appState.byBodyName.get(hit.object.name);
    let txt = body?.name || region.name;
    if (body && typeof body.elevationMm === 'number') {
      txt += `  ·  ${body.elevationMm.toFixed(2)} mm`;
    }
    tooltipEl.textContent = txt;
    tooltipEl.style.transform =
      `translate(${e.clientX + 12}px, ${e.clientY + 12}px)`;
    tooltipEl.hidden = false;
  });
  renderer.domElement.addEventListener('pointerleave', () => {
    tooltipEl.hidden = true;
  });
}

// ---------------------------------------------------------------- bootstrap

async function main() {
  initScene();

  const _cb = '?v=' + Date.now();
  window.__assetCacheBuster = _cb;

  const [regions, biomes, seasons] = await Promise.all([
    fetch('regions.json' + _cb, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null),
    fetch('biomes.json' + _cb, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null),
    fetch('seasons.json' + _cb, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .catch(() => null),
  ]);

  if (!regions) {
    continentTogglesEl.textContent = 'regions.json missing.';
    return;
  }
  regionsCfg = regions;

  const biomeColors = new Map();
  for (const b of biomes?.biomes || []) {
    if (b?.id && b?.color) biomeColors.set(b.id, b.color);
  }
  R_globe = biomes?.sphere?.radius_mm ?? 50;

  appState = buildState(regions, biomeColors, seasons);

  // Expose appState so optional side-car modules (scenarios.js) can read
  // bodyColorTable. Read-only for them; never mutated by the core viewer.
  // Also expose recolorAtCurrentMonth so scenarios.js can repaint after a
  // scenario swap without duplicating recolor logic.
  if (window.__viewer) {
    window.__viewer.appState = appState;
    window.__viewer.recolorAtCurrentMonth = recolorAtCurrentMonth;
  }

  renderToggles();
  setupSeasonPlayer();
  setupAdvancedDetails();

  toggleLabels.checked = appState.showLabels;
  toggleLabels.addEventListener('change', () => {
    appState.showLabels = toggleLabels.checked;
    localStorage.setItem(SHOW_LABELS_KEY,
      appState.showLabels ? '1' : '0');
  });

  try {
    await loadGlobe();
  } catch (e) {
    console.error('failed to load globe.glb', e);
  }

  attachHoverTooltip();
}

main();
