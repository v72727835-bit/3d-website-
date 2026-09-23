/**
 * entry3d.js — real-time 3D entrance engine for the Royal Entry Room.
 *
 * Replaces the cropped H.264 reference clips with WebGL rigs rendered live,
 * so every entrance is crisp at any resolution instead of a filmed screen.
 *
 * Each ride is a procedural rig with articulated joints (galloping legs,
 * flapping wings, spinning spoked wheels, an undulating dragon spine), so the
 * motion is generated rather than replayed. If a matching GLB is dropped into
 * assets/models/<key>.glb it is used for the body instead and the same flight
 * path, lighting, trail and particle work is applied to it.
 */

import * as THREE from './vendor/three/three.module.js';
import { RoomEnvironment } from './vendor/three/environments/RoomEnvironment.js';
import { EffectComposer } from './vendor/three/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three/postprocessing/OutputPass.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
/** Ramps 0→1 over `a`, holds, then falls back to 0 after `b`. */
const window01 = (u, a, b) => smooth(clamp(u / a, 0, 1)) * (1 - smooth(clamp((u - b) / (1 - b), 0, 1)));
/** A soft bell centred on `c` — used for one-off flashes, not sustained states. */
const pulse = (u, c, w) => Math.exp(-Math.pow((u - c) / w, 2));

/* ------------------------------------------------------------------ *
 * Canvas-drawn textures. Generated once so the page ships no images.
 * ------------------------------------------------------------------ */

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Tiling texture helper. Surfaces need a repeating detail map, and these are
 * drawn rather than downloaded so the page still ships no image files.
 */
function tileTexture(size, repeat, draw, { srgb = false } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

/** Sobel-derives a normal map from a greyscale height canvas. */
function normalFromHeight(size, repeat, drawHeight, strength = 2.2) {
  const h = document.createElement('canvas');
  h.width = h.height = size;
  const hg = h.getContext('2d');
  drawHeight(hg, size);
  const src = hg.getImageData(0, 0, size, size).data;
  const out = hg.createImageData(size, size);
  const at = (x, y) => src[((y & (size - 1)) * size + (x & (size - 1))) * 4];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) / 255 * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) / 255 * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      out.data[i] = (-dx / len * 0.5 + 0.5) * 255;
      out.data[i + 1] = (-dy / len * 0.5 + 0.5) * 255;
      out.data[i + 2] = (1 / len * 0.5 + 0.5) * 255;
      out.data[i + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').putImageData(out, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  return tex;
}

