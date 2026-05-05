// Earth Globe Builder -- static viewer with per-continent visibility toggles.
//
// Loads globe.glb (one named mesh per body, name "<continent>__<region>__<biome>_r<idx>")
// plus biomes.json and regions.json from the same directory. Renders the
// globe in three.js, paints each body with its per-region atlas color (or the
// biome color for water), shows optional region labels via CSS2DRenderer, and
// exposes a checkbox per continent (plus one for Water) that hides/shows the
// matching meshes. Hidden state is persisted in localStorage.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const $ = (sel) => document.querySelector(sel);
const continentTogglesEl = $('#continent-toggles');
const toggleLabels = $('#toggle-labels');
const tooltipEl = $('#hover-tooltip');

const HIDDEN_KEY = 'hiddenContinents';
const SHOW_LABELS_KEY = 'showLabels';

let biomesCfg = null;
let regionsCfg = null;
let appState = null;
let scene, camera, renderer, controls, labelRenderer;
let labelLayer = null;
let globeMesh = null;
let R_globe = 50;

// ---------------------------------------------------------------- state

function buildState(regionsCfg, biomesCfg) {
  const biomeColor = new Map(
    (biomesCfg.biomes || []).map((b) => [b.id, b.color])
  );
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
          centroid: b.centroid_lonlat || [0, 0],
        };
        bodies.push(bodyState);
        byBodyName.set(meshName, bodyState);
      }
      const regionState = {
        id: reg.id,
        name: reg.name,
        contId: cont.id,
        path: `${cont.id}/${reg.id}`,
        biomeId: bodies[0]?.biomeId || 'mid_ocean',
        biomeColor: biomeColor.get(bodies[0]?.biomeId) || '#888',
        regionColor: reg.color
          || biomeColor.get(bodies[0]?.biomeId) || '#888',
        centroid: reg.centroid_lonlat || [0, 0],
        isOcean: !!reg.is_ocean,
        isWater: !!reg.is_water,
        noLabel: !!reg.no_label || !!reg.is_water,
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

  return {
    continents,
    byBodyName,
    bodyToRegion,
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

  scene.add(new THREE.HemisphereLight(0xbecbe0, 0x202830, 0.55));
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.1);
  sun.position.set(180, 220, 130);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88a0c8, 0.35);
  fill.position.set(-160, -80, -180);
  scene.add(fill);

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

function loadGlobe() {
  return new Promise((resolve, reject) => {
    loader.load('globe.glb', (gltf) => {
      const root = gltf.scene;
      const biomeColor = new Map(
        (biomesCfg?.biomes || []).map((b) => [b.id, b.color])
      );

      root.traverse((o) => {
        if (o.isMesh) {
          const region = appState.bodyToRegion.get(o.name);
          const body = appState.byBodyName.get(o.name);
          const biomeId = body?.biomeId || (region?.biomeId) ||
                          o.name.split('__').pop()?.split('_r')[0];
          const biomeHex = biomeColor.get(biomeId) || '#888888';
          const hex = (region && !region.isWater && region.regionColor)
            ? region.regionColor
            : biomeHex;
          o.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(hex),
            roughness: 0.85,
            metalness: 0.0,
            side: THREE.DoubleSide,
            flatShading: false,
          });
          if (!o.geometry.attributes.normal) {
            o.geometry.computeVertexNormals();
          }
          o.userData.regionId = region?.id;
          o.userData.regionName = region?.name;
          o.userData.contId = region?.contId;
          o.userData.isWater = !!region?.isWater;
          o.userData.continentName = region ? appState.continents.find(
            (c) => c.id === region.contId)?.name : null;
        }
      });

      // CAD +Z = north pole; rotate so three.js +Y points to the north pole.
      root.rotation.x = -Math.PI / 2;
      scene.add(root);
      globeMesh = root;

      rebuildLabels();
      applyVisibility();

      // Frame the globe.
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
      if (r.noLabel || r.isWater) continue;
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
    const hit = _ray.intersectObject(globeMesh, true)[0];
    if (!hit || !hit.object.visible) { tooltipEl.hidden = true; return; }
    const region = appState.bodyToRegion.get(hit.object.name);
    if (!region) { tooltipEl.hidden = true; return; }
    tooltipEl.textContent = region.name;
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

  const [biomes, regions] = await Promise.all([
    fetch('biomes.json').then((r) => r.json()),
    fetch('regions.json').then((r) => r.ok ? r.json() : null),
  ]);
  biomesCfg = biomes;
  R_globe = biomes?.sphere?.radius_mm ?? 50;

  if (!regions) {
    continentTogglesEl.textContent = 'regions.json missing.';
    return;
  }
  regionsCfg = regions;
  appState = buildState(regions, biomes);
  renderToggles();

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
