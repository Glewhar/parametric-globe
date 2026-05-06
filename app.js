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

const $ = (sel) => document.querySelector(sel);
const continentTogglesEl = $('#continent-toggles');
const toggleLabels = $('#toggle-labels');
const tooltipEl = $('#hover-tooltip');
const monthSlider = $('#month-slider');
const monthLabelEl = $('#season-month');

const HIDDEN_KEY = 'hiddenContinents';
const SHOW_LABELS_KEY = 'showLabels';

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

const OCEAN_HEX = '#235e92';        // deep-water blue
const BASE_SPHERE_NAMES = new Set(['__base_sphere__', 'ocean_sphere']);

// Latitude-based "spotlight on the equator" effect: equatorial belt stays
// full-bright, polar caps get pushed down to LATITUDE_LIGHT.polarFloor.
// Tweak live: __viewer.scene.traverse(o => { const s = o.material?.userData?.shader;
//             if (s) s.uniforms.uPolarFloor.value = 0.05; });
const LATITUDE_LIGHT = {
  polarFloor: 0.40,
  falloffPow: 1.5,
};

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
    showLabels: localStorage.getItem(SHOW_LABELS_KEY) !== '0',
  };
}

// ---------------------------------------------------------------- 3D scene

function initScene() {
  const viewer = $('#viewer');
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1118);

  const aspect = viewer.clientWidth / viewer.clientHeight;
  camera = new THREE.PerspectiveCamera(38, aspect, 0.5, 5000);
  camera.position.set(140, 80, 140);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(viewer.clientWidth, viewer.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewer.appendChild(renderer.domElement);

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

  // Expose for debugging / scripted screenshots.
  window.__viewer = { THREE, scene, camera, controls, renderer };

  // Sun that follows the camera so the side facing the viewer is always
  // brightest. Low hemisphere/ambient sharpens the limb falloff.
  const hemiLight = new THREE.HemisphereLight(0xcadcef, 0x141923, 0.16);
  scene.add(hemiLight);
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.05);
  scene.add(ambientLight);
  const sunLight = new THREE.DirectionalLight(0xfff5d8, 1.55);
  sunLight.position.copy(camera.position);
  sunLight.target.position.set(0, 0, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);

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
    sunLight.position.copy(camera.position);
    updateLabelVisibility();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  tick();
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
              roughness: 0.7,
              metalness: 0.0,
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
            roughness: 0.85,
            metalness: 0.0,
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

// ---------------------------------------------------------------- season slider

function setupMonthSlider() {
  if (!monthSlider) return;
  const initial = appState.monthIndex + 1;
  monthSlider.value = String(initial);
  monthLabelEl.textContent = MONTH_NAMES[appState.monthIndex];
  if (!appState.seasons?.bodies) {
    // No seasons artifact yet — disable the slider but keep it visible.
    monthSlider.disabled = true;
    return;
  }
  monthSlider.addEventListener('input', (ev) => {
    const m = Math.max(1, Math.min(12, +ev.target.value)) - 1;
    appState.monthIndex = m;
    monthLabelEl.textContent = MONTH_NAMES[m];
    for (const e of appState.bodyColorTable) {
      e.mesh.material.color.set(e.colors[m]);
    }
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

  renderToggles();
  setupMonthSlider();

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