/** Value noise on a canvas — the base for fur, grain and scuffing. */
function noiseField(g, size, cells, contrast = 1) {
  const grid = cells + 1;
  const v = Array.from({ length: grid * grid }, () => Math.random());
  const img = g.createImageData(size, size);
  const fade = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells, gy = (y / size) * cells;
      const x0 = Math.floor(gx), y0 = Math.floor(gy);
      const tx = fade(gx - x0), ty = fade(gy - y0);
      const a = v[y0 * grid + x0], b = v[y0 * grid + x0 + 1];
      const c = v[(y0 + 1) * grid + x0], d = v[(y0 + 1) * grid + x0 + 1];
      let n = lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
      n = clamp((n - 0.5) * contrast + 0.5, 0, 1);
      const i = (y * size + x) * 4, p = n * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = p;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

const TEX = {};
function buildTextures() {
  // Soft additive dot — particles, sparks, glow billboards.
  TEX.spark = canvasTexture(128, (g, s) => {
    const r = s / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.22, 'rgba(255,244,214,0.78)');
    grad.addColorStop(0.55, 'rgba(255,200,120,0.18)');
    grad.addColorStop(1, 'rgba(255,170,80,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
  // Elliptical floor pool the ride stands on.
  TEX.pool = canvasTexture(256, (g, s) => {
    const r = s / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.92)');
    grad.addColorStop(0.18, 'rgba(214,176,255,0.55)');
    grad.addColorStop(0.5, 'rgba(126,112,236,0.22)');
    grad.addColorStop(1, 'rgba(60,70,180,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
  });
  // Streaked light shaft used for speed lines and the god-ray fans.
  TEX.shaft = canvasTexture(128, (g, s) => {
    const grad = g.createLinearGradient(0, 0, s, 0);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.32, 'rgba(255,255,255,0.32)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.68, 'rgba(255,255,255,0.32)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, s, s);
    const fade = g.createLinearGradient(0, 0, 0, s);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(0.5, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade;
    g.fillRect(0, 0, s, s);
  });
  // ---- Surface detail. These are what stop the rigs reading as toy plastic:
  // a hair grain on the coats, brushing and scuffs on the metal, overlapping
  // scales on the dragon, and a weave on the cloth.
  const hair = (g, s) => {
    g.fillStyle = '#9a9a9a';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < s * 8; i++) {
      const x = Math.random() * s, y = Math.random() * s;
      const len = 9 + Math.random() * 22;
      const tone = 120 + Math.random() * 120;
      g.strokeStyle = `rgb(${tone},${tone},${tone})`;
      g.lineWidth = 0.5 + Math.random() * 0.9;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + len * 0.1, y + len * 0.5, x + len * 0.26, y + len);
      g.stroke();
    }
  };
  TEX.furRough = tileTexture(256, 3, hair);
  TEX.furNormal = normalFromHeight(256, 3, hair, 1.1);

  const brushed = (g, s) => {
    g.fillStyle = '#b4b4b4';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < s * 6; i++) {
      const y = Math.random() * s;
      const tone = 130 + Math.random() * 110;
      g.strokeStyle = `rgba(${tone},${tone},${tone},0.4)`;
      g.lineWidth = 0.4 + Math.random() * 0.8;
      g.beginPath();
      g.moveTo(Math.random() * s - s * 0.3, y);
      g.lineTo(Math.random() * s + s * 0.3, y + (Math.random() - 0.5) * 5);
      g.stroke();
    }
    for (let i = 0; i < 22; i++) {                       // scuffs and dings
      g.strokeStyle = `rgba(${80 + Math.random() * 70},${80 + Math.random() * 70},${105},0.35)`;
      g.lineWidth = 0.6 + Math.random() * 1.3;
      const x = Math.random() * s, y = Math.random() * s;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 22);
      g.stroke();
    }
  };
  TEX.metalRough = tileTexture(256, 2.5, brushed);
  TEX.metalNormal = normalFromHeight(256, 2.5, brushed, 0.45);

  const scales = (g, s) => {
    g.fillStyle = '#8c8c8c';
    g.fillRect(0, 0, s, s);
    const rows = 9, r = s / rows;
    for (let row = -1; row <= rows; row++) {
      for (let col = -1; col <= rows; col++) {
        const cx = col * r + (row % 2 ? r / 2 : 0);
        const cy = row * r * 0.72;
        const grad = g.createRadialGradient(cx, cy - r * 0.2, r * 0.1, cx, cy, r * 0.78);
        grad.addColorStop(0, '#e2e2e2');
        grad.addColorStop(0.72, '#a6a6a6');
        grad.addColorStop(1, '#6a6a6a');
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(cx, cy, r * 0.62, r * 0.55, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
  };
  TEX.scaleRough = tileTexture(256, 3.2, scales);
  TEX.scaleNormal = normalFromHeight(256, 3.2, scales, 1.5);

  const weave = (g, s) => {
    noiseField(g, s, 26, 0.7);
    g.globalAlpha = 0.35;
    for (let i = 0; i < s; i += 6) {
      g.fillStyle = i % 12 ? '#dadada' : '#909090';
      g.fillRect(i, 0, 3, s);
      g.fillRect(0, i, s, 3);
    }
    g.globalAlpha = 1;
  };
  TEX.clothRough = tileTexture(256, 2, weave);
  TEX.clothNormal = normalFromHeight(256, 2, weave, 1.6);

  const grain = (g, s) => noiseField(g, s, 28, 1.3);
  TEX.grainRough = tileTexture(256, 3, grain);
  TEX.grainNormal = normalFromHeight(256, 3, grain, 0.8);

  // Six-point star flare for the hero sparkle.
  TEX.star = canvasTexture(128, (g, s) => {
    const r = s / 2;
    g.translate(r, r);
    for (let i = 0; i < 3; i++) {
      g.rotate(Math.PI / 3);
      const grad = g.createLinearGradient(-r, 0, r, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(255,248,226,0.95)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(-r, -2.2, s, 4.4);
    }
    const core = g.createRadialGradient(0, 0, 0, 0, 0, r * 0.4);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, 'rgba(255,220,150,0)');
    g.fillStyle = core;
    g.fillRect(-r, -r, s, s);
  });
}

/* ------------------------------------------------------------------ *
 * Shared materials
 * ------------------------------------------------------------------ */

const MAT = {};
function buildMaterials() {
  const std = (o) => new THREE.MeshStandardMaterial(o);
  // Detail maps per family. A roughness map alone does most of the work:
  // it breaks the single uniform highlight that makes CG surfaces look like
  // moulded plastic. The matching normal map adds the grain under it.
  const fur = () => ({ roughnessMap: TEX.furRough, normalMap: TEX.furNormal, normalScale: new THREE.Vector2(0.45, 0.45) });
  const metal = () => ({ roughnessMap: TEX.metalRough, normalMap: TEX.metalNormal, normalScale: new THREE.Vector2(0.25, 0.25) });
  const scaled = () => ({ roughnessMap: TEX.scaleRough, normalMap: TEX.scaleNormal, normalScale: new THREE.Vector2(0.7, 0.7) });
  const cloth = () => ({ roughnessMap: TEX.clothRough, normalMap: TEX.clothNormal, normalScale: new THREE.Vector2(0.5, 0.5) });
  const grain = () => ({ roughnessMap: TEX.grainRough, normalMap: TEX.grainNormal, normalScale: new THREE.Vector2(0.45, 0.45) });
  MAT.gold = std({ color: 0xf0b444, metalness: 1, roughness: 0.3, emissive: 0x190d00, envMapIntensity: 1.5, ...metal() });
  MAT.goldDeep = std({ color: 0xd08c2a, metalness: 1, roughness: 0.44, emissive: 0x1d0e00, envMapIntensity: 1.7, ...metal() });
  MAT.silver = std({ color: 0xc8d2e8, metalness: 1, roughness: 0.32, envMapIntensity: 1.5, ...metal() });
  MAT.steel = std({ color: 0x7c88a4, metalness: 1, roughness: 0.48, envMapIntensity: 1.2, ...metal() });
  MAT.dark = std({ color: 0x1b2038, metalness: 0.7, roughness: 0.6, envMapIntensity: 1.1, ...grain() });
  MAT.coat = std({ color: 0xcfc6b6, metalness: 0.04, roughness: 0.74, envMapIntensity: 0.6, ...fur() });
  MAT.coatWarm = std({ color: 0x5d3418, metalness: 0.08, roughness: 0.72, envMapIntensity: 0.85, ...fur() });
  MAT.hoof = std({ color: 0x2a2233, metalness: 0.35, roughness: 0.62, ...grain() });
  MAT.mane = std({ color: 0x2c1d14, metalness: 0.15, roughness: 0.66, emissive: 0x160c04, envMapIntensity: 1.1, ...fur() });
  MAT.glass = std({ color: 0x1d7d76, metalness: 0.2, roughness: 0.08, emissive: 0x0d5750, emissiveIntensity: 1.5, transparent: true, opacity: 0.86 });
  MAT.crimson = std({ color: 0xb3223f, metalness: 0.3, roughness: 0.66, emissive: 0x2c0208, ...cloth() });
  MAT.violet = std({ color: 0x6f57cf, metalness: 0.68, roughness: 0.46, emissive: 0x160a30, envMapIntensity: 1.2, ...metal() });
  MAT.scale = std({ color: 0xf0a733, metalness: 1, roughness: 0.42, emissive: 0x261000, envMapIntensity: 1.5, ...scaled() });
  MAT.scaleDark = std({ color: 0xa8641a, metalness: 1, roughness: 0.55, emissive: 0x220e00, envMapIntensity: 1.7, ...scaled() });
  MAT.membrane = std({ color: 0xe8933a, metalness: 0.28, roughness: 0.68, emissive: 0x4a2202, emissiveIntensity: 0.9, transparent: true, opacity: 0.93, side: THREE.DoubleSide, ...grain() });
  MAT.feather = std({ color: 0xded5c6, metalness: 0.08, roughness: 0.82, emissive: 0x15120c, side: THREE.DoubleSide, envMapIntensity: 0.5, ...fur() });
  MAT.neon = std({ color: 0x3a2f9c, metalness: 0.88, roughness: 0.34, emissive: 0x1c1160, emissiveIntensity: 0.8, envMapIntensity: 1.5, ...metal() });
  MAT.tyre = std({ color: 0x15161f, metalness: 0.2, roughness: 0.95, ...grain() });
  MAT.amber = std({ color: 0xffe9a8, metalness: 0, roughness: 1, emissive: 0xffb02e, emissiveIntensity: 3.4 });
  MAT.rose = std({ color: 0xffd0e4, metalness: 0, roughness: 1, emissive: 0xff3c86, emissiveIntensity: 3 });
  MAT.cyan = std({ color: 0xd6f7ff, metalness: 0, roughness: 1, emissive: 0x27d9ff, emissiveIntensity: 3.2 });
}

const additive = (color, opacity, map) => new THREE.MeshBasicMaterial({
  color, map, transparent: true, opacity, blending: THREE.AdditiveBlending,
  depthWrite: false, side: THREE.DoubleSide, toneMapped: false
});

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}
function group(x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  return g;
}
/** Mirrors a builder across z so paired limbs/wings stay in sync. */
function pair(build) {
  const a = build(1), b = build(-1);
  return [a, b];
}

/* ------------------------------------------------------------------ *
 * Reusable anatomy
 * ------------------------------------------------------------------ */

/**
 * A three-segment leg (thigh → shank → hoof) whose joints are nested groups,
 * so a gallop is a matter of driving three rotations instead of baking frames.
 */
function buildLeg({ coat = MAT.coat, thigh = 0.5, shank = 0.5, thick = 0.15 } = {}) {
  const hip = group();
  hip.add(mesh(new THREE.CapsuleGeometry(thick, thigh, 4, 10), coat, 0, -thigh / 2 - thick * 0.2, 0));
  const knee = group(0, -(thigh / 2 + thick * 1.4), 0);
  hip.add(knee);
  knee.add(mesh(new THREE.CapsuleGeometry(thick * 0.66, shank, 4, 10), coat, 0, -shank / 2 - thick * 0.1, 0));
  const ankle = group(0, -(shank / 2 + thick * 0.9), 0);
  knee.add(ankle);
  ankle.add(mesh(new THREE.CylinderGeometry(thick * 0.62, thick * 0.78, thick * 1.5, 10), MAT.hoof, 0, -thick * 0.75, 0));
  return { hip, knee, ankle };
}

/** Drives one leg through a gallop cycle. `phase` staggers the four legs. */
function galloped(leg, t, phase, amount = 1) {
  const a = t + phase;
  leg.hip.rotation.z = Math.sin(a) * 0.95 * amount;
  leg.knee.rotation.z = -(0.18 + Math.max(0, Math.sin(a - 1.05)) * 1.25) * amount;
  leg.ankle.rotation.z = Math.sin(a - 1.7) * 0.4 * amount;
}

/** A tapered chain (tail, whisker of mane, dragon spine offshoot). */
function buildChain(segments, radius, length, mat, taper = 0.72) {
  const root = group();
  const joints = [];
  let parent = root, r = radius;
  for (let i = 0; i < segments; i++) {
    const j = group(i === 0 ? 0 : -length, 0, 0);
    parent.add(j);
    j.add(mesh(new THREE.CapsuleGeometry(r, length * 0.82, 3, 8), mat, -length / 2, 0, 0).rotateZ(Math.PI / 2));
    joints.push(j);
    parent = j;
    r *= taper;
  }
  return { root, joints };
}

/**
 * Feathered wing. Each feather is a flattened ellipsoid on its own pivot, and
 * the pivots fan through the x-y plane so the wing reads from a side-on camera:
 * short coverts pointing up at the leading edge, long primaries sweeping back.
 */
function buildFeatherWing(side, { span = 2.0, rows = 3, per = 8, mat = MAT.feather } = {}) {
  const root = group();
  const mid = group();
  root.add(mid);
  const shoulder = mesh(new THREE.CapsuleGeometry(0.075, span * 0.3, 4, 8), mat, 0.12, 0.2, side * 0.1);
  shoulder.rotation.z = 0.9;
  mid.add(shoulder);

  for (let r = 0; r < rows; r++) {
    const rowScale = 0.5 + r * 0.28;
    for (let i = 0; i < per; i++) {
      const k = i / (per - 1);
      const theta = lerp(1.22, -0.08, k);            // up at the leading edge, swept back at the tip
      const len = span * rowScale * lerp(0.55, 1, Math.sin(Math.PI * (0.18 + 0.72 * k)));
      const pivot = group(0.05 + r * 0.06, 0.1, side * (0.08 + r * 0.09));
      pivot.rotation.z = theta;
      pivot.rotation.y = side * (0.1 + k * 0.28);
      const feather = mesh(new THREE.CapsuleGeometry(0.125 - r * 0.018, len * 0.84, 4, 10), mat, len / 2, 0, 0);
      feather.rotation.z = Math.PI / 2;
      feather.scale.set(1, 1, 0.22);                 // flatten each feather into a blade
      pivot.add(feather);
      mid.add(pivot);
    }
  }
  return { root, mid };
}

/**
 * Bat-style dragon wing: an arm, three finger bones, and a membrane whose
 * outline is derived from where those bones actually end, so the skin always
 * matches the skeleton instead of being a hand-guessed strip.
 */
function buildDragonWing(side) {
  const root = group();
  const upper = group();
  root.add(upper);
  const arm = mesh(new THREE.CapsuleGeometry(0.1, 1.05, 4, 8), MAT.scaleDark, 0, 0, side * 0.6);
  arm.rotation.x = Math.PI / 2;
  upper.add(arm);
  const elbow = group(0, 0, side * 1.2);
  upper.add(elbow);

  const fingers = [];
  const spread = [0.62, 0.16, -0.38];
  const lengths = [2.7, 2.45, 1.9];
  spread.forEach((tilt, i) => {
    const f = group();
    f.rotation.x = -side * tilt * 0.85;
    f.rotation.y = side * tilt * 0.45;
    const len = lengths[i];
    const bone = mesh(new THREE.CapsuleGeometry(0.058 - i * 0.008, len * 0.94, 3, 7), MAT.scaleDark, 0, 0, side * len / 2);
    bone.rotation.x = Math.PI / 2;
    f.add(bone);
    f.updateMatrix();
    elbow.add(f);
    fingers.push({ node: f, len, tip: new THREE.Vector3(0, 0, side * len).applyMatrix4(f.matrix) });
  });

  // Membrane: a fan from the leading edge through the finger tips, with the
  // trailing edge scalloped inward between them.
  const anchor = new THREE.Vector3(0.22, 0.08, 0);
  const edge = [];
  fingers.forEach((f, i) => {
    edge.push(f.tip.clone());
    const next = fingers[i + 1];
    if (next) edge.push(f.tip.clone().add(next.tip).multiplyScalar(0.5).multiplyScalar(0.74).setY(-0.06));
  });
  edge.push(new THREE.Vector3(-1.05, -0.1, side * 0.35));
  const verts = [anchor, ...edge];
  const pos = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => { pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; });
  const idx = [];
  for (let i = 1; i < verts.length - 1; i++) {
    if (side > 0) idx.push(0, i, i + 1); else idx.push(0, i + 1, i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  elbow.add(new THREE.Mesh(geo, MAT.membrane));

  // A second, smaller membrane spans the arm so there is no gap at the shoulder.
  const inner = new THREE.BufferGeometry();
  const ip = new Float32Array([0.3, 0.12, 0, -0.85, -0.05, 0, 0.22, 0.08, side * 1.2, -1.05, -0.1, side * 1.55]);
  inner.setAttribute('position', new THREE.BufferAttribute(ip, 3));
  inner.setIndex(side > 0 ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3]);
  inner.computeVertexNormals();
  upper.add(new THREE.Mesh(inner, MAT.membrane));

  return { root, upper, elbow, fingers };
}

/** Spoked carriage / bike wheel that actually rolls. */
function buildWheel({ radius = 0.5, tyre = 0.07, spokes = 12, rim = MAT.gold, band = MAT.goldDeep, hub = MAT.gold } = {}) {
  const w = group();
  const tyreMesh = mesh(new THREE.TorusGeometry(radius, tyre, 10, 40), band);
  w.add(tyreMesh);
  w.add(mesh(new THREE.TorusGeometry(radius * 0.78, tyre * 0.45, 8, 32), rim));
  w.add(mesh(new THREE.CylinderGeometry(radius * 0.15, radius * 0.15, tyre * 2.4, 12), hub).rotateX(Math.PI / 2));
  for (let i = 0; i < spokes; i++) {
    const s = mesh(new THREE.CylinderGeometry(0.018, 0.018, radius * 1.56, 6), rim);
    s.rotation.z = (i / spokes) * Math.PI;
    w.add(s);
  }
  return w;
}

/** Armoured rider shared by the horse and the superbike. */
function buildRider({ armour = MAT.steel, cloth = MAT.crimson, lean = 0 } = {}) {
  const r = group();
  const torso = group();
  r.add(torso);
  torso.rotation.z = lean;
  torso.add(mesh(new THREE.CapsuleGeometry(0.2, 0.42, 4, 12), armour, 0, 0.24, 0));
  const chest = mesh(new THREE.SphereGeometry(0.235, 16, 12), armour, -0.01, 0.34, 0);
  chest.scale.set(1.12, 0.95, 1.02);
  torso.add(chest);
  const pauldrons = pair((side) => {
    const p = mesh(new THREE.SphereGeometry(0.13, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), MAT.gold, 0, 0.46, side * 0.21);
    p.rotation.z = -side * 0.1;
    torso.add(p);
    return p;
  });
  void pauldrons;
  // Cape
  const cape = group(0.16, 0.34, 0);
  const capeMesh = mesh(new THREE.PlaneGeometry(0.72, 0.9, 6, 6), new THREE.MeshStandardMaterial({ color: 0xa2183c, roughness: 0.55, metalness: 0.15, side: THREE.DoubleSide, emissive: 0x220209 }), 0.3, -0.4, 0);
  capeMesh.rotation.y = Math.PI / 2;
  cape.add(capeMesh);
  torso.add(cape);
  // Head + plumed helm
  const neck = group(0, 0.52, 0);
  torso.add(neck);
  neck.add(mesh(new THREE.SphereGeometry(0.135, 14, 12), MAT.coatWarm, 0, 0.1, 0));
  const helm = mesh(new THREE.SphereGeometry(0.16, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), armour, 0, 0.13, 0);
  neck.add(helm);
  neck.add(mesh(new THREE.ConeGeometry(0.05, 0.3, 8), cloth, 0.02, 0.34, 0));
  // Arms — the outer one is raised, matching the salute in the reference.
  const arms = pair((side) => {
    const shoulder = group(0, 0.42, side * 0.21);
    const upper = mesh(new THREE.CapsuleGeometry(0.068, 0.3, 3, 8), armour, 0, -0.17, 0);
    shoulder.add(upper);
    const elbow = group(0, -0.34, 0);
    shoulder.add(elbow);
    elbow.add(mesh(new THREE.CapsuleGeometry(0.058, 0.28, 3, 8), armour, 0, -0.16, 0));
    torso.add(shoulder);
    return { shoulder, elbow, side };
  });
  // Raised banner in the near hand.
  const banner = group(0, -0.28, 0);
  banner.add(mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.95, 8), MAT.gold, 0, 0.38, 0));
  banner.add(mesh(new THREE.ConeGeometry(0.035, 0.14, 7), MAT.gold, 0, 0.92, 0));
  const flagGeo = new THREE.PlaneGeometry(0.34, 0.22, 8, 3);
  const flag = mesh(flagGeo, new THREE.MeshStandardMaterial({ color: 0xc8203f, emissive: 0x38040d, roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide }), -0.18, 0.7, 0);
  banner.add(flag);
  arms[0].elbow.add(banner);
  // Legs
  const legs = pair((side) => {
    const hip = group(0, 0.02, side * 0.14);
    hip.add(mesh(new THREE.CapsuleGeometry(0.085, 0.3, 3, 8), MAT.dark, 0, -0.18, 0));
    const knee = group(0, -0.36, 0);
    hip.add(knee);
    knee.add(mesh(new THREE.CapsuleGeometry(0.07, 0.28, 3, 8), MAT.dark, 0, -0.16, 0));
    knee.add(mesh(new THREE.BoxGeometry(0.22, 0.09, 0.12), MAT.dark, -0.05, -0.33, 0));
    torso.add(hip);
    return { hip, knee };
  });
  return { root: r, torso, neck, arms, legs, cape, flag, flagGeo };
}

/* ------------------------------------------------------------------ *
 * Rigs. Each returns { root, update(t, u, ctx) } and faces -x,
 * which is the direction every entrance travels across the stage.
 * ------------------------------------------------------------------ */

function buildHorse({ coat = MAT.coat, winged = false, rider = true, scale = 1 } = {}) {
  const root = group();
  const body = group();
  root.add(body);

  const barrel = mesh(new THREE.CapsuleGeometry(0.33, 1.15, 6, 18), coat);
  barrel.rotation.z = Math.PI / 2;
  barrel.scale.set(1, 1.08, 0.78);
  body.add(barrel);
  const chest = mesh(new THREE.SphereGeometry(0.34, 16, 14), coat, -0.58, 0.04, 0);
  chest.scale.set(0.95, 1.12, 0.8);
  body.add(chest);
  const rump = mesh(new THREE.SphereGeometry(0.38, 16, 14), coat, 0.62, 0.08, 0);
  rump.scale.set(1, 1.05, 0.82);
  body.add(rump);

  // Neck and head
  const neck = group(-0.78, 0.26, 0);
  body.add(neck);
  neck.rotation.z = 0.62;
  const neckMesh = mesh(new THREE.CylinderGeometry(0.15, 0.27, 0.8, 14), coat, 0, 0.37, 0);
  neckMesh.scale.z = 0.82;
  neck.add(neckMesh);
  const head = group(0, 0.76, 0);
  neck.add(head);
  head.rotation.z = -0.34;
  const skull = mesh(new THREE.CapsuleGeometry(0.115, 0.38, 4, 12), coat, -0.26, 0.0, 0);
  skull.rotation.z = Math.PI / 2;
  skull.scale.set(1, 1.02, 0.86);
  head.add(skull);
  const cheek = mesh(new THREE.SphereGeometry(0.135, 12, 10), coat, 0.02, 0.04, 0);
  cheek.scale.set(1, 1.1, 0.84);
  head.add(cheek);
  const muzzle = mesh(new THREE.SphereGeometry(0.09, 12, 10), MAT.hoof, -0.5, -0.03, 0);
  muzzle.scale.set(1.1, 0.85, 0.85);
  head.add(muzzle);
  pair((side) => {
    const ear = mesh(new THREE.ConeGeometry(0.036, 0.16, 7), coat, 0.11, 0.16, side * 0.07);
    ear.rotation.z = -0.25;
    head.add(ear);
    const eye = mesh(new THREE.SphereGeometry(0.032, 10, 8), MAT.amber, -0.13, 0.07, side * 0.1);
    head.add(eye);
    return eye;
  });
  // Bridle strap, a small detail that keeps the head from reading as a blob.
  const bridle = mesh(new THREE.TorusGeometry(0.105, 0.014, 6, 16), MAT.gold, -0.3, -0.01, 0);
  bridle.rotation.y = Math.PI / 2;
  head.add(bridle);
  // Mane along the crest of the neck
  const maneStrands = [];
  for (let i = 0; i < 11; i++) {
    const k = i / 10;
    const s = mesh(new THREE.CapsuleGeometry(0.026, 0.26 + 0.2 * Math.sin(Math.PI * k), 3, 6), MAT.mane);
    s.position.set(-0.1 - k * 0.03, 0.1 + k * 0.7, 0);
    s.rotation.z = 0.95;
    s.scale.z = 0.42;
    neck.add(s);
    maneStrands.push(s);
  }
  // Tail
  const tail = buildChain(7, 0.085, 0.19, MAT.mane, 0.88);
  tail.root.position.set(0.98, 0.3, 0);
  tail.root.rotation.z = -0.35;
  body.add(tail.root);

  const legs = [
    { leg: buildLeg({ coat, thigh: 0.46, shank: 0.5, thick: 0.12 }), at: [-0.54, -0.2, 0.22], phase: 0 },
    { leg: buildLeg({ coat, thigh: 0.46, shank: 0.5, thick: 0.12 }), at: [-0.54, -0.2, -0.22], phase: Math.PI * 0.92 },
    { leg: buildLeg({ coat, thigh: 0.52, shank: 0.52, thick: 0.14 }), at: [0.66, -0.16, 0.24], phase: Math.PI * 1.15 },
    { leg: buildLeg({ coat, thigh: 0.52, shank: 0.52, thick: 0.14 }), at: [0.66, -0.16, -0.24], phase: Math.PI * 0.2 }
  ];
  legs.forEach(({ leg, at }) => { leg.hip.position.set(...at); body.add(leg.hip); });

  let wings = null;
  if (winged) {
    wings = pair((side) => {
      const w = buildFeatherWing(side, { span: 2.3, rows: 3, per: 10 });
      w.root.position.set(0.0, 0.34, side * 0.26);
      body.add(w.root);
      return { ...w, side };
    });
  }

  let man = null;
  if (rider) {
    man = buildRider({ lean: -0.1 });
    man.root.position.set(0.02, 0.5, 0);
    body.add(man.root);
    man.arms[0].shoulder.rotation.z = 2.3;
    man.arms[0].shoulder.rotation.x = -0.35;
    man.arms[0].elbow.rotation.z = -0.5;
    man.arms[1].shoulder.rotation.z = -0.9;
    man.arms[1].elbow.rotation.z = -0.7;
    man.legs.forEach((l) => { l.hip.rotation.z = -0.95; l.knee.rotation.z = 0.85; });
  }

  root.scale.setScalar(scale);

  return {
    root, body, head, neck, wings, rider: man,
    update(t, u, ctx = {}) {
      const speed = ctx.speed ?? 9.5;
      const gait = t * speed;
      legs.forEach(({ leg, phase }) => galloped(leg, gait, phase, ctx.gait ?? 1));
      // Suspension bounce and the pitch of a horse at full stretch.
      body.position.y = Math.sin(gait * 2) * 0.1 + Math.abs(Math.sin(gait)) * 0.05;
      body.rotation.z = Math.sin(gait * 2 + 0.6) * 0.055;
      neck.rotation.z = 0.72 + Math.sin(gait * 2 + 1.1) * 0.09;
      head.rotation.z = -0.34 + Math.sin(gait * 2 + 1.6) * 0.09;
      maneStrands.forEach((s, i) => {
        s.rotation.z = 0.95 + Math.sin(gait * 1.6 - i * 0.4) * 0.2;
        s.rotation.y = Math.sin(gait * 1.3 - i * 0.3) * 0.12;
      });
      tail.joints.forEach((j, i) => {
        j.rotation.z = (i === 0 ? -0.15 : 0) + Math.sin(gait * 1.2 - i * 0.55) * 0.17;
        j.rotation.y = Math.sin(gait * 0.9 - i * 0.42) * 0.2;
      });
      if (wings) {
        const flap = Math.sin(t * 4.4);
        wings.forEach((w) => {
          w.root.rotation.x = w.side * (0.3 + flap * 0.5);
          w.root.rotation.z = flap * 0.16;
          w.mid.rotation.x = -w.side * (0.08 + flap * 0.24);
          w.mid.rotation.y = w.side * flap * 0.12;
        });
      }
      if (man) {
        man.torso.rotation.z = -0.1 + Math.sin(gait * 2 + 0.3) * 0.07;
        man.torso.position.y = Math.sin(gait * 2) * 0.04;
        man.neck.rotation.z = Math.sin(gait * 2 + 1) * 0.05;
        man.arms[0].shoulder.rotation.z = 2.3 + Math.sin(gait * 1.4) * 0.14;
        man.cape.rotation.z = -0.5 - Math.sin(gait * 1.3) * 0.25;
        man.cape.rotation.y = Math.sin(gait * 1.1) * 0.2;
        const pos = man.flagGeo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i);
          pos.setZ(i, Math.sin(x * 10 + t * 11) * 0.05 * (0.5 - x / 0.34));
        }
        pos.needsUpdate = true;
      }
      void u;
    }
  };
}

/** Rounded-rectangle helper used for coach panels and bike fairings. */
function roundedShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function buildCarriage() {
  const root = group();

  // --- Coach -------------------------------------------------------
  const coach = group(1.55, 0.05, 0);
  root.add(coach);

  const profile = new THREE.Shape();
  profile.moveTo(-0.88, -0.52);
  profile.lineTo(0.88, -0.52);
  profile.lineTo(0.98, 0.1);
  profile.lineTo(0.92, 0.82);
  profile.quadraticCurveTo(0.84, 1.1, 0.46, 1.18);
  profile.lineTo(-0.46, 1.18);
  profile.quadraticCurveTo(-0.84, 1.1, -0.92, 0.82);
  profile.lineTo(-0.98, 0.1);
  profile.closePath();
  const cabin = mesh(new THREE.ExtrudeGeometry(profile, {
    depth: 1.02, bevelEnabled: true, bevelSize: 0.08, bevelThickness: 0.08, bevelSegments: 3, curveSegments: 16
  }), MAT.gold, 0, 0.5, -0.51);
  coach.add(cabin);

  // Arched windows on both flanks, each with its own gold surround.
  const arch = new THREE.Shape();
  arch.moveTo(-0.24, -0.3);
  arch.lineTo(0.24, -0.3);
  arch.lineTo(0.24, 0.12);
  arch.quadraticCurveTo(0.24, 0.42, 0, 0.42);
  arch.quadraticCurveTo(-0.24, 0.42, -0.24, 0.12);
  arch.closePath();
  const paneGeo = new THREE.ExtrudeGeometry(arch, { depth: 0.05, bevelEnabled: false, curveSegments: 14 });
  [[-0.33, 1], [0.33, 1], [-0.33, -1], [0.33, -1]].forEach(([px, side]) => {
    coach.add(mesh(paneGeo, MAT.glass, px, 0.72, side * 0.56));
    const surroundShape = new THREE.Shape();
    surroundShape.moveTo(-0.3, -0.36);
    surroundShape.lineTo(0.3, -0.36);
    surroundShape.lineTo(0.3, 0.12);
    surroundShape.quadraticCurveTo(0.3, 0.48, 0, 0.48);
    surroundShape.quadraticCurveTo(-0.3, 0.48, -0.3, 0.12);
    surroundShape.closePath();
    surroundShape.holes.push(new THREE.Path(arch.getPoints(24)));
    const surround = mesh(new THREE.ExtrudeGeometry(surroundShape, { depth: 0.04, bevelEnabled: false, curveSegments: 14 }),
      MAT.goldDeep, px, 0.72, side * 0.585);
    coach.add(surround);
  });
  // Door seam and handle on the near flank.
  coach.add(mesh(new THREE.BoxGeometry(0.02, 0.9, 0.02), MAT.goldDeep, 0.02, 0.36, 0.56));
  coach.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), MAT.amber, -0.08, 0.34, 0.58));

  // Driver's bench at the front of the coach.
  coach.add(mesh(new THREE.BoxGeometry(0.42, 0.1, 0.8), MAT.goldDeep, -1.02, 0.78, 0));
  coach.add(mesh(new THREE.BoxGeometry(0.1, 0.34, 0.8), MAT.gold, -1.2, 0.94, 0));

  // Gold trim: a waist rail and a roof rail around the cabin.
  [0.12, 1.02].forEach((y, i) => {
    const rail = mesh(new THREE.TorusGeometry(0.86 - i * 0.28, 0.035, 8, 40), MAT.goldDeep, 0, y, 0);
    rail.rotation.x = Math.PI / 2;
    rail.scale.set(1, 0.62, 1);
    coach.add(rail);
  });

  // Crown finial and corner spires.
  const crown = group(0, 1.14, 0);
  coach.add(crown);
  crown.add(mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.1, 12), MAT.gold));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const spike = mesh(new THREE.ConeGeometry(0.045, 0.22, 7), MAT.gold, Math.cos(a) * 0.15, 0.13, Math.sin(a) * 0.15);
    spike.rotation.z = -Math.cos(a) * 0.35;
    spike.rotation.x = Math.sin(a) * 0.35;
    crown.add(spike);
  }
  crown.add(mesh(new THREE.SphereGeometry(0.07, 12, 10), MAT.amber, 0, 0.28, 0));

  // Lanterns
  const lanterns = pair((side) => {
    const l = group(-0.84, 0.86, side * 0.42);
    l.add(mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.18, 8), MAT.gold));
    const bulb = mesh(new THREE.SphereGeometry(0.06, 10, 8), MAT.amber, 0, -0.02, 0);
    l.add(bulb);
    const halo = mesh(new THREE.PlaneGeometry(0.5, 0.5), additive(0xffbf5a, 0.5, TEX.spark));
    l.add(halo);
    coach.add(l);
    return { l, halo };
  });

  // Undercarriage, springs and wheels.
  coach.add(mesh(new THREE.BoxGeometry(1.7, 0.1, 0.62), MAT.goldDeep, 0, -0.48, 0));
  const wheels = [];
  [[-0.66, 0.42], [0.72, 0.62]].forEach(([wx, r]) => {
    pair((side) => {
      const w = buildWheel({ radius: r, spokes: r > 0.5 ? 14 : 10 });
      w.position.set(wx, -0.55 + r - 0.42, side * 0.62);
      coach.add(w);
      wheels.push(w);
      return w;
    });
    coach.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.3, 8), MAT.goldDeep, wx, -0.55 + r - 0.42, 0).rotateX(Math.PI / 2));
  });

  // --- Draught pegasus --------------------------------------------
  const horse = buildHorse({ coat: MAT.coat, winged: true, rider: false, scale: 1 });
  horse.root.position.set(-0.85, 0.46, 0);
  root.add(horse.root);

  // Shafts and traces from the coach to the harness.
  pair((side) => {
    const shaft = mesh(new THREE.CylinderGeometry(0.035, 0.05, 2.1, 8), MAT.goldDeep, 0.55, -0.22, side * 0.3);
    shaft.rotation.z = Math.PI / 2 - 0.06;
    root.add(shaft);
    return shaft;
  });
  const harness = mesh(new THREE.TorusGeometry(0.42, 0.04, 8, 24), MAT.crimson, -1.35, 0.18, 0);
  harness.rotation.y = Math.PI / 2;
  harness.scale.set(1, 0.85, 1);
  root.add(harness);

  root.position.x = -0.6;

  return {
    root, horse,
    update(t, u, ctx = {}) {
      horse.update(t, u, { speed: 7.4, gait: 0.72 });
      const roll = Math.sin(t * 7.4 * 2) * 0.02;
      coach.position.y = 0.05 + roll;
      coach.rotation.z = roll * 0.7;
      const spin = -(ctx.travel ?? t * 2.2) * 2.4;
      wheels.forEach((w) => { w.rotation.z = spin; });
      lanterns.forEach(({ halo }, i) => {
        const s = 1 + Math.sin(t * 5 + i * 2) * 0.18;
        halo.scale.setScalar(s);
      });
    }
  };
}

function buildBike() {
  const root = group();
  const chassis = group();
  root.add(chassis);

  // Wheels sit at y = 0; all bodywork is measured off that line.
  const wheels = [];
  const rimGlows = [];
  [[-1.2, 0.47], [1.0, 0.5]].forEach(([wx, r]) => {
    const w = group(wx, 0, 0);
    w.add(mesh(new THREE.TorusGeometry(r, 0.1, 12, 44), MAT.tyre));
    w.add(mesh(new THREE.TorusGeometry(r * 0.66, 0.05, 10, 36), MAT.silver));
    for (let i = 0; i < 5; i++) {
      const spoke = mesh(new THREE.BoxGeometry(r * 1.26, 0.07, 0.11), MAT.silver);
      spoke.rotation.z = (i / 5) * Math.PI;
      w.add(spoke);
    }
    w.add(mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.24, 12), MAT.steel).rotateX(Math.PI / 2));
    const disc = mesh(new THREE.CylinderGeometry(r * 0.44, r * 0.44, 0.03, 20), MAT.steel, 0, 0, 0.14);
    disc.rotation.x = Math.PI / 2;
    w.add(disc);
    const glow = mesh(new THREE.PlaneGeometry(r * 2.8, r * 2.8), additive(0x6f5bff, 0.32, TEX.spark));
    w.add(glow);
    chassis.add(w);
    wheels.push(w);
    rimGlows.push(glow);
  });

  // Bodywork is two pieces — front fairing and tail unit — with the engine
  // bay left open between them. One long extrusion reads as a slab, not a bike.
  const front = new THREE.Shape();
  front.moveTo(-1.44, 0.54);
  front.quadraticCurveTo(-1.35, 0.9, -1.0, 0.95);
  front.lineTo(-0.66, 0.86);
  front.lineTo(-0.22, 0.72);
  front.lineTo(-0.16, 0.5);
  front.quadraticCurveTo(-0.55, 0.38, -0.9, 0.3);
  front.quadraticCurveTo(-1.26, 0.28, -1.44, 0.54);
  const fairing = mesh(new THREE.ExtrudeGeometry(front, {
    depth: 0.34, bevelEnabled: true, bevelSize: 0.07, bevelThickness: 0.07, bevelSegments: 3, curveSegments: 16
  }), MAT.neon, 0, 0, -0.17);
  chassis.add(fairing);

  const rear = new THREE.Shape();
  rear.moveTo(0.26, 0.74);
  rear.lineTo(0.7, 0.82);
  rear.quadraticCurveTo(1.02, 0.88, 1.2, 0.84);
  rear.lineTo(1.1, 0.6);
  rear.quadraticCurveTo(0.7, 0.55, 0.26, 0.56);
  rear.closePath();
  const tailUnit = mesh(new THREE.ExtrudeGeometry(rear, {
    depth: 0.28, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 3, curveSegments: 14
  }), MAT.neon, 0, 0, -0.14);
  chassis.add(tailUnit);

  // Fuel tank bridges the two and gives the bike its waist.
  const tank = mesh(new THREE.SphereGeometry(0.3, 18, 14), MAT.violet, -0.24, 0.74, 0);
  tank.scale.set(1.45, 0.55, 0.85);
  chassis.add(tank);
  const seat = mesh(new THREE.BoxGeometry(0.58, 0.1, 0.3), MAT.dark, 0.3, 0.8, 0);
  seat.rotation.z = 0.06;
  chassis.add(seat);
  // Neon edge strips along the shoulder line of each body panel.
  pair((side) => {
    const a = mesh(new THREE.BoxGeometry(1.1, 0.035, 0.025), MAT.cyan, -0.86, 0.8, side * 0.18);
    a.rotation.z = 0.12;
    chassis.add(a);
    const b = mesh(new THREE.BoxGeometry(0.8, 0.03, 0.025), MAT.rose, 0.72, 0.78, side * 0.15);
    b.rotation.z = 0.06;
    chassis.add(b);
    return a;
  });
  chassis.add(mesh(new THREE.BoxGeometry(0.05, 0.07, 0.22), MAT.rose, 1.22, 0.76, 0));

  // Engine block and radiator between the wheels.
  const engine = mesh(new THREE.BoxGeometry(0.8, 0.44, 0.38), MAT.steel, 0.0, 0.36, 0);
  chassis.add(engine);
  for (let i = 0; i < 5; i++) {
    chassis.add(mesh(new THREE.BoxGeometry(0.03, 0.3, 0.42), MAT.silver, -0.36 + i * 0.05, 0.42, 0));
  }

  // Nose cowl, screen, headlight and beam.
  const nose = mesh(new THREE.SphereGeometry(0.27, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), MAT.neon, -1.36, 0.62, 0);
  nose.rotation.z = Math.PI / 2 + 0.5;
  nose.scale.set(1, 1.15, 0.8);
  chassis.add(nose);
  const lamp = mesh(new THREE.SphereGeometry(0.14, 14, 12), MAT.cyan, -1.44, 0.56, 0);
  lamp.scale.set(0.5, 0.85, 0.7);
  chassis.add(lamp);
  const beam = mesh(new THREE.ConeGeometry(0.42, 3.0, 18, 1, true), additive(0x8fd8ff, 0.16, TEX.spark), -2.95, 0.52, 0);
  beam.rotation.z = Math.PI / 2;
  chassis.add(beam);
  const screen = mesh(new THREE.SphereGeometry(0.22, 14, 10, 0, Math.PI, 0, Math.PI * 0.5), MAT.glass, -0.92, 0.94, 0);
  screen.rotation.set(0, Math.PI * 0.5, -0.65);
  chassis.add(screen);

  // Upside-down forks, clip-ons and mirrors.
  pair((side) => {
    const fork = mesh(new THREE.CylinderGeometry(0.052, 0.062, 1.05, 8), MAT.steel, -1.29, 0.5, side * 0.17);
    fork.rotation.z = 0.3;
    chassis.add(fork);
    const bar = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.22, 6), MAT.dark, -0.88, 0.82, side * 0.22);
    bar.rotation.x = Math.PI / 2;
    chassis.add(bar);
    const mirror = mesh(new THREE.BoxGeometry(0.15, 0.055, 0.03), MAT.violet, -1.0, 0.96, side * 0.28);
    mirror.rotation.z = 0.2;
    chassis.add(mirror);
    return fork;
  });

  // Swingarm, shock, exhaust and afterburn.
  const swing = mesh(new THREE.BoxGeometry(1.0, 0.11, 0.12), MAT.steel, 0.5, 0.18, 0.2);
  swing.rotation.z = -0.13;
  chassis.add(swing);
  chassis.add(mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 8), MAT.rose, 0.34, 0.45, 0.12).rotateZ(0.35));
  const pipe = mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.66, 12), MAT.steel, 0.95, 0.44, 0.19);
  pipe.rotation.z = Math.PI / 2 - 0.12;
  chassis.add(pipe);
  const afterburn = mesh(new THREE.ConeGeometry(0.15, 1.4, 14, 1, true), additive(0x9c7bff, 0.45, TEX.spark), 1.85, 0.46, 0.19);
  afterburn.rotation.z = -Math.PI / 2;
  chassis.add(afterburn);

  const underGlow = mesh(new THREE.PlaneGeometry(2.8, 0.9), additive(0x7d5bff, 0.38, TEX.spark), -0.1, -0.42, 0);
  underGlow.rotation.x = -Math.PI / 2;
  chassis.add(underGlow);

  // Rider tucked over the tank.
  const man = buildRider({ armour: MAT.violet, cloth: MAT.rose, lean: 0.66 });
  man.root.position.set(0.16, 0.76, 0);
  man.root.scale.setScalar(0.88);
  chassis.add(man.root);
  man.arms.forEach((a) => { a.shoulder.rotation.z = -1.75; a.elbow.rotation.z = -0.3; });
  man.legs.forEach((l) => { l.hip.rotation.z = -1.55; l.knee.rotation.z = 1.55; });
  man.cape.visible = false;
  man.arms[0].elbow.children.forEach((c) => { if (c.isGroup) c.visible = false; });

  return {
    root, chassis,
    update(t, u, ctx = {}) {
      const spin = -(ctx.travel ?? t * 3) * 3.6;
      wheels.forEach((w, i) => { w.rotation.z = spin * (i === 0 ? 1 : 1.02); });
      rimGlows.forEach((g, i) => { g.material.opacity = 0.2 + 0.12 * Math.sin(t * 20 + i); });
      // Weight transfer: the bike squats on power and lifts the nose.
      const wheelie = window01(u, 0.32, 0.6);
      chassis.rotation.z = wheelie * 0.1 + Math.sin(t * 9) * 0.012;
      chassis.position.y = Math.sin(t * 13) * 0.02;
      root.rotation.x = Math.sin(t * 2.2) * 0.05;
      afterburn.scale.set(1 + Math.sin(t * 24) * 0.2, 1 + Math.sin(t * 17) * 0.35, 1 + Math.sin(t * 24) * 0.2);
      beam.material.opacity = 0.11 + 0.06 * Math.sin(t * 11);
      man.torso.rotation.z = 0.66 - wheelie * 0.12;
    }
  };
}

function buildDragon() {
  const root = group();
  const SEG = 32, STEP = 0.19;

  // Spine: free-floating segments repositioned along a travelling sine each
  // frame, which gives a serpentine body a bone chain cannot fake as cheaply.
  const spine = [];
  for (let i = 0; i < SEG; i++) {
    const k = i / (SEG - 1);
    // Radius swells behind the neck and tapers to the tail; the step is small
    // enough that consecutive spheres overlap into one continuous body.
    const r = 0.085 + 0.27 * Math.sin(Math.PI * clamp(0.24 + k * 0.76, 0, 1)) * (1 - k * 0.32);
    const s = mesh(new THREE.SphereGeometry(r, 16, 12), i % 3 === 2 ? MAT.scaleDark : MAT.scale);
    s.scale.set(1.35, 1, 0.9);
    root.add(s);
    spine.push({ node: s, k, r });
    // Dorsal fin
    if (i > 2 && i < SEG - 3 && i % 2 === 0) {
      const fin = mesh(new THREE.ConeGeometry(r * 0.62, r * 1.9, 4), MAT.membrane, 0, r * 0.9, 0);
      fin.rotation.y = Math.PI / 4;
      fin.scale.z = 0.3;
      s.add(fin);
    }
  }

  // Head
  const head = group();
  root.add(head);
  const skull = mesh(new THREE.SphereGeometry(0.34, 16, 14), MAT.scale);
  skull.scale.set(1.4, 0.92, 0.95);
  head.add(skull);
  const snout = mesh(new THREE.CapsuleGeometry(0.165, 0.42, 5, 12), MAT.scale, -0.48, -0.04, 0);
  snout.rotation.z = Math.PI / 2;
  snout.scale.set(1, 1.1, 0.95);
  head.add(snout);
  const jaw = group(-0.2, -0.12, 0);
  head.add(jaw);
  const jawMesh = mesh(new THREE.CapsuleGeometry(0.1, 0.34, 4, 10), MAT.scaleDark, -0.2, -0.04, 0);
  jawMesh.rotation.z = Math.PI / 2;
  jaw.add(jawMesh);
  for (let i = 0; i < 5; i++) {
    pair((side) => {
      const tooth = mesh(new THREE.ConeGeometry(0.026, 0.09, 5), MAT.coat, -0.16 - i * 0.09, 0.07, side * 0.085);
      head.add(tooth);
      const lower = mesh(new THREE.ConeGeometry(0.023, 0.075, 5), MAT.coat, -0.14 - i * 0.085, 0.04, side * 0.075);
      lower.rotation.z = Math.PI;
      jaw.add(lower);
      return tooth;
    });
  }
  const eyes = pair((side) => {
    const e = mesh(new THREE.SphereGeometry(0.062, 12, 10), MAT.amber, -0.18, 0.11, side * 0.18);
    head.add(e);
    return e;
  });
  // Horns and cheek frills
  pair((side) => {
    const horn = mesh(new THREE.ConeGeometry(0.06, 0.62, 8), MAT.coatWarm, 0.16, 0.24, side * 0.13);
    horn.rotation.z = 0.75;
    horn.rotation.x = -side * 0.3;
    head.add(horn);
    const frill = mesh(new THREE.ConeGeometry(0.09, 0.32, 4), MAT.membrane, 0.08, 0.02, side * 0.26);
    frill.rotation.z = 1.1;
    frill.rotation.x = -side * 0.7;
    frill.scale.z = 0.35;
    head.add(frill);
    return horn;
  });
  // Whiskers
  const whiskers = pair((side) => {
    const w = buildChain(5, 0.022, 0.24, MAT.coatWarm, 0.9);
    w.root.position.set(-0.5, 0.02, side * 0.12);
    w.root.rotation.y = -side * 0.5;
    head.add(w.root);
    return w;
  });
  // Fire breath, revealed during the hover.
  const breath = mesh(new THREE.ConeGeometry(0.34, 2.2, 16, 1, true), additive(0xffa53a, 0, TEX.spark), -1.6, -0.06, 0);
  breath.rotation.z = Math.PI / 2;
  head.add(breath);

  const wings = pair((side) => {
    const w = buildDragonWing(side);
    root.add(w.root);
    return { ...w, side };
  });

  // Clawed limbs tucked under the body.
  const limbs = [];
  [[-0.35, 0.34], [1.35, 0.4]].forEach(([lx, sc]) => {
    pair((side) => {
      const l = buildLeg({ coat: MAT.scaleDark, thigh: 0.34, shank: 0.32, thick: 0.1 });
      l.hip.position.set(lx, -0.18, side * 0.26);
      l.hip.scale.setScalar(sc / 0.34);
      root.add(l.hip);
      limbs.push({ l, side });
      return l;
    });
  });

  const halo = mesh(new THREE.PlaneGeometry(6.5, 3.6), additive(0xffa02e, 0.22, TEX.spark), -0.6, 0, -0.9);
  root.add(halo);

  const AXIS_X = new THREE.Vector3(1, 0, 0);
  const dir = new THREE.Vector3();
  return {
    root, head, breath, eyes,
    update(t, u, ctx = {}) {
      const amp = 0.34, sway = 0.5;
      const pts = [];
      for (let i = 0; i < SEG; i++) {
        const k = i / (SEG - 1);
        const x = 0.35 + i * STEP;
        const y = Math.sin(t * 3.1 - i * 0.44) * amp * (0.25 + k) - k * 0.12;
        const z = Math.sin(t * 2.2 - i * 0.36) * sway * (0.2 + k);
        pts.push(new THREE.Vector3(x, y, z));
      }
      for (let i = 0; i < SEG; i++) {
        const s = spine[i];
        s.node.position.copy(pts[i]);
        const ahead = pts[Math.max(0, i - 1)];
        // Aim each vertebra's long axis down the spine. setFromUnitVectors is
        // used instead of lookAt because lookAt resolves in world space and the
        // whole dragon is being flown around by its parent.
        dir.subVectors(ahead, pts[i]);
        if (dir.lengthSq() > 1e-8) s.node.quaternion.setFromUnitVectors(AXIS_X, dir.normalize());
      }
      // Head rides just ahead of the first vertebra and aims down the spine.
      head.position.set(-0.22, pts[0].y + 0.08, pts[0].z * 0.9);
      dir.subVectors(pts[1], head.position);
      if (dir.lengthSq() > 1e-8) head.quaternion.setFromUnitVectors(AXIS_X, dir.normalize());
      head.rotateZ(Math.sin(t * 2.6) * 0.07);
      jaw.rotation.z = -0.12 - Math.max(0, Math.sin(t * 2.1)) * 0.3;

      const flap = Math.sin(t * 3.35);
      wings.forEach((w) => {
        w.root.position.set(pts[4].x - 0.05, pts[4].y + 0.2, pts[4].z);
        w.root.rotation.z = -0.12 + flap * 0.1;
        w.upper.rotation.x = w.side * (0.15 + flap * 0.78);
        w.upper.rotation.y = -w.side * (0.1 + flap * 0.12);
        w.elbow.rotation.x = -w.side * (0.2 + Math.sin(t * 3.35 - 0.7) * 0.5);
        w.fingers.forEach((f, i) => { f.node.rotation.z = Math.sin(t * 3.35 - 0.9 - i * 0.25) * 0.22; });
      });

      limbs.forEach(({ l, side }, i) => {
        l.hip.rotation.z = -0.9 + Math.sin(t * 2.4 + i * 1.4) * 0.22;
        l.knee.rotation.z = 1.25 + Math.sin(t * 2.4 + i * 1.4 - 0.6) * 0.2;
        l.ankle.rotation.z = -0.4;
        l.hip.rotation.x = side * 0.25;
      });

      whiskers.forEach((w, wi) => {
        w.joints.forEach((j, i) => {
          j.rotation.z = Math.sin(t * 3.4 - i * 0.6 + wi) * 0.26 + 0.12;
          j.rotation.y = Math.sin(t * 2.6 - i * 0.5 + wi * 2) * 0.3;
        });
      });

      // Breath fires during the centre hold only.
      const fire = window01(u, 0.46, 0.62);
      breath.material.opacity = fire * (0.45 + Math.sin(t * 26) * 0.18);
      breath.scale.set(1 + fire * 0.3, 0.6 + fire * 0.7, 1 + fire * 0.3);
      eyes.forEach((e) => { e.material.emissiveIntensity = 3 + Math.sin(t * 8) * 1.2; });
      halo.position.set(pts[6].x - 1.2, pts[6].y, -0.7);
      halo.material.opacity = 0.14 + 0.06 * Math.sin(t * 4);
      void ctx;
    }
  };
}

/* ------------------------------------------------------------------ *
 * Trail ribbon — a strip that follows the ride and fades out behind it.
 * ------------------------------------------------------------------ */

class Trail {
  constructor(color, width, samples = 48) {
    this.n = samples;
    this.width = width;
    this.pts = Array.from({ length: samples }, () => new THREE.Vector3());
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(samples * 2 * 3);
    this.col = new Float32Array(samples * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < samples - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.base = new THREE.Color(color);
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false
    }));
    this.mesh.frustumCulled = false;
    this.ready = false;
  }
  /**
   * Lay the ribbon along the path the ride has just flown.
   * Sampling the path rather than recording past frames keeps the trail the
   * same length whether the device renders at 120fps or 20.
   */
  follow(path, u, span, baseY, offset, strength = 1) {
    for (let i = 0; i < this.n; i++) {
      const q = path(clamp(u - (i / (this.n - 1)) * span, 0, 1));
      this.pts[i].set(q.x + offset.x, baseY + q.y + offset.y, q.z + offset.z);
    }
    this.write(strength);
  }
  write(strength) {
    const { pts, pos, col, n, width, base } = this;
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      const fade = Math.pow(1 - k, 1.8) * strength;
      const w = width * Math.pow(1 - k, 0.85) * (0.35 + 0.65 * strength);
      const p = pts[i];
      const a = i * 6;
      pos[a] = p.x; pos[a + 1] = p.y + w; pos[a + 2] = p.z;
      pos[a + 3] = p.x; pos[a + 4] = p.y - w; pos[a + 5] = p.z;
      for (let j = 0; j < 2; j++) {
        const c = a + j * 3;
        col[c] = base.r * fade; col[c + 1] = base.g * fade; col[c + 2] = base.b * fade;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ *
 * Particles — ambient motes plus a burst on arrival.
 * ------------------------------------------------------------------ */

class Sparkles {
  constructor(count, color, size) {
    const geo = new THREE.BufferGeometry();
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.seed = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.seed[i * 4] = Math.random();
      this.seed[i * 4 + 1] = Math.random();
      this.seed[i * 4 + 2] = Math.random();
      this.seed[i * 4 + 3] = 0.4 + Math.random() * 0.9;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      size, map: TEX.spark, color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true, toneMapped: false
    }));
    this.points.frustumCulled = false;
  }
  drift(t, box) {
    const { pos, seed, count } = this;
    for (let i = 0; i < count; i++) {
      const s = i * 4;
      pos[i * 3] = ((seed[s] * box.x + t * seed[s + 3] * 0.55 + box.x) % box.x) - box.x / 2;
      pos[i * 3 + 1] = Math.sin(t * seed[s + 3] * 0.7 + seed[s + 1] * 9) * box.y * 0.5 + (seed[s + 1] - 0.5) * box.y * 0.4;
      pos[i * 3 + 2] = (seed[s + 2] - 0.5) * box.z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
  burstFrom(t, origin, spread, life) {
    const { pos, seed, count } = this;
    for (let i = 0; i < count; i++) {
      const s = i * 4;
      const a = seed[s] * Math.PI * 2, r = seed[s + 1] * spread * life;
      pos[i * 3] = origin.x + Math.cos(a) * r + seed[s + 2] * 0.4;
      pos[i * 3 + 1] = origin.y + Math.sin(a) * r * 0.6 + Math.sin(t * 2 + i) * 0.1;
      pos[i * 3 + 2] = origin.z + (seed[s + 2] - 0.5) * spread * 0.7;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

/* ------------------------------------------------------------------ *
 * Flight paths
 * ------------------------------------------------------------------ */

/** Sweep in from `from`, ease to a near-standstill at `at`, then leave to `to`. */
function crossing(u, from, to, at, holdA, holdB, drift = 0.45) {
  if (u <= holdA) return lerp(from, at + drift, easeOut(u / holdA));
  if (u >= holdB) return lerp(at - drift, to, easeIn((u - holdB) / (1 - holdB)));
  const k = (u - holdA) / (holdB - holdA);
  return lerp(at + drift, at - drift, smooth(k));
}

const ENTRIES = {
  horse: {
    label: 'Horse rider',
    accent: 0xffa845,
    trail: { color: 0xff8a1e, width: 0.12, span: 0.09 },
    scale: 0.95, y: -0.32,
    build: () => buildHorse({ coat: MAT.coatWarm, rider: true }),
    // assets/models/horse.glb faces +z, so a quarter turn puts it on the path.
    model: {
      rotationY: -Math.PI / 2, length: 3.3, groundY: -1.45,
      // Measured off the mesh: belly line, hip positions and the clean gap
      // between fore and hind legs, all in the model's own +z-forward space.
      gallop: {
        belly: -0.64, legLength: 0.36, split: 0.10,
        frontHipZ: 0.38, hindHipZ: -0.18, tailZ: -0.50,
        speed: 9.0, swing: 0.95
      },
      banner: { x: 0.62, y: 0.0, z: 0.14, tilt: 0.48, scale: 0.62 }
    },
    pool: 0xffa23c,
    path(u) {
      const x = crossing(u, 7.2, -7.6, 0.15, 0.3, 0.66, 0.5);
      return {
        x, y: 0, z: lerp(-1.1, 0.9, u),
        ry: -0.34 + Math.sin(u * Math.PI) * 0.12,
        rz: 0,
        travel: (7.2 - x)
      };
    }
  },
  carriage: {
    label: 'Royal rath',
    accent: 0xe0a6ff,
    trail: { color: 0xc98bff, width: 0.14, span: 0.08 },
    scale: 0.8, y: -0.42,
    build: () => buildCarriage(),
    pool: 0xd79bff,
    path(u) {
      const x = crossing(u, 8.6, -9.2, 0.1, 0.32, 0.7, 0.4);
      return {
        x, y: Math.sin(u * Math.PI) * 0.12, z: lerp(-1.4, 0.7, u),
        ry: -0.3 + Math.sin(u * Math.PI) * 0.1,
        rz: 0,
        travel: (8.6 - x)
      };
    }
  },
  bike: {
    label: 'Superbike',
    accent: 0x8c73ff,
    trail: { color: 0x7a5bff, width: 0.1, span: 0.11 },
    scale: 1.0, y: -1.18,
    build: () => buildBike(),
    pool: 0x7f6bff,
    path(u) {
      const x = crossing(u, 8.4, -9.4, 0.05, 0.28, 0.62, 0.7);
      return {
        x, y: 0, z: lerp(-1.3, 1.0, u),
        ry: -0.28 + Math.sin(u * Math.PI) * 0.14,
        rz: 0,
        travel: (8.4 - x) * 1.35
      };
    }
  },
  dragon: {
    label: 'Golden dragon',
    accent: 0xffc04a,
    trail: { color: 0xffa424, width: 0.16, span: 0.1 },
    scale: 0.58, y: 0.2,
    build: () => buildDragon(),
    pool: 0xffb03a,
    path(u) {
      const x = crossing(u, 8.0, -8.6, -0.25, 0.34, 0.7, 0.55);
      const dive = Math.sin(clamp(u / 0.34, 0, 1) * Math.PI * 0.5);
      return {
        x,
        y: lerp(2.4, 0.15, dive) + Math.sin(u * Math.PI * 2.1) * 0.22 + easeIn(clamp((u - 0.7) / 0.3, 0, 1)) * 1.9,
        z: lerp(-2.6, 1.2, u),
        ry: -0.36 + Math.sin(u * Math.PI) * 0.16,
        rz: lerp(0.3, -0.05, dive) - easeIn(clamp((u - 0.7) / 0.3, 0, 1)) * 0.34,
        travel: (8.0 - x)
      };
    }
  }
};

/* ------------------------------------------------------------------ *
 * Engine
 * ------------------------------------------------------------------ */

export function createEntryEngine(canvas, opts = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    return null; // Caller falls back to the CSS/video entrance.
  }
  if (!renderer.capabilities.isWebGL2 && !renderer.getContext()) return null;

  buildTextures();
  buildMaterials();

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lowPower = (navigator.hardwareConcurrency || 4) <= 4 || /Android [4-8]\./.test(navigator.userAgent);
  const dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.5 : 2);

  renderer.setPixelRatio(dpr);
  renderer.setClearAlpha(0);
  // Self-shadowing is the other half of the anti-plastic work: legs shadowing
  // the barrel, a wing shadowing the neck. Dropped on low-core devices.
  const shadows = !lowPower;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.78;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1.5, 0.1, 140);
  camera.position.set(0, 0.25, 11.2);

  // Image-based lighting is what makes the gold read as metal rather than
  // flat yellow, so every metallic material gets a generated room env map.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;

  const key = new THREE.DirectionalLight(0xfff0d0, 1.55);
  key.position.set(-4, 5, 6);
  scene.add(key);
  scene.add(key.target);
  if (shadows) {
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 3;
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.022;
    const sc = key.shadow.camera;
    sc.left = -3.6; sc.right = 3.6; sc.top = 3.2; sc.bottom = -3.2;
    sc.near = 0.5; sc.far = 26;
    sc.updateProjectionMatrix();
  }
  const rim = new THREE.DirectionalLight(0x8fb4ff, 1.25);
  rim.position.set(6, 2.5, -5);
  scene.add(rim);
  const under = new THREE.PointLight(0xff8ad0, 5, 14, 2);
  under.position.set(0, -1.6, 1.2);
  scene.add(under);
  const hero = new THREE.PointLight(0xffc978, 0, 12, 2);
  scene.add(hero);
  const sky = new THREE.HemisphereLight(0x8fb6ff, 0x120a24, 0.45);
  scene.add(sky);

  // --- Stage dressing ----------------------------------------------
  const stage = new THREE.Group();
  scene.add(stage);

  const pool = mesh(new THREE.PlaneGeometry(7.2, 3.4), additive(0xc79bff, 0.5, TEX.pool), 0, -1.86, 1.0);
  pool.rotation.x = -1.16;
  pool.renderOrder = 1;
  stage.add(pool);

  const podium = mesh(new THREE.PlaneGeometry(6, 1.1), additive(0xffffff, 0.22, TEX.shaft), 0, -1.72, 1.4);
  podium.rotation.x = -1.2;
  stage.add(podium);

  const rays = [];
  for (let i = 0; i < 3; i++) {
    const r = mesh(new THREE.PlaneGeometry(3.4 + i * 1.2, 11), additive(0x9ec6ff, 0.12, TEX.shaft), -3.4 + i * 3.4, 1.6, -7.5);
    r.rotation.z = 0.2 - i * 0.18;
    stage.add(r);
    rays.push(r);
  }

  const speedLines = new THREE.Group();
  stage.add(speedLines);
  const lineMat = additive(0xffffff, 0.5, TEX.shaft);
  for (let i = 0; i < 16; i++) {
    const l = mesh(new THREE.PlaneGeometry(3.2 + Math.random() * 3, 0.035 + Math.random() * 0.05), lineMat);
    l.userData.s = Math.random();
    speedLines.add(l);
  }
  speedLines.visible = false;

  const ambient = new Sparkles(lowPower ? 60 : 130, 0xffe2ad, 0.1);
  stage.add(ambient.points);
  const burst = new Sparkles(lowPower ? 50 : 110, 0xffd89a, 0.16);
  stage.add(burst.points);

  const flare = mesh(new THREE.PlaneGeometry(3.2, 3.2), additive(0xfff3d2, 0, TEX.star), 0, 0, -3);
  stage.add(flare);

  // A soft dark ellipse on the floor. Without it the rides look pasted on top
  // of the room rather than standing in it.
  const contact = mesh(new THREE.PlaneGeometry(4.6, 2.2), new THREE.MeshBasicMaterial({
    map: TEX.pool, color: 0x05030f, transparent: true, opacity: 0, depthWrite: false, toneMapped: false
  }), 0, -1.84, 0.9);
  contact.rotation.x = -1.16;
  contact.renderOrder = 4;
  stage.add(contact);

  // --- Post ---------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), lowPower ? 0.28 : 0.42, 0.5, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // --- Rides (built on first use, then cached) ----------------------
  const rigs = new Map();
  const holder = new THREE.Group();
  scene.add(holder);

  function rigFor(name) {
    if (rigs.has(name)) return rigs.get(name);
    const cfg = ENTRIES[name];
    const rig = cfg.build();
    rig.root.visible = false;
    rig.root.scale.setScalar(cfg.scale);
    if (shadows) {
      rig.root.traverse((o) => {
        // Glows, beams and trails are additive helpers, not solid geometry.
        if (!o.isMesh || o.material.blending === THREE.AdditiveBlending) return;
        o.castShadow = true;
        o.receiveShadow = true;
      });
    }
    const pivot = new THREE.Group();
    pivot.add(rig.root);
    holder.add(pivot);
    const trail = new Trail(cfg.trail.color, cfg.trail.width);
    stage.add(trail.mesh);
    trail.mesh.visible = false;
    const entry = { cfg, rig, pivot, trail };
    rigs.set(name, entry);
    return entry;
  }

  /**
   * Make a rigless quadruped gallop.
   *
   * Downloaded models almost never ship a skeleton, and a rigid mesh slid
   * across the stage reads as a statue. Rather than fake a skeleton, the leg
   * vertices are swung in the vertex shader: each is assigned to a leg by where
   * it sits in the model's own space, weighted from zero at the hip to one at
   * the hoof, and rotated about the hip, with a second rotation about the knee
   * for the lower half. The weighting makes the limb bend rather than snap off,
   * and the same rotation is applied to the normal so the shading follows. It
   * costs one uniform per frame and no CPU work.
   *
   * `g` describes the animal in ITS OWN axes, before the model is turned onto
   * the path: forward is +z, up is +y.
   */
  function applyGallopShader(model, g) {
    const time = { value: 0 };
    const glsl = [
      'uniform float uT;',
      `const float BELLY  = ${g.belly.toFixed(3)};`,
      `const float LEGLEN = ${g.legLength.toFixed(3)};`,
      `const float SPLIT  = ${g.split.toFixed(3)};`,
      `const float FRONTZ = ${g.frontHipZ.toFixed(3)};`,
      `const float HINDZ  = ${g.hindHipZ.toFixed(3)};`,
      `const float TAILZ  = ${g.tailZ.toFixed(3)};`,
      `const float SPEED  = ${g.speed.toFixed(3)};`,
      `const float SWING  = ${g.swing.toFixed(3)};`,
      '',
      'vec3 rotX(vec3 v, float a) {',
      '  float s = sin(a), c = cos(a);',
      '  return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);',
      '}',
      '',
      '// Rotate about a pivot lying on the z/y plane.',
      'vec3 swingAbout(vec3 p, float pz, float py, float a) {',
      '  vec3 piv = vec3(0.0, py, pz);',
      '  return piv + rotX(p - piv, a);',
      '}',
      '',
      '// Hip and knee angle for one leg at a given depth down the limb.',
      'vec2 legAngles(float phase, float w) {',
      '  float a = uT * SPEED + phase;',
      '  return vec2(',
      '    sin(a) * SWING * w,',
      '    -(0.10 + max(0.0, sin(a - 1.05)) * 0.70) * clamp((w - 0.45) / 0.55, 0.0, 1.0)',
      '  );',
      '}',
      '',
      '// Blend between the four legs instead of branching between them. A hard',
      '// left/right test tears every triangle that crosses the midline, because',
      '// the two sides are half a stride apart; blending keeps the chest, belly',
      '// and rump continuous, and the weight is faded out along the centre line',
      '// so the body itself barely moves.',
      'void gallopFor(vec3 rest, out vec2 ang, out float hipZ) {',
      '  float w = clamp((BELLY - rest.y) / LEGLEN, 0.0, 1.0);',
      '  w = w * w * (3.0 - 2.0 * w);',
      '  w *= smoothstep(0.015, 0.085, abs(rest.x));',
      '  float side = smoothstep(-0.055, 0.055, rest.x);',
      '  float fore = smoothstep(SPLIT - 0.09, SPLIT + 0.09, rest.z);',
      '  vec2 front = mix(legAngles(3.05, w), legAngles(0.00, w), side);',
      '  vec2 hind  = mix(legAngles(0.75, w), legAngles(4.30, w), side);',
      '  ang  = mix(hind, front, fore);',
      '  hipZ = mix(HINDZ, FRONTZ, fore);',
      '}',
      '',
      '// Total rotation a vertex receives, used to carry the normal along.',
      'float gallopAngle(vec3 rest) {',
      '  if (rest.y >= BELLY || rest.z < TAILZ) return 0.0;',
      '  vec2 ang; float hipZ;',
      '  gallopFor(rest, ang, hipZ);',
      '  return ang.x + ang.y;',
      '}',
      '',
      'vec3 gallop(vec3 pos, vec3 rest) {',
      '  // Tail: a slow sweep hinged where it leaves the rump.',
      '  if (rest.z < TAILZ) {',
      '    float wt = clamp((TAILZ - rest.z) / 0.45, 0.0, 1.0);',
      '    return swingAbout(pos, TAILZ, BELLY + 0.18, sin(uT * SPEED * 0.42) * 0.22 * wt);',
      '  }',
      '  if (rest.y >= BELLY) return pos;',
      '  vec2 ang; float hipZ;',
      '  gallopFor(rest, ang, hipZ);',
      '  // Knee bends in the rest pose, then the hip carries the whole limb.',
      '  vec3 q = swingAbout(pos, hipZ, BELLY - LEGLEN * 0.5, ang.y);',
      '  return swingAbout(q, hipZ, BELLY, ang.x);',
      '}'
    ].join('\n');

    const inject = (shader, withNormal) => {
      shader.uniforms.uT = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + glsl)
        .replace('#include <begin_vertex>',
          '#include <begin_vertex>\n transformed = gallop(transformed, position);');
      if (withNormal) {
        shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',
          '#include <beginnormal_vertex>\n objectNormal = rotX(objectNormal, gallopAngle(position));');
      }
    };

    model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m || m.userData.gallop) return;
        m.userData.gallop = true;
        m.onBeforeCompile = (shader) => inject(shader, true);
        m.needsUpdate = true;
      });
      // The shadow pass renders with its own depth material, which would
      // otherwise cast the rest pose while the visible mesh gallops.
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      depth.onBeforeCompile = (shader) => inject(shader, false);
      o.customDepthMaterial = depth;
    });
    return time;
  }

  /** A pennant on a pole, for imported riders that carry nothing but a sword. */
  function buildBanner(spec) {
    const root = group(spec.x, spec.y, spec.z);
    root.rotation.z = spec.tilt ?? 0.35;
    root.scale.setScalar(spec.scale ?? 1);
    root.add(mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.7, 8), MAT.gold, 0, 0.45, 0));
    root.add(mesh(new THREE.ConeGeometry(0.06, 0.24, 8), MAT.gold, 0, 1.42, 0));
    const cloth = new THREE.PlaneGeometry(0.62, 0.42, 12, 5);
    const flag = mesh(cloth, new THREE.MeshStandardMaterial({
      color: 0xb4173a, emissive: 0x33040e, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide
    }), -0.33, 1.02, 0);
    root.add(flag);
    return {
      root,
      update(t) {
        const p = cloth.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i);
          const k = 0.5 - x / 0.62;                 // 0 at the pole, 1 at the fly
          p.setZ(i, Math.sin(x * 9 - t * 12) * 0.11 * k);
          p.setY(i, p.getY(i) * 1 + 0);
        }
        p.needsUpdate = true;
        cloth.computeVertexNormals();
        root.rotation.z = (spec.tilt ?? 0.35) + Math.sin(t * 3) * 0.035;
      }
    };
  }

  /**
   * Swap the procedural body for a downloaded GLB.
   *
   * Opt in by listing keys on the page before main.js runs, e.g.
   *   window.ENTRY3D_MODELS = ['horse'];
   * and dropping assets/models/horse.glb next to it. The flight path,
   * lighting, trail, sparks, shadows and camera work all still apply.
   *
   * Downloaded models arrive facing any direction and at any scale, so each
   * entry's `model` block says how to aim and size it; the mesh is then fitted
   * to the same length and ground line the procedural rig occupies. Most
   * downloaded models carry no animation, so one is driven procedurally.
   */
  async function tryLoadModel(name) {
    if (!(window.ENTRY3D_MODELS || []).includes(name)) return false;
    try {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
        import('./vendor/three/loaders/GLTFLoader.js'),
        import('./vendor/three/libs/meshopt_decoder.module.js')
      ]);
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(`assets/models/${name}.glb`);

      const e = rigFor(name);
      const spec = { rotationY: 0, length: 3.3, groundY: -1.45, ...(e.cfg.model || {}) };
      const model = gltf.scene;
      model.rotation.y = spec.rotationY;
      model.updateMatrixWorld(true);

      // Fit on the oriented bounds, not the raw ones — a model that faces +z
      // has its length on a different axis before it is turned.
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3(); box.getSize(size);
      const fit = spec.length / Math.max(size.x, 0.0001);
      model.scale.setScalar(fit);
      model.position.set(-(box.min.x + size.x / 2) * fit, -box.min.y * fit + spec.groundY, -(box.min.z + size.z / 2) * fit);

      model.traverse((o) => {
        if (!o.isMesh) return;
        if (shadows) { o.castShadow = true; o.receiveShadow = true; }
        // Downloaded models are usually lit flat, with a base-colour texture
        // and nothing else. The stage's key light is warm and dim by design,
        // so lean on the neutral environment to carry them, and drop the
        // double-sided flag most exporters set on a closed mesh.
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (!m) return;
          if ('envMapIntensity' in m) m.envMapIntensity = 2.4;
          if (m.side === THREE.DoubleSide) m.side = THREE.FrontSide;
        });
      });

      const carrier = new THREE.Group();     // the node procedural motion drives
      carrier.add(model);
      e.rig.root.clear();
      e.rig.root.add(carrier);
      e.glb = { carrier, spec };

      if (gltf.animations?.length) {
        const mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(gltf.animations[0]).play();
        e.mixer = mixer;
      } else if (spec.gallop) {
        // No skeleton in the file, so the legs are driven in the shader.
        e.glb.time = applyGallopShader(model, spec.gallop);
      }
      if (spec.banner) {
        const banner = buildBanner(spec.banner);
        carrier.add(banner.root);
        e.glb.banner = banner;
      }
      return true;
    } catch {
      return false;                          // the procedural rig stays in place
    }
  }

  /** Canter-like motion for a GLB with no clips of its own. */
  function animateStaticModel(glb, t, u) {
    const { carrier } = glb;
    // The legs are swung in the shader; this is the body riding over them.
    if (glb.time) glb.time.value = t;
    glb.banner?.update(t);
    const beat = t * (glb.spec.gallop?.speed ?? glb.spec.cadence ?? 8.4);
    carrier.position.y = Math.sin(beat * 2) * 0.09 + Math.abs(Math.sin(beat)) * 0.05;
    carrier.rotation.z = Math.sin(beat * 2 + 0.6) * 0.05;
    carrier.rotation.x = Math.sin(beat * 0.5) * 0.03;
    void u;
  }

  // --- Playback -----------------------------------------------------
  let active = null, raf = 0, startedAt = 0, lastAt = 0, running = false, onDone = null;
  const TRAIL_OFFSET = new THREE.Vector3(0.85, 0.05, -0.3);
  const size = { w: 1, h: 1 };

  function resize() {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 440;
    const h = canvas.clientHeight || 290;
    if (w === size.w && h === size.h) return;
    size.w = w; size.h = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.setSize(w, h);
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const t = (now - startedAt) / 1000;
    const dt = Math.min((now - lastAt) / 1000, 0.05);
    lastAt = now;
    const e = active;
    if (!e) return;
    const u = clamp(t / e.duration, 0, 1);

    const p = e.cfg.path(u);
    e.pivot.position.set(p.x, e.cfg.y + p.y, p.z);
    e.pivot.rotation.set(0, p.ry, p.rz);
    if (e.glb) {
      // Photographic textures need more neutral fill than the stylised rigs,
      // which are tuned for the warm, dim key light.
      sky.intensity = 1.15;
      if (e.mixer) e.mixer.update(dt);
      else animateStaticModel(e.glb, t, u);
    } else {
      sky.intensity = 0.45;
      e.rig.update(t, u, { travel: p.travel });
    }

    // Fade the ride in and out at the edges instead of popping.
    const vis = window01(u, 0.07, 0.94);
    e.rig.root.visible = vis > 0.02;

    // Trail is laid along the path already flown, anchored just behind the body.
    e.trail.follow(e.cfg.path, u, e.cfg.trail.span ?? 0.07, e.cfg.y, TRAIL_OFFSET, vis);
    e.trail.mesh.visible = vis > 0.02;

    // Lighting and stage react to where the ride is.
    if (shadows) {
      key.position.set(p.x - 3.4, 5, p.z + 5);
      key.target.position.set(p.x, e.cfg.y + p.y, p.z);
      key.target.updateMatrixWorld();
    }
    // Contact shadow fades and spreads with height off the floor.
    const lift = clamp((e.cfg.y + p.y + 1.7) / 2.6, 0, 1);
    contact.position.x = p.x;
    contact.material.opacity = vis * 0.7 * (1 - lift * 0.72);
    contact.scale.setScalar(1 + lift * 0.7);
    hero.position.set(p.x, e.cfg.y + p.y + 0.6, p.z + 2.2);
    hero.intensity = vis * 4;
    hero.color.setHex(e.cfg.accent);
    pool.position.x = p.x * 0.55;
    pool.material.color.setHex(e.cfg.pool);
    pool.material.opacity = 0.12 + vis * 0.26;
    podium.material.opacity = vis * 0.16;
    under.intensity = 2.5 + vis * 4;

    // Arrival flare and spark burst peak as the ride reaches centre.
    const peak = pulse(u, 0.4, 0.13);
    flare.position.set(p.x + 0.9, e.cfg.y + p.y - 0.5, -3);
    flare.material.opacity = peak * 0.08;
    flare.rotation.z = t * 0.5;
    flare.scale.setScalar(0.55 + peak * 0.6);

    ambient.drift(t, { x: 13, y: 4.4, z: 5 });
    ambient.points.material.opacity = 0.18 + vis * 0.32;
    burst.burstFrom(t, new THREE.Vector3(p.x, e.cfg.y + p.y, p.z), 2.6, 0.4 + peak * 1.4);
    burst.points.material.color.setHex(e.cfg.accent);
    burst.points.material.opacity = peak * 0.75;

    rays.forEach((r, i) => { r.material.opacity = (0.018 + 0.012 * Math.sin(t * 1.4 + i)) * (0.35 + vis * 0.65); });

    // Speed lines only for the bike, and only while it is moving fast.
    const fast = e.key === 'bike' ? (1 - window01(u, 0.3, 0.62)) * vis : 0;
    speedLines.visible = fast > 0.05;
    if (speedLines.visible) {
      lineMat.opacity = fast * 0.42;
      speedLines.children.forEach((l, i) => {
        const s = l.userData.s;
        l.position.set(((s * 18 + t * (9 + s * 12)) % 18) - 9, (s - 0.5) * 3.2 + Math.sin(i) * 0.3, -1 + s * 2.4);
      });
    }

    // Camera drifts with the action, then settles for the hero beat.
    const look = smooth(clamp(u * 2.4, 0, 1)) * (1 - smooth(clamp((u - 0.74) / 0.26, 0, 1)));
    camera.position.x = p.x * 0.07;
    camera.position.y = 0.25 + p.y * 0.1 + Math.sin(t * 0.7) * 0.05;
    camera.position.z = lerp(11.6, 10.3, look);
    camera.lookAt(p.x * 0.18, e.cfg.y * 0.5 + p.y * 0.35, 0);

    resize();
    composer.render();

    if (t >= e.duration) {
      running = false;
      cancelAnimationFrame(raf);
      e.rig.root.visible = false;
      e.trail.mesh.visible = false;
      renderer.clear();
      const cb = onDone; onDone = null; active = null;
      cb?.();
    }
  }

  return {
    supported: true,
    entries: ENTRIES,
    /** Preload a ride's geometry so the first click has no hitch. */
    prepare(name) {
      if (!ENTRIES[name]) return;
      rigFor(name);
      if (!opts.noModels) tryLoadModel(name);
    },
    play(name, duration, done) {
      if (!ENTRIES[name]) return false;
      this.stop();
      const e = rigFor(name);
      e.key = name;
      e.duration = reduced ? Math.min(duration, 2.2) : duration;
      rigs.forEach((r) => { r.rig.root.visible = false; r.trail.mesh.visible = false; });
      active = e;
      onDone = done;
      startedAt = lastAt = performance.now();
      running = true;
      resize();
      raf = requestAnimationFrame(frame);
      return true;
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      onDone = null;
      if (active) { active.rig.root.visible = false; active.trail.mesh.visible = false; }
      active = null;
      renderer.clear();
    },
    resize,
    dispose() {
      this.stop();
      pmrem.dispose();
      composer.dispose?.();
      renderer.dispose();
    }
  };
}
