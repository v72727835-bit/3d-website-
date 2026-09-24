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
import { mergeGeometries } from './vendor/three/utils/BufferGeometryUtils.js';

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

  // Soft, irregular cloud for dust: noise masked by a lumpy radial falloff.
  TEX.smoke = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    noiseField(g, 128, 7, 1.4);
    g.globalCompositeOperation = 'destination-in';
    const blob = (x, y, r, a) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(0,0,0,${a})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
    };
    const m = document.createElement('canvas');
    m.width = m.height = 128;
    const mg = m.getContext('2d');
    [[64, 64, 60, 0.9], [48, 58, 36, 0.6], [80, 70, 34, 0.6], [62, 44, 30, 0.5]].forEach(([x, y, r, a]) => {
      const gr = mg.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(0,0,0,${a})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      mg.fillStyle = gr;
      mg.fillRect(0, 0, 128, 128);
    });
    void blob;
    g.drawImage(m, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();

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

/**
 * A golden-hour studio for reflections.
 *
 * Metal is almost nothing but reflection, so what it reflects decides whether
 * armour reads as steel or as grey plaster. The generic room environment is a
 * box of flat grey panels; this one is a sky dome with a deep blue zenith, a
 * warm low-sun band on the horizon and a dark ground, plus three HDR softboxes
 * (warm key, cool rim, dim fill) that put crisp highlights on edges. It is only
 * used for the photoreal entrances; the stylised ones keep the room.
 */
function buildStudioEnvScene() {
  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float y = d.y;
        vec3 zenith  = vec3(0.018, 0.030, 0.080);
        vec3 sky     = vec3(0.090, 0.110, 0.200);
        vec3 horizon = vec3(1.150, 0.540, 0.200);
        vec3 ground  = vec3(0.040, 0.028, 0.022);
        vec3 c = y > 0.0
          ? mix(horizon, mix(sky, zenith, smoothstep(0.25, 0.9, y)), smoothstep(0.0, 0.3, y))
          : mix(horizon * 0.3, ground, smoothstep(0.0, 0.2, -y));
        vec3 sun = normalize(vec3(-0.55, 0.2, 0.8));
        float s = max(dot(d, sun), 0.0);
        c += vec3(2.4, 1.45, 0.75) * pow(s, 28.0) + vec3(0.45, 0.26, 0.12) * pow(s, 4.0);
        gl_FragColor = vec4(c, 1.0);
      }`
  }));
  scene.add(dome);
  const softbox = (w, h, rgb, at) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(...rgb), side: THREE.DoubleSide }));
    m.position.set(...at);
    m.lookAt(0, 0, 0);
    scene.add(m);
  };
  softbox(10, 5.5, [5.2, 4.6, 3.9], [-10, 9, 12]);    // warm key, upper front left
  softbox(2.2, 13, [2.0, 2.7, 4.0], [14, 4, -9]);     // cool strip rim, behind right
  softbox(8, 3, [0.8, 0.76, 0.72], [11, 1.5, 12]);    // dim fill, front right
  softbox(16, 1.4, [1.3, 1.0, 0.8], [0, 13, 1]);      // overhead strip for top edges
  return scene;
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

/* ------------------------------------------------------------------ *
 * The royal state coach
 * ------------------------------------------------------------------ */

/**
 * A tube whose radius tapers along its length — scrolls, springs and plume
 * quills all need one, and TubeGeometry only does constant radius.
 */
function taperTube(curve, r0, r1, segments = 48, radial = 10) {
  const frames = curve.computeFrenetFrames(segments, false);
  const pos = [], nor = [], uv = [], idx = [];
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    curve.getPointAt(t, p);
    const r = lerp(r0, r1, t);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      n.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a)).normalize();
      pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
      nor.push(n.x, n.y, n.z);
      uv.push(t, j / radial);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Lathe around the Y axis from a list of [radius, height] pairs. */
function lathe(profile, segments = 28) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/* ------------------------------------------------------------------ *
 * Fairy-tale coach: cloud bed, arrival flash, feathered wings
 * ------------------------------------------------------------------ */

/**
 * A cumulus puff: dozens of soft discs, denser and brighter toward the top
 * where the sun catches it, with a flatter, greyer base. Drawn once.
 */
let cloudTex = null;
function cloudTexture() {
  if (cloudTex) return cloudTex;
  cloudTex = canvasTexture(256, (g, s) => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI, r = Math.sqrt(rnd());
      const x = s / 2 + Math.cos(a) * r * s * 0.34 * (rnd() < 0.5 ? -1 : 1);
      const y = s * 0.62 - Math.sin(a) * r * s * 0.26;
      const rad = s * (0.07 + rnd() * 0.12) * (1 - r * 0.4);
      const lit = 1 - (y / s - 0.35);                    // brighter on top
      const gr = g.createRadialGradient(x, y - rad * 0.25, 0, x, y, rad);
      const v = Math.round(215 + 40 * Math.min(lit, 1));
      gr.addColorStop(0, `rgba(${v},${v},${v},0.55)`);
      gr.addColorStop(0.6, `rgba(${v - 20},${v - 20},${v - 10},0.28)`);
      gr.addColorStop(1, 'rgba(200,200,215,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
    }
    // flatten the base
    const fade = g.createLinearGradient(0, s * 0.62, 0, s * 0.8);
    fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = fade; g.fillRect(0, s * 0.62, s, s * 0.38);
    g.globalCompositeOperation = 'source-over';
  });
  return cloudTex;
}

/**
 * The luminous cloud bank the coach rides on, as in the reference: white and
 * lavender puffs lit from inside, drifting back past the wheels so the coach
 * reads as flying, with a soft glow under the whole bank. Also carries the
 * white arrival flash that blooms around the winged horse.
 */
function buildCloudBed(rig, ground, lowPower, flashAt) {
  const root = group(0, 0, 0);
  rig.add(root);
  const tex = cloudTexture();
  const tints = [0xffffff, 0xf1e6ff, 0xe4d2ff, 0xffe6f6, 0xfff6ea];
  const puffs = [];
  const n = lowPower ? 16 : 26;
  const SPAN = 9.6;
  for (let i = 0; i < n; i++) {
    const back = i % 3 === 0;                      // a row behind the wheels, and one in front
    const m = new THREE.SpriteMaterial({
      map: tex, color: new THREE.Color(tints[i % tints.length]).multiplyScalar(back ? 1.05 : 1.35),
      transparent: true, depthWrite: false, opacity: 0
    });
    const sp = new THREE.Sprite(m);
    const w = 1.5 + Math.random() * 1.9;
    sp.scale.set(w, w * 0.62, 1);
    sp.userData = {
      x: -SPAN / 2 + (i / n) * SPAN + Math.random() * 0.3,
      y: ground + (back ? 0.05 : -0.25) + Math.random() * 0.3,
      z: back ? -1.1 - Math.random() * 0.4 : 0.9 + Math.random() * 0.8,
      speed: 0.35 + Math.random() * 0.25,
      op: back ? 0.85 : 0.95,
      bob: Math.random() * 6.28
    };
    sp.renderOrder = back ? 2 : 8;
    root.add(sp);
    puffs.push(sp);
  }
  // Inner glow: the bank lit from within.
  const glowMat = new THREE.SpriteMaterial({ map: TEX.spark, color: 0xc9a6ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const glow = new THREE.Sprite(glowMat);
  glow.scale.set(11, 2.6, 1);
  glow.position.set(0, ground + 0.1, 0.2);
  glow.renderOrder = 3;
  root.add(glow);

  // White arrival flash with a star glint.
  const flashMat = new THREE.SpriteMaterial({ map: TEX.spark, color: 0xf2eeff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flash = new THREE.Sprite(flashMat);
  flash.position.copy(flashAt);
  flash.renderOrder = 9;
  root.add(flash);
  const starMat = flashMat.clone(); starMat.map = TEX.star;
  const star = new THREE.Sprite(starMat);
  star.position.copy(flashAt);
  star.renderOrder = 9;
  root.add(star);

  return {
    update(t, u) {
      const vis = Math.min(u / 0.12, 1);
      puffs.forEach((sp) => {
        const d = sp.userData;
        // drift aft and wrap, so the bank streams past a coach holding station
        let x = d.x + t * d.speed;
        x = ((x + SPAN / 2) % SPAN + SPAN) % SPAN - SPAN / 2;
        sp.position.set(x, d.y + Math.sin(t * 0.8 + d.bob) * 0.04, d.z);
        const edge = 1 - Math.pow(Math.abs(x) / (SPAN / 2), 6);      // thin out at the wrap
        sp.material.opacity = d.op * edge * vis;
      });
      glowMat.opacity = 0.55 * vis;
      // Flash: quick bloom around u = 0.42, then a lingering soft halo.
      const f = Math.exp(-Math.pow((u - 0.42) / 0.035, 2));
      const halo = Math.exp(-Math.pow((u - 0.46) / 0.12, 2)) * 0.25;
      flashMat.opacity = Math.min(f + halo, 1);
      flash.scale.setScalar(1.4 + f * 2.2 + halo * 2);
      starMat.opacity = f;
      star.scale.setScalar(1.2 + f * 2.4);
      star.material.rotation = t * 0.6;
    }
  };
}

/**
 * A feathered wing, built the way a bird's is: long primaries fanning from
 * the hand, secondaries along the forearm, two overlapping rows of coverts
 * over their bases and a soft bulk along the leading edge. Every feather is
 * a slightly cupped quad with a drawn vane (rachis, barbs, a rounded tip)
 * cut out by alpha; all of them are merged into one mesh per wing.
 *
 * Local frame: the leading edge rises along +y, feathers trail along +x.
 */
let featherTex = null;
function featherTexture() {
  if (featherTex) return featherTex;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  const outline = () => {
    g.beginPath();
    g.moveTo(30, 256);
    g.bezierCurveTo(8, 200, 6, 60, 26, 8);
    g.quadraticCurveTo(34, -2, 42, 10);
    g.bezierCurveTo(60, 70, 58, 200, 36, 256);
    g.closePath();
  };
  outline();
  const body = g.createLinearGradient(0, 0, 0, 256);
  body.addColorStop(0, '#f4f2f6'); body.addColorStop(0.5, '#ffffff'); body.addColorStop(1, '#e9e6ee');
  g.fillStyle = body; g.fill();
  g.save(); outline(); g.clip();
  // barbs: fine diagonal lines, angled toward the tip
  for (let y = -40; y < 280; y += 3) {
    g.strokeStyle = `rgba(150,145,170,${0.08 + Math.random() * 0.08})`; g.lineWidth = 1;
    g.beginPath(); g.moveTo(32, y + 16); g.lineTo(0, y); g.moveTo(32, y + 16); g.lineTo(64, y); g.stroke();
  }
  // a few splits in the vane
  for (let i = 0; i < 5; i++) {
    const y = 40 + Math.random() * 180, side = Math.random() < 0.5 ? -1 : 1;
    g.strokeStyle = 'rgba(120,115,140,0.35)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(32, y + 10); g.lineTo(32 + side * 30, y - 6); g.stroke();
  }
  g.restore();
  // rachis
  g.strokeStyle = 'rgba(175,168,190,0.9)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(32, 256); g.quadraticCurveTo(31, 120, 33, 10); g.stroke();
  featherTex = new THREE.CanvasTexture(c);
  featherTex.colorSpace = THREE.SRGBColorSpace;
  featherTex.anisotropy = 4;
  return featherTex;
}

function buildWing(span = 1.0) {
  const parts = [];
  const feather = (x, y, angle, len, wid, z, cup = 0.05) => {
    const geo = new THREE.PlaneGeometry(wid, len, 1, 5);
    geo.translate(0, len / 2, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const k = pos.getY(i) / len;
      pos.setZ(i, cup * k * k * len + Math.abs(pos.getX(i)) * -0.25);   // cupped and curving away
    }
    geo.computeVertexNormals();
    geo.rotateZ(angle);
    geo.translate(x, y, z);
    parts.push(geo);
  };
  const lead = (y) => -0.1 * Math.sin(Math.PI * Math.min(y, 1));        // leading edge bows forward
  // Secondaries: along the arm, trailing aft and a little down.
  for (let i = 0; i < 20; i++) {
    const k = i / 19, y = 0.04 + k * 0.5;
    feather(lead(y) + 0.02, y, -Math.PI / 2 - 0.2 + k * 0.12, 0.5 + k * 0.1, 0.19, -0.004 * i);
  }
  // Primaries: from the hand, fanning from aft to nearly straight up.
  for (let i = 0; i < 16; i++) {
    const k = i / 15, y = 0.54 + k * 0.44;
    const len = 0.66 + Math.sin(k * Math.PI * 0.8) * 0.3;
    feather(lead(y) + 0.02, y, -Math.PI / 2 + 0.1 + k * 1.05, len, 0.18, -0.06 - 0.004 * i, 0.08);
  }
  // Greater and lesser coverts.
  for (let i = 0; i < 22; i++) {
    const k = i / 21, y = 0.02 + k * 0.92;
    feather(lead(y) + 0.01, y, -Math.PI / 2 - 0.12 + k * (k > 0.55 ? 0.8 : 0.15), 0.32 - k * 0.06, 0.16, 0.02, 0.03);
  }
  for (let i = 0; i < 20; i++) {
    const k = i / 19, y = 0.0 + k * 0.9;
    feather(lead(y), y, -Math.PI / 2 + k * 0.35, 0.18, 0.14, 0.035, 0.02);
  }
  const geo = mergeGeometries(parts);
  geo.scale(span, span, span);
  const mat = new THREE.MeshStandardMaterial({
    map: featherTexture(), alphaTest: 0.4, side: THREE.DoubleSide,
    color: 0xffffff, roughness: 0.7, metalness: 0,
    emissive: 0x3a3448, emissiveIntensity: 0.6
  });
  const m = new THREE.Mesh(geo, mat);
  // leading-edge bulk
  const edge = new THREE.CatmullRomCurve3(Array.from({ length: 8 }, (_, i) => {
    const y = i / 7 * 0.98;
    return new THREE.Vector3(lead(y) * span, y * span, 0.03 * span);
  }));
  const bulk = new THREE.Mesh(new THREE.TubeGeometry(edge, 24, 0.035 * span, 8), new THREE.MeshStandardMaterial({ color: 0xf6f4f8, roughness: 0.75, emissive: 0x3a3448, emissiveIntensity: 0.5 }));
  const g = new THREE.Group();
  g.add(m, bulk);
  return g;
}

/**
 * A pair of wings on a carrier, raised in a V over the withers. `at` is the
 * withers in the carrier's space.
 */
function attachWings(carrier, at, span) {
  const pair = [1, -1].map((side) => {
    const hinge = group(at.x, at.y, at.z + side * 0.12);
    const w = buildWing(span);
    if (side < 0) w.scale.z = -1;                      // mirror, so the cupping faces out on both
    hinge.add(w);
    carrier.add(hinge);
    w.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return { hinge, side };
  });
  return pair.map(({ hinge, side }) => ({
    update(t) {
      const beat = t * 2.6 + (side < 0 ? 0.25 : 0);
      const flap = Math.sin(beat);
      hinge.rotation.set(0, 0, 0);
      hinge.rotateZ(-0.28 + flap * 0.1);                 // swept back, a little more on the downstroke
      hinge.rotateX(side * (0.3 + flap * 0.32));         // spread out toward the viewer and away
    }
  }));
}

/**
 * Builds the coach. Everything is measured in the same units as the fitted
 * horse model (a horse is 3.3 long), with the ground at y = -1.45 and the
 * coach facing -x like every other ride.
 *
 * The body is not a box with a bevel. It is a stack of rounded-rectangle
 * rings whose length and width swell out and back in with height — the
 * "bombé" belly of a real state coach — closed by a domed roof. Each ring is
 * parameterised by arc length over fixed segments, so a texture coordinate
 * always lands on the same feature at every height: the panels, windows and
 * mouldings are painted and modelled against one shared (u, v) map.
 */
function buildStateCoach({ lowPower = false, fairy = false } = {}) {
  const root = group();
  const rig = group(-0.27, 0, 0);          // centre the long composition on the pivot
  root.add(rig);

  // ---------------------------------------------------------------- materials
  const GOLD = new THREE.MeshPhysicalMaterial({
    color: 0xf3c460, metalness: 1, roughness: 0.22, clearcoat: 0.35, clearcoatRoughness: 0.18,
    roughnessMap: TEX.metalRough, normalMap: TEX.metalNormal, normalScale: new THREE.Vector2(0.14, 0.14)
  });
  const LACQUER = new THREE.MeshPhysicalMaterial({
    color: 0x5a0814, metalness: 0, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.05
  });
  const IRON = new THREE.MeshStandardMaterial({ color: 0x25272c, metalness: 1, roughness: 0.46, roughnessMap: TEX.grainRough });
  const LEATHER = new THREE.MeshStandardMaterial({
    color: 0x1c120c, metalness: 0, roughness: 0.5, normalMap: TEX.grainNormal, normalScale: new THREE.Vector2(0.35, 0.35)
  });
  const PEARL = new THREE.MeshPhysicalMaterial({ color: 0xf2ece0, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08, sheen: 0.6, sheenColor: new THREE.Color(0xfff3ff) });
  const gem = (c) => new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.03, metalness: 0.05, clearcoat: 1, clearcoatRoughness: 0, ior: 2.3, emissive: c, emissiveIntensity: 0.08 });
  const RUBY = gem(0x9d0a24), SAPPHIRE = gem(0x0f2f96), EMERALD = gem(0x0b6b3c);
  const VELVET = new THREE.MeshPhysicalMaterial({ color: 0x6c0a1b, roughness: 0.85, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color(0xff5670) });

  // ---------------------------------------------------------------- body surface
  const BODY_X = 2.1;
  const Y0 = -0.28, WALL_H = 1.3, ROOF_H = 0.32, WALL_V = 0.8, RC = 0.2;
  const ease = (t) => Math.sin(t * Math.PI / 2);
  function wallDims(k) {
    const up = k < 0.35;
    const t = up ? ease(k / 0.35) : smooth((k - 0.35) / 0.65);
    return {
      a: up ? lerp(0.84, 1.02, t) : lerp(1.02, 0.93, t),
      b: up ? lerp(0.44, 0.6, t) : lerp(0.6, 0.54, t),
      rc: RC,
      y: Y0 + WALL_H * k
    };
  }
  function dimsAt(v) {
    if (v <= WALL_V) return wallDims(v / WALL_V);
    const top = wallDims(1);
    const phi = ((v - WALL_V) / (1 - WALL_V)) * Math.PI / 2;
    const c = 0.22 + 0.78 * Math.cos(phi);
    return { a: top.a * c, b: top.b * c, rc: RC * c, y: top.y + ROOF_H * Math.sin(phi) };
  }
  // Fixed u ranges for each run of the rounded rectangle, starting at the
  // rear centre and going round through the +z (camera) side.
  const SEG = [
    [0.00, 0.06, 0], [0.06, 0.12, 1], [0.12, 0.38, 2], [0.38, 0.44, 3],
    [0.44, 0.56, 4], [0.56, 0.62, 5], [0.62, 0.88, 6], [0.88, 0.94, 7], [0.94, 1.00, 8]
  ];
  function ringPoint(u, d, out) {
    u = ((u % 1) + 1) % 1;
    const { a, b, rc } = d, ax = a - rc, bz = b - rc;
    for (const [u0, u1, kind] of SEG) {
      if (u > u1 && u1 < 1) continue;
      const t = (u - u0) / (u1 - u0);
      const arc = (base, cx, cz) => {
        const ang = base + t * Math.PI / 2;
        return out.set(cx + rc * Math.cos(ang), d.y, cz + rc * Math.sin(ang));
      };
      switch (kind) {
        case 0: return out.set(a, d.y, lerp(0, bz, t));
        case 1: return arc(0, ax, bz);
        case 2: return out.set(lerp(ax, -ax, t), d.y, b);
        case 3: return arc(Math.PI / 2, -ax, bz);
        case 4: return out.set(-a, d.y, lerp(bz, -bz, t));
        case 5: return arc(Math.PI, -ax, -bz);
        case 6: return out.set(lerp(-ax, ax, t), d.y, -b);
        case 7: return arc(Math.PI * 1.5, ax, -bz);
        default: return out.set(a, d.y, lerp(-bz, 0, t));
      }
    }
    return out;
  }
  const S = (u, v, out = new THREE.Vector3()) => ringPoint(u, dimsAt(v), out);
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3(), tmpD = new THREE.Vector3();
  function N(u, v, out = new THREE.Vector3()) {
    const e = 0.0015;
    S(u + e, v, tmpA); S(u - e, v, tmpB); tmpA.sub(tmpB);        // along u
    S(u, Math.min(v + e, 1), tmpC); S(u, Math.max(v - e, 0), tmpD); tmpC.sub(tmpD);
    return out.crossVectors(tmpC, tmpA).normalize();              // outward
  }
  // Helpers to address features by x on a side, or z on an end.
  const axAt = (k) => wallDims(k).a - RC;
  const bzAt = (k) => wallDims(k).b - RC;
  const uSide = (x, k, far = false) => far
    ? 0.62 + (x + axAt(k)) / (2 * axAt(k)) * 0.26
    : 0.12 + (1 - x / axAt(k)) * 0.13;
  const uFront = (z, k) => 0.44 + (1 - z / bzAt(k)) * 0.06;
  const vK = (k) => k * WALL_V;

  function bodyGeometry() {
    const U = lowPower ? 96 : 140, V = lowPower ? 36 : 56;
    const pos = [], uvs = [], idx = [];
    const p = new THREE.Vector3();
    for (let j = 0; j <= V; j++) {
      const v = j / V;
      for (let i = 0; i <= U; i++) {
        S(i / U, v, p);
        pos.push(p.x, p.y, p.z);
        uvs.push(i / U, v);
      }
    }
    for (let j = 0; j < V; j++) {
      for (let i = 0; i < U; i++) {
        const a = j * (U + 1) + i, b = a + 1, c = a + U + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    // Caps: a fan under the floor and over the roof platform.
    const addCap = (v, up) => {
      const d = dimsAt(v);
      const centre = pos.length / 3;
      pos.push(0, d.y, 0); uvs.push(0.25, v);
      const start = pos.length / 3;
      for (let i = 0; i <= U; i++) { S(i / U, v, p); pos.push(p.x, p.y, p.z); uvs.push(i / U, v); }
      for (let i = 0; i < U; i++) up ? idx.push(centre, start + i + 1, start + i) : idx.push(centre, start + i, start + i + 1);
    };
    addCap(0, false);
    addCap(1, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Weld the normals across the u = 0 / u = 1 seam at the rear.
    const n = g.attributes.normal;
    for (let j = 0; j <= V; j++) {
      const a = j * (U + 1), b = a + U;
      const x = (n.getX(a) + n.getX(b)) / 2, y = (n.getY(a) + n.getY(b)) / 2, z = (n.getZ(a) + n.getZ(b)) / 2;
      const l = Math.hypot(x, y, z) || 1;
      n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
    }
    return g;
  }

  // ---------------------------------------------------------------- paint
  // Three canvases on the one (u, v) map: colour, roughness/metalness, and
  // height (turned into a normal map). Gold is burnished where it is flat and
  // matte where it is chased, which is how real gilding shows its pattern.
  const TW = lowPower ? 1024 : 2048, TH = TW / 2;
  const cols = document.createElement('canvas'); cols.width = TW; cols.height = TH;
  const orms = document.createElement('canvas'); orms.width = TW; orms.height = TH;
  const hgts = document.createElement('canvas'); hgts.width = TW; hgts.height = TH;
  const C = cols.getContext('2d'), O = orms.getContext('2d'), H = hgts.getContext('2d');
  const X = (u) => u * TW, Y = (v) => (1 - v) * TH;
  // The fairy-tale coach is gold all over: its panels are a deeper, matte,
  // chased gold where the state coach has crimson lacquer.
  const GOLD_C = '#f1c25c', LAQ_C = fairy ? '#b98a34' : '#5a0814';
  const ORM_GOLD = 'rgb(0,62,255)', ORM_MATTE = 'rgb(0,150,255)', ORM_LAQ = fairy ? 'rgb(0,125,255)' : 'rgb(0,70,0)';
  C.fillStyle = GOLD_C; C.fillRect(0, 0, TW, TH);
  O.fillStyle = ORM_GOLD; O.fillRect(0, 0, TW, TH);
  H.fillStyle = '#808080'; H.fillRect(0, 0, TW, TH);

  const rrect = (ctx, x0, y0, x1, y1, r) => {
    const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  };
  // A recessed lacquer panel with a raised, bevelled gold frame.
  function panel(u0, v0, u1, v1, r = 18) {
    const [x0, y0, x1, y1] = [X(u0), Y(v0), X(u1), Y(v1)];
    rrect(C, x0, y0, x1, y1, r); C.fillStyle = LAQ_C; C.fill();
    rrect(O, x0, y0, x1, y1, r); O.fillStyle = ORM_LAQ; O.fill();
    for (let i = 0; i < 7; i++) {                                // bevel: raised ring falling to the recess
      rrect(H, x0 - 7 + i, y1 - 7 + i, x1 + 7 - i, y0 + 7 - i, r + 7 - i);
      H.strokeStyle = `rgb(${200 - i * 18},${200 - i * 18},${200 - i * 18})`; H.lineWidth = 2; H.stroke();
    }
    rrect(H, x0, y0, x1, y1, r); H.fillStyle = '#5a5a5a'; H.fill();
    // fine gold pinstripe inside the panel
    const inset = 10;
    rrect(C, x0 + inset, y0 - inset, x1 - inset, y1 + inset, r * 0.6); C.strokeStyle = '#c8973e'; C.lineWidth = 2; C.stroke();
    rrect(O, x0 + inset, y0 - inset, x1 - inset, y1 + inset, r * 0.6); O.strokeStyle = ORM_GOLD; O.lineWidth = 2; O.stroke();
  }
  // Chased acanthus scroll: matte against burnished, and raised.
  function scroll(cx, cy, s, dir = 1) {
    for (const [ctx, style, w] of [[O, ORM_MATTE, 5 * s], [H, '#c8c8c8', 5 * s], [C, '#c99a41', 2.2 * s]]) {
      ctx.strokeStyle = style; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let t = 0; t <= 1; t += 0.02) {
        const a = t * Math.PI * 3.2 * dir, r = (1 - t * 0.85) * 22 * s;
        const x = cx + Math.cos(a) * r + t * 36 * s * dir, y = cy + Math.sin(a) * r;
        t ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  }
  // A row of gadroons (vertical flutes) along the bottom rail.
  for (let u = 0; u < 1; u += 0.006) {
    const x = X(u);
    const g = H.createLinearGradient(x, 0, x + TW * 0.006, 0);
    g.addColorStop(0, '#6a6a6a'); g.addColorStop(0.5, '#c4c4c4'); g.addColorStop(1, '#6a6a6a');
    H.fillStyle = g; H.fillRect(x, Y(vK(0.075)), TW * 0.006, Y(vK(0.0)) - Y(vK(0.075)));
  }
  // Egg-and-dart on the belt band.
  for (let u = 0; u < 1; u += 0.008) {
    const x = X(u + 0.004), y = Y(vK(0.46));
    H.fillStyle = '#d0d0d0'; H.beginPath(); H.ellipse(x, y, TW * 0.0026, TH * 0.012, 0, 0, 7); H.fill();
    O.fillStyle = ORM_GOLD; O.beginPath(); O.ellipse(x, y, TW * 0.0026, TH * 0.012, 0, 0, 7); O.fill();
    H.fillStyle = '#6a6a6a'; H.fillRect(X(u) - 1, y - TH * 0.01, 2, TH * 0.02);
  }

  // Lower panels on both sides, with the royal arms on the doors.
  const k0 = 0.09, k1 = 0.4, km = 0.25;
  for (const far of [false, true]) {
    const uA = uSide(far ? -0.66 : 0.66, km, far), uB = uSide(far ? 0.66 : -0.66, km, far);
    panel(Math.min(uA, uB), vK(k0), Math.max(uA, uB), vK(k1));
    const uc = uSide(0, km, far);
    // shield, quartered
    const cx = X(uc), cy = Y(vK(0.245)), w = TW * 0.018, h = TH * 0.1;
    const shield = (ctx) => {
      ctx.beginPath(); ctx.moveTo(cx - w, cy - h * 0.55); ctx.lineTo(cx + w, cy - h * 0.55);
      ctx.lineTo(cx + w, cy + h * 0.1); ctx.quadraticCurveTo(cx + w, cy + h * 0.6, cx, cy + h * 0.75);
      ctx.quadraticCurveTo(cx - w, cy + h * 0.6, cx - w, cy + h * 0.1); ctx.closePath();
    };
    shield(C); C.save(); C.clip();
    if (fairy) { C.fillStyle = '#d9a845'; C.fillRect(cx - w, cy - h, w * 2, h * 2); } else {
    C.fillStyle = '#a3182c'; C.fillRect(cx - w, cy - h, w, h * 2); C.fillStyle = '#16307e'; C.fillRect(cx, cy - h, w, h * 2);
    C.fillStyle = '#16307e'; C.fillRect(cx - w, cy + h * 0.1, w, h); C.fillStyle = '#a3182c'; C.fillRect(cx, cy + h * 0.1, w, h);
    }
    C.restore();
    shield(C); C.strokeStyle = GOLD_C; C.lineWidth = 5; C.stroke();
    shield(O); O.fillStyle = fairy ? ORM_GOLD : 'rgb(0,90,0)'; O.fill(); O.strokeStyle = ORM_GOLD; O.lineWidth = 5; O.stroke();
    shield(H); H.strokeStyle = '#d8d8d8'; H.lineWidth = 6; H.stroke();
    // a crown over the shield
    const cy2 = cy - h * 0.72;
    for (const ctx of [C, O, H]) {
      ctx.fillStyle = ctx === C ? GOLD_C : ctx === O ? ORM_GOLD : '#d0d0d0';
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.9, cy2 + 10); ctx.lineTo(cx - w * 0.9, cy2 - 8); ctx.lineTo(cx - w * 0.45, cy2 + 2);
      ctx.lineTo(cx, cy2 - 16); ctx.lineTo(cx + w * 0.45, cy2 + 2); ctx.lineTo(cx + w * 0.9, cy2 - 8);
      ctx.lineTo(cx + w * 0.9, cy2 + 10); ctx.closePath(); ctx.fill();
    }
    // scrolls flanking the arms
    scroll(X(uSide(far ? -0.38 : 0.38, km, far)), Y(vK(0.24)), 1.1, far ? 1 : -1);
    scroll(X(uSide(far ? 0.38 : -0.38, km, far)), Y(vK(0.24)), 1.1, far ? -1 : 1);
  }
  // Front and rear lower panels.
  panel(uFront(0.3, km), vK(k0), uFront(-0.3, km), vK(k1));
  panel(-0.045 + 1, vK(k0), 1.0, vK(k1)); panel(0.0, vK(k0), 0.045, vK(k1));
  // Chased scrolls on the pilasters between the windows.
  for (const far of [false, true]) {
    for (const x of [-0.56, 0.56, -0.86, 0.86]) {
      if (Math.abs(x) > axAt(0.72)) continue;
      scroll(X(uSide(x, 0.72, far)), Y(vK(0.7)), 0.6, x > 0 ? 1 : -1);
    }
  }
  // Roof: lacquered, with four gilt ribs from the corners up to the platform.
  C.fillStyle = LAQ_C; C.fillRect(0, 0, TW, Y(WALL_V + 0.012));
  O.fillStyle = ORM_LAQ; O.fillRect(0, 0, TW, Y(WALL_V + 0.012));
  for (const u of [0.09, 0.41, 0.59, 0.91]) {
    for (const [ctx, st] of [[C, GOLD_C], [O, ORM_GOLD], [H, '#d0d0d0']]) {
      ctx.fillStyle = st; ctx.fillRect(X(u) - TW * 0.004, 0, TW * 0.008, Y(WALL_V));
    }
  }

  const bodyMap = new THREE.CanvasTexture(cols); bodyMap.colorSpace = THREE.SRGBColorSpace; bodyMap.anisotropy = 8;
  const bodyOrm = new THREE.CanvasTexture(orms); bodyOrm.anisotropy = 8;
  const bodyNrm = (() => {
    const src = H.getImageData(0, 0, TW, TH).data;
    const out = H.createImageData(TW, TH);
    const at = (x, y) => src[((Math.min(Math.max(y, 0), TH - 1)) * TW + ((x + TW) % TW)) * 4] / 255;
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * 3.2, dy = (at(x, y + 1) - at(x, y - 1)) * 3.2;
        const inv = 1 / Math.hypot(dx, dy, 1), i = (y * TW + x) * 4;
        out.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
        out.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
        out.data[i + 2] = (inv * 0.5 + 0.5) * 255;
        out.data[i + 3] = 255;
      }
    }
    const c = document.createElement('canvas'); c.width = TW; c.height = TH;
    c.getContext('2d').putImageData(out, 0, 0);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 8;
    return t;
  })();
  const BODY_MAT = new THREE.MeshPhysicalMaterial({
    map: bodyMap, roughnessMap: bodyOrm, metalnessMap: bodyOrm, normalMap: bodyNrm,
    normalScale: new THREE.Vector2(0.9, 0.9), roughness: 1, metalness: 1,
    clearcoat: 0.55, clearcoatRoughness: 0.08
  });

  // ---------------------------------------------------------------- assemble body
  // The body hangs from leather braces, so it sways about a point above it.
  const hang = group(BODY_X, 0.55, 0);
  rig.add(hang);
  const body = group(0, -0.55, 0);
  hang.add(body);
  body.add(new THREE.Mesh(bodyGeometry(), BODY_MAT));

  // Conforming patch on the body surface, pushed out along the normal.
  function patch(u0, u1, v0, v1, lift, nu = 16, nv = 12) {
    const pos = [], uv = [], idx = [];
    const p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = lerp(u0, u1, i / nu), v = lerp(v0, v1, j / nv);
        S(u, v, p); N(u, v, n);
        p.addScaledVector(n, lift);
        pos.push(p.x, p.y, p.z);
        uv.push(i / nu, j / nv);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  // A moulding: a tube laid along a curve drawn in (u, v).
  function moulding(uvPoints, radius, mat = GOLD, closed = false, lift = 0) {
    const pts = uvPoints.map(([u, v]) => {
      const p = S(u, v), n = N(u, v);
      return p.addScaledVector(n, radius * 0.6 + lift);
    });
    const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, pts.length * 3), radius, 8, closed), mat);
    body.add(m);
    return m;
  }
  const loop = (v, n = 140) => Array.from({ length: n }, (_, i) => [i / n, v]);
  moulding(loop(vK(0.012)), 0.028, GOLD, true);
  moulding(loop(vK(0.46)), 0.032, GOLD, true);
  moulding(loop(vK(0.998)), 0.04, GOLD, true);
  moulding(loop(WALL_V + 0.12), 0.018, GOLD, true);

  // Beading along the roof rail.
  {
    const count = lowPower ? 90 : 150;
    const beads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.02, 10, 8), GOLD, count);
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const u = i / count, v = vK(0.975);
      S(u, v, p); N(u, v, n); p.addScaledVector(n, 0.03);
      m4.makeTranslation(p.x, p.y, p.z);
      beads.setMatrixAt(i, m4);
    }
    body.add(beads);
  }

  // Windows: glass over a lit interior with velvet curtains.
  const interior = fairy ? (() => {
    // Tinted teal glass: deep at the edges, lighter through the middle, with
    // the soft diagonal reflections that make a pane read as glass.
    const c = document.createElement('canvas'); c.width = 256; c.height = 320;
    const g = c.getContext('2d');
    const bg = g.createRadialGradient(128, 170, 10, 128, 170, 230);
    bg.addColorStop(0, '#5fd6bf'); bg.addColorStop(0.55, '#1f8f86'); bg.addColorStop(1, '#0a3f45');
    g.fillStyle = bg; g.fillRect(0, 0, 256, 320);
    g.globalCompositeOperation = 'lighter';
    for (const [x, w, a] of [[40, 70, 0.22], [130, 26, 0.16], [175, 12, 0.12]]) {
      const gr = g.createLinearGradient(x, 0, x + w, 0);
      gr.addColorStop(0, 'rgba(210,255,245,0)'); gr.addColorStop(0.5, `rgba(210,255,245,${a})`); gr.addColorStop(1, 'rgba(210,255,245,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(x, 320); g.lineTo(x + w, 320); g.lineTo(x + w + 120, 0); g.lineTo(x + 120, 0); g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })() : (() => {
    const c = document.createElement('canvas'); c.width = 256; c.height = 320;
    const g = c.getContext('2d');
    const bg = g.createRadialGradient(128, 150, 10, 128, 170, 220);
    bg.addColorStop(0, '#ffd9a0'); bg.addColorStop(0.5, '#b36b35'); bg.addColorStop(1, '#3a1a10');
    g.fillStyle = bg; g.fillRect(0, 0, 256, 320);
    // buttoned silk seat back
    g.fillStyle = 'rgba(245,225,190,0.55)'; g.fillRect(40, 190, 176, 130);
    g.fillStyle = 'rgba(120,80,40,0.5)';
    for (let y = 205; y < 320; y += 22) for (let x = 55 + ((y / 22) % 2) * 11; x < 210; x += 22) { g.beginPath(); g.arc(x, y, 2.4, 0, 7); g.fill(); }
    // curtains: folds as vertical gradients, tied back at the waist
    const curtain = (x0, dir) => {
      for (let i = 0; i < 7; i++) {
        const x = x0 + dir * i * 11;
        const gr = g.createLinearGradient(x, 0, x + dir * 11, 0);
        gr.addColorStop(0, '#4a0612'); gr.addColorStop(0.5, '#9a1428'); gr.addColorStop(1, '#4a0612');
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(x, 0); g.lineTo(x + dir * 11, 0);
        g.quadraticCurveTo(x + dir * (14 - i * 1.6), 150, x + dir * (4 - i * 0.2), 190);
        g.quadraticCurveTo(x + dir * (18 - i * 1.4), 250, x + dir * (22 - i * 1.5), 320);
        g.lineTo(x + dir * (12 - i * 1.2), 320);
        g.quadraticCurveTo(x - dir * (2 + i), 250, x - dir * (i * 0.5), 190);
        g.closePath(); g.fill();
      }
      g.fillStyle = '#e0ae4e'; g.fillRect(dir > 0 ? x0 : x0 - 40, 184, 40, 7);
    };
    curtain(0, 1); curtain(256, -1);
    // valance across the top
    g.fillStyle = '#7e0f22'; g.fillRect(0, 0, 256, 34);
    g.fillStyle = '#e0ae4e'; for (let x = 0; x < 256; x += 8) g.fillRect(x, 34, 4, 9);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const archMask = (() => {
    const c = document.createElement('canvas'); c.width = 128; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 128, 160);
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, 160); g.lineTo(0, 52);
    g.quadraticCurveTo(0, 0, 64, 0); g.quadraticCurveTo(128, 0, 128, 52); g.lineTo(128, 160); g.closePath(); g.fill();
    return new THREE.CanvasTexture(c);
  })();
  const GLASS = new THREE.MeshPhysicalMaterial({
    map: interior, emissiveMap: interior, emissive: 0xffffff, emissiveIntensity: fairy ? 0.42 : 0.3,
    roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.0, envMapIntensity: 1.7
  });
  const GLASS_ARCH = GLASS.clone(); GLASS_ARCH.alphaMap = archMask; GLASS_ARCH.alphaTest = 0.5;

  function windowAt(u0, u1, k0w, k1w, arched) {
    body.add(new THREE.Mesh(patch(u0, u1, vK(k0w), vK(k1w), 0.004), arched ? GLASS_ARCH : GLASS));
    // Frame: follow the outline, arching over the top if needed.
    const pts = [];
    const vv0 = vK(k0w), vv1 = vK(k1w);
    pts.push([u0, vv0], [u1, vv0]);
    if (arched) {
      const archStart = lerp(vv0, vv1, 0.68);
      pts.push([u1, archStart]);
      for (let i = 1; i < 10; i++) {
        const a = (i / 10) * Math.PI;
        pts.push([lerp(u0, u1, 0.5 + 0.5 * Math.cos(a)), archStart + (vv1 - archStart) * Math.sin(a)]);
      }
      pts.push([u0, archStart]);
    } else {
      pts.push([u1, vv1], [u0, vv1]);
    }
    moulding(pts, 0.017, GOLD, true, 0.004);
  }
  for (const far of [false, true]) {
    const s = far ? -1 : 1;
    const U = (x) => uSide(x * s, 0.72, far);
    windowAt(Math.min(U(0.28), U(-0.28)), Math.max(U(0.28), U(-0.28)), 0.53, 0.92, true);
    windowAt(Math.min(U(0.68), U(0.42)), Math.max(U(0.68), U(0.42)), 0.56, 0.88, false);
    windowAt(Math.min(U(-0.68), U(-0.42)), Math.max(U(-0.68), U(-0.42)), 0.56, 0.88, false);
  }
  windowAt(uFront(0.26, 0.72), uFront(-0.26, 0.72), 0.55, 0.9, true);
  windowAt(-0.042, 0.042, 0.55, 0.9, true);

  // Door: outline moulding, a handle, and the hinges.
  for (const far of [false, true]) {
    const s = far ? -1 : 1;
    const U = (x, k) => uSide(x * s, k, far);
    moulding([[U(0.36, 0.05), vK(0.05)], [U(-0.36, 0.05), vK(0.05)], [U(-0.36, 0.95), vK(0.95)], [U(0.36, 0.95), vK(0.95)]], 0.011, GOLD, true, 0.002);
    const hp = S(U(-0.26, 0.47), vK(0.47)), hn = N(U(-0.26, 0.47), vK(0.47));
    const handle = mesh(lathe([[0, 0], [0.018, 0.0], [0.026, 0.03], [0.014, 0.05], [0.03, 0.07], [0, 0.085]], 16), GOLD);
    handle.position.copy(hp);
    handle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), hn);
    body.add(handle);
  }

  // Corner finials on the roof rail: lathe-turned urns with a flame.
  const urn = lathe([
    [0, 0], [0.07, 0], [0.075, 0.02], [0.05, 0.035], [0.045, 0.06], [0.085, 0.11], [0.09, 0.15],
    [0.06, 0.2], [0.03, 0.22], [0.045, 0.24], [0.02, 0.27], [0.035, 0.31], [0.0, 0.4]
  ], 20);
  for (const u of [0.09, 0.41, 0.59, 0.91]) {
    const p = S(u, vK(1)), f = mesh(urn, GOLD);
    f.position.copy(p).add(new THREE.Vector3(0, 0.02, 0));
    body.add(f);
  }

  // The crown on the roof platform.
  {
    const top = dimsAt(1).y;
    const crown = group(0, top, 0);
    body.add(crown);
    crown.add(mesh(lathe([[0, 0], [0.32, 0], [0.34, 0.03], [0.3, 0.07], [0.31, 0.1], [0.27, 0.12], [0, 0.12]], 40), GOLD));
    crown.add(mesh(lathe([[0.25, 0.1], [0.27, 0.13], [0.265, 0.2], [0.24, 0.22]], 40), GOLD));
    const cap = mesh(new THREE.SphereGeometry(0.235, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), VELVET, 0, 0.2, 0);
    cap.scale.y = 0.85;
    crown.add(cap);
    // four arches meeting under the orb, strung with pearls
    const pearls = [];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const pts = [];
      for (let t = 0; t <= 1.0001; t += 0.1) {
        const r = 0.255 * Math.cos(t * Math.PI / 2 * 0.92);
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0.2 + 0.24 * Math.sin(t * Math.PI / 2) + 0.05 * Math.sin(t * Math.PI), Math.sin(a) * r));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      crown.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.018, 8), GOLD));
      for (let t = 0.08; t < 0.95; t += 0.11) pearls.push(curve.getPointAt(t));
    }
    const pm = new THREE.InstancedMesh(new THREE.SphereGeometry(0.014, 10, 8), PEARL, pearls.length);
    const m4 = new THREE.Matrix4();
    pearls.forEach((p, i) => { m4.makeTranslation(p.x, p.y + 0.012, p.z); pm.setMatrixAt(i, m4); });
    crown.add(pm);
    // jewels round the band
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const gemMesh = mesh(new THREE.SphereGeometry(i % 3 === 0 ? 0.03 : 0.022, 14, 10), [RUBY, SAPPHIRE, EMERALD][i % 3],
        Math.cos(a) * 0.335, 0.055, Math.sin(a) * 0.335);
      gemMesh.scale.z = 0.6; gemMesh.lookAt(0, 0.055, 0);
      crown.add(gemMesh);
    }
    // monde and cross
    crown.add(mesh(new THREE.SphereGeometry(0.05, 20, 14), GOLD, 0, 0.5, 0));
    crown.add(mesh(new THREE.BoxGeometry(0.018, 0.12, 0.018), GOLD, 0, 0.6, 0));
    crown.add(mesh(new THREE.BoxGeometry(0.075, 0.018, 0.018), GOLD, 0, 0.61, 0));
  }

  // Coach lamps on the front corners, on scrolled brackets.
  const lamps = [];
  for (const u of [0.41, 0.59]) {
    const p = S(u, vK(0.62)), n = N(u, vK(0.62));
    const l = group(); l.position.copy(p).addScaledVector(n, 0.13);
    body.add(l);
    const arm = new THREE.Mesh(taperTube(new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(0, 0, 0).addScaledVector(n, -0.13), new THREE.Vector3(0, -0.08, 0), new THREE.Vector3(0, -0.06, 0)
    ), 0.012, 0.01, 16, 6), GOLD);
    l.add(arm);
    l.add(mesh(lathe([[0, -0.07], [0.04, -0.07], [0.05, -0.05], [0.036, -0.03], [0.036, 0]], 16), GOLD));
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xffe7b5, emissive: 0xffa94a, emissiveIntensity: 2.6, roughness: 0.1, transparent: true, opacity: 0.92 });
    l.add(mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.12, 16), glassMat, 0, 0.06, 0));
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      l.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 4), GOLD, Math.cos(a) * 0.037, 0.06, Math.sin(a) * 0.037));
    }
    l.add(mesh(lathe([[0.042, 0.12], [0.05, 0.13], [0.03, 0.17], [0.012, 0.2], [0.02, 0.22], [0, 0.25]], 16), GOLD));
    const halo = mesh(new THREE.PlaneGeometry(0.4, 0.4), additive(0xffb35a, 0.35, TEX.spark), 0, 0.06, 0);
    l.add(halo);
    lamps.push(halo);
  }

  // ---------------------------------------------------------------- running gear
  const FRONT_X = 0.55, REAR_X = 3.55, FRONT_R = 0.72, REAR_R = 0.95, TRACK = 0.96, GROUND = -1.45;

  /** A proper carriage wheel: iron tyre, gilt felloe, dished lacquered spokes, turned nave. */
  function wheel(r, spokes) {
    const w = group();                     // spins about its local y after being stood up
    const g = group(); g.rotation.x = Math.PI / 2; w.add(g);
    const spin = group(); g.add(spin);
    spin.add(mesh(lathe([[r * 0.985, -0.05], [r * 1.03, -0.05], [r * 1.035, 0], [r * 1.03, 0.05], [r * 0.985, 0.05], [r * 0.985, -0.05]], 64), IRON));
    spin.add(mesh(lathe([[r * 0.87, -0.045], [r * 0.985, -0.045], [r * 0.985, 0.045], [r * 0.87, 0.045], [r * 0.87, -0.045]], 64), GOLD));
    // All spokes baked into one geometry: one draw call per wheel, not fourteen.
    const spokeGeo = lathe([[0.03, 0], [0.024, 0.2], [0.019, 0.6], [0.017, 1]], 10);
    const placed = [], m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      // stand the spoke radially, dished slightly toward the inboard side
      q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(Math.cos(a), -0.06, Math.sin(a)).normalize());
      m4.compose(new THREE.Vector3(Math.cos(a) * r * 0.13, 0, Math.sin(a) * r * 0.13), q, new THREE.Vector3(1, r * 0.76, 1));
      placed.push(spokeGeo.clone().applyMatrix4(m4));
    }
    spin.add(new THREE.Mesh(mergeGeometries(placed), LACQUER));
    spin.add(mesh(lathe([
      [0.02, -0.16], [0.07, -0.16], [0.09, -0.12], [0.085, -0.06], [0.13, -0.03], [0.13, 0.03],
      [0.1, 0.06], [0.11, 0.1], [0.085, 0.15], [0.06, 0.2], [0.02, 0.22]
    ], 28), GOLD));
    spin.add(mesh(new THREE.SphereGeometry(0.05, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), GOLD, 0, 0.2, 0));
    return { root: w, spin };
  }
  const wheels = [];
  for (const [x, r, spokes] of [[FRONT_X, FRONT_R, 12], [REAR_X, REAR_R, 14]]) {
    for (const s of [1, -1]) {
      const wh = wheel(r, spokes);
      wh.root.position.set(x, GROUND + r, s * TRACK);
      if (s < 0) wh.root.rotation.y = Math.PI;       // hub cap faces outward on both sides
      rig.add(wh.root);
      wheels.push({ ...wh, r, dir: s });
    }
    rig.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, TRACK * 2 + 0.2, 10), IRON, x, GROUND + r, 0).rotateX(Math.PI / 2));
  }
  // Perch: the curved spine joining the axles, lacquered with gilt ends.
  rig.add(new THREE.Mesh(taperTube(new THREE.CatmullRomCurve3([
    new THREE.Vector3(FRONT_X, GROUND + FRONT_R, 0), new THREE.Vector3(1.0, -0.52, 0),
    new THREE.Vector3(2.1, -0.6, 0), new THREE.Vector3(3.15, -0.52, 0), new THREE.Vector3(REAR_X, GROUND + REAR_R, 0)
  ]), 0.07, 0.07, 60, 12), LACQUER));
  // C-springs, and the leather braces the body hangs from.
  const braces = [];
  const cSpring = (base, tip, lean) => new THREE.CatmullRomCurve3([
    base, base.clone().add(new THREE.Vector3(lean * 0.35, 0.3, 0)),
    base.clone().add(new THREE.Vector3(lean * 0.45, 0.72, 0)), tip
  ]);
  for (const s of [1, -1]) {
    const z = s * 0.42;
    const rearTip = new THREE.Vector3(REAR_X - 0.15, 0.62, z);
    rig.add(new THREE.Mesh(taperTube(cSpring(new THREE.Vector3(REAR_X, GROUND + REAR_R + 0.05, z), rearTip, 1), 0.055, 0.03, 40, 10), LACQUER));
    rig.add(mesh(new THREE.SphereGeometry(0.045, 12, 8), GOLD, rearTip.x, rearTip.y, rearTip.z));
    braces.push({ from: rearTip, to: new THREE.Vector3(BODY_X + 0.78, -0.22, z) });
    const frontTip = new THREE.Vector3(FRONT_X + 0.2, 0.08, z);
    rig.add(new THREE.Mesh(taperTube(cSpring(new THREE.Vector3(FRONT_X, GROUND + FRONT_R + 0.05, z), frontTip, -1), 0.045, 0.026, 40, 10), LACQUER));
    rig.add(mesh(new THREE.SphereGeometry(0.038, 12, 8), GOLD, frontTip.x, frontTip.y, frontTip.z));
    braces.push({ from: frontTip, to: new THREE.Vector3(BODY_X - 0.75, -0.22, z) });
  }
  const braceMeshes = braces.map(() => {
    const m = mesh(new THREE.BoxGeometry(0.018, 1, 0.07), LEATHER);
    rig.add(m);
    return m;
  });

  // Splinter bar and pole.
  rig.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.9, 10), LACQUER, -0.05, -0.62, 0).rotateX(Math.PI / 2));
  [-0.95, 0.95].forEach((z) => rig.add(mesh(new THREE.SphereGeometry(0.04, 10, 8), GOLD, -0.05, -0.62, z)));
  if (!fairy) {
    const poleCurve = new THREE.CatmullRomCurve3([new THREE.Vector3(0.35, -0.64, 0), new THREE.Vector3(-1.4, -0.5, 0), new THREE.Vector3(-3.25, -0.36, 0)]);
    rig.add(new THREE.Mesh(taperTube(poleCurve, 0.045, 0.034, 40, 10), LACQUER));
    rig.add(mesh(lathe([[0, 0], [0.045, 0], [0.05, 0.05], [0.03, 0.1], [0.04, 0.14], [0, 0.2]], 14), GOLD, -3.25, -0.36, 0).rotateZ(Math.PI / 2));
  }

  // ---------------------------------------------------------------- the team
  // Two slots, one each side of the pole. The engine drops the scanned horse
  // into them; until then (or if it never loads) a procedural horse stands in.
  const TEAM_X = fairy ? -2.25 : -2.1, TEAM_Z = 0.62;
  const slots = (fairy ? [0] : [TEAM_Z, -TEAM_Z]).map((z) => {
    const slot = group(TEAM_X, 0, z);
    rig.add(slot);
    return slot;
  });
  let fallback = slots.map((slot) => {
    const h = buildHorse({ coat: MAT.coat, rider: false, scale: 1.1 });
    h.root.position.y = 0.2;
    slot.add(h.root);
    return h;
  });
  // Traces: leather straps from each horse's shoulder back to the bar.
  const traces = [];
  const traceSet = fairy ? [[0, 0.3], [0, -0.3]] : [[0, TEAM_Z + 0.3], [0, TEAM_Z - 0.3], [1, -TEAM_Z + 0.3], [1, -TEAM_Z - 0.3]];
  for (const [si, z] of traceSet) {
    // Gilded traces for the winged horse; plain leather for the state pair.
    const m = mesh(fairy ? new THREE.CylinderGeometry(0.018, 0.018, 1, 8) : new THREE.BoxGeometry(0.014, 1, 0.05), fairy ? GOLD : LEATHER);
    rig.add(m);
    traces.push({ m, slot: si, z, from: new THREE.Vector3(TEAM_X - 0.72, -0.42, z), to: new THREE.Vector3(-0.05, -0.62, z * 0.95 + (z > 0 ? 0.02 : -0.02)) });
  }
  const sky = fairy ? buildCloudBed(rig, GROUND, lowPower, new THREE.Vector3(TEAM_X - 0.9, -0.2, 0.3)) : null;

  const UP = new THREE.Vector3(0, 1, 0), dirV = new THREE.Vector3(), mid = new THREE.Vector3();
  function strap(m, a, b) {
    dirV.subVectors(b, a);
    const len = dirV.length();
    mid.addVectors(a, b).multiplyScalar(0.5);
    m.position.copy(mid);
    m.scale.set(1, len, 1);
    m.quaternion.setFromUnitVectors(UP, dirV.normalize());
  }
  const bob = [new THREE.Vector3(), new THREE.Vector3()];
  const pitchQ = new THREE.Vector3();
  const fromNow = new THREE.Vector3();

  return {
    root,
    slots,
    teamY: 0,
    /** Called by the engine once real horses are in the slots. */
    useTeam(carriers) {
      fallback.forEach((h) => h.root.removeFromParent());
      fallback = null;
      this.carriers = carriers;
    },
    update(t, u, ctx = {}) {
      // Trot: two beats per stride, the pair moving together.
      const beat = t * 6.6;
      if (fallback) fallback.forEach((h) => h.update(t, u, { speed: 6.6, gait: 0.6 }));
      (this.carriers || []).forEach((c, i) => {
        if (fairy && c.userData.pivot) {
          // Rearing: the body pitches up about the hind hooves, rocking as
          // the forelegs paw the air.
          const a = -(0.3 + Math.sin(t * 3.4) * 0.07);
          const pv = c.userData.pivot, k = c.userData.scale ?? 1;
          c.rotation.z = a;
          c.scale.setScalar(k);
          // hooves stay where they stand while the body scales and pitches
          pitchQ.set(pv.x * k, pv.y * k, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), a);
          c.position.x = pv.x - pitchQ.x;
          c.position.y = pv.y - pitchQ.y + Math.sin(t * 3.4) * 0.03;
          c.userData.wings?.forEach((w) => w.update(t));
          bob[i].set(0, 0.18, 0);
          return;
        }
        c.position.y = Math.abs(Math.sin(beat)) * 0.06;
        c.rotation.z = Math.sin(beat * 2 + i * 0.4) * 0.02;
        bob[i].set(0, c.position.y, 0);
      });
      sky?.update(t, u);
      // Wheels roll by the distance covered, in rig units.
      const dist = (ctx.travel ?? t * 2) / (ctx.scale ?? 1);
      wheels.forEach((w) => { w.spin.rotation.y = w.dir * dist / w.r; });
      // The body swings on its braces: a slow roll, a pitch on the trot.
      hang.rotation.x = Math.sin(t * 1.9) * 0.014 + Math.sin(t * 5.3) * 0.004;
      hang.rotation.z = Math.sin(beat * 2) * 0.006;
      hang.position.y = 0.55 + Math.sin(beat * 2 + 0.5) * 0.008;
      braces.forEach((b, i) => {
        // the lower end follows the swaying body
        fromNow.copy(b.to).sub(hang.position); fromNow.applyEuler(hang.rotation); fromNow.add(hang.position);
        strap(braceMeshes[i], b.from, fromNow);
      });
      traces.forEach((tr) => strap(tr.m, fromNow.copy(tr.from).add(bob[tr.slot]), tr.to));
      lamps.forEach((h, i) => { h.material.opacity = 0.3 + Math.sin(t * 9 + i * 2) * 0.03; h.scale.setScalar(1 + Math.sin(t * 7 + i) * 0.05); });
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
      const spin = (ctx.travel ?? t * 3) * 3.6;
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
 * Dust — kicked up where hooves and wheels meet the ground.
 * ------------------------------------------------------------------ */

/**
 * Soft billowing puffs. Unlike the sparkles these are not additive: dust
 * occludes a little and takes the colour of the light, which is what keeps it
 * reading as dirt in the air rather than a glow effect. Puffs are left where
 * they were kicked, so as the ride moves on they trail naturally behind it.
 */
class Dust {
  constructor(count, opts = {}) {
    this.opts = {
      additive: false, color: [0.25, 0.2, 0.15], map: TEX.smoke, size: [0.3, 1.55],
      alpha: 0.17, life: [0.9, 1.7], rise: [0.12, 0.34], flicker: 0, ...opts
    };
    this.wind = 0;
    this.n = count;
    this.cursor = 0;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.age = new Float32Array(count).fill(1);
    this.life = new Float32Array(count).fill(1);
    this.size = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.spin = new Float32Array(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSpin', new THREE.BufferAttribute(this.spin, 1));
    this.uniforms = {
      uMap: { value: this.opts.map },
      uColor: { value: new THREE.Color(...this.opts.color) },
      uScale: { value: 400 }
    };
    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: this.opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute float aSpin;
        uniform float uScale;
        varying float vAlpha; varying float vSpin;
        void main() {
          vAlpha = aAlpha; vSpin = aSpin;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mv.z, 0.1);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform vec3 uColor;
        varying float vAlpha; varying float vSpin;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float s = sin(vSpin), k = cos(vSpin);
          vec2 uv = vec2(c.x * k - c.y * s, c.x * s + c.y * k) + 0.5;
          vec4 t = texture2D(uMap, uv);
          gl_FragColor = vec4(uColor * (0.75 + 0.35 * t.r), t.a * vAlpha);
        }`
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  spawn(at, drift, spread = 0.12) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.n;
    this.pos[i * 3] = at.x + (Math.random() - 0.5) * spread;
    this.pos[i * 3 + 1] = at.y + Math.random() * 0.05;
    this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * spread;
    const o = this.opts;
    this.vel[i * 3] = drift + (Math.random() - 0.5) * 0.35;
    this.vel[i * 3 + 1] = lerp(o.rise[0], o.rise[1], Math.random());
    this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.35;
    this.age[i] = 0;
    this.life[i] = lerp(o.life[0], o.life[1], Math.random());
    this.spin[i] = Math.random() * 6.28;
    this.points.geometry.attributes.aSpin.needsUpdate = true;
  }
  update(dt, strength) {
    const { n, pos, vel, age, life, size, alpha } = this;
    for (let i = 0; i < n; i++) {
      if (age[i] >= life[i]) { alpha[i] = 0; continue; }
      age[i] += dt;
      const k = Math.min(age[i] / life[i], 1);
      const drag = Math.exp(-2.2 * dt);
      vel[i * 3] *= drag; vel[i * 3 + 1] *= drag; vel[i * 3 + 2] *= drag;
      pos[i * 3] += (vel[i * 3] + this.wind) * dt;   // wind: the ground streaming past
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const o = this.opts;
      size[i] = lerp(o.size[0], o.size[1], Math.sqrt(k));   // billows out fast, then slows
      const flick = o.flicker ? 1 - o.flicker + o.flicker * Math.abs(Math.sin(age[i] * 37 + i)) : 1;
      alpha[i] = Math.min(k * 5, 1) * Math.pow(1 - k, 1.8) * o.alpha * strength * flick;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
  clear() { this.age.fill(1); this.alpha.fill(0); }
}

/* ------------------------------------------------------------------ *
 * Scene cards — full-frame backdrops behind a ride
 * ------------------------------------------------------------------ */

/**
 * The golden-hour card from the reference: a low sun behind the rider, cloud
 * banks lit from underneath, three ranges of mountains in atmospheric haze,
 * and a thin bright line under the ground. Everything is procedural (value
 * noise and fbm), so it costs no download and never repeats visibly.
 *
 * The ranges scroll at different speeds with `uScroll`, which is how a horse
 * holding the centre of the frame still reads as galloping hard: the near
 * ridge races past, the far one barely moves. The top edge feathers into the
 * room and the whole card fades with `uAlpha`.
 */
const SUNSET_FRAG = `
  uniform float uT, uScroll, uAlpha, uAspect;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
    return v;
  }
  // Ridged multifractal: sharp crests and gullies, like real ranges.
  float ridge(float x, float base, float amp, float freq, float seed) {
    float v = 0.0, a = 0.55, f = freq;
    for (int i = 0; i < 6; i++) {
      float n = 1.0 - abs(noise(vec2(x * f, seed + float(i) * 7.3)) * 2.0 - 1.0);
      v += a * n * n;
      f *= 2.15; a *= 0.48;
    }
    return base + amp * v;
  }

  void main() {
    vec2 uv = vUv;
    vec2 p = vec2(uv.x * uAspect, uv.y);
    vec2 sun = vec2(0.34 * uAspect, 0.5);
    float horizon = 0.4;

    // Sky: a blinding gold streak at the horizon, ember orange, blood red
    // cloud banks, then deep blue where the card meets the room.
    float h = clamp((uv.y - horizon) / (1.0 - horizon), 0.0, 1.0);
    // Away from the sun the sky is already dusk: wine red over the hills,
    // bruised plum higher up, night blue at the top.
    vec3 sky = mix(vec3(0.34, 0.07, 0.02), vec3(0.08, 0.015, 0.03), smoothstep(0.0, 0.5, h));
    sky = mix(sky, vec3(0.012, 0.018, 0.09), smoothstep(0.5, 1.0, h));

    // The sun: a white-gold core, a gold glow smeared sideways the way a
    // lens smears a low sun, and a broad ember halo.
    vec2 ds = (p - sun) * vec2(0.5, 1.0);
    float d = length(ds);
    sky += vec3(3.0, 2.4, 1.2) * smoothstep(0.05, 0.028, length(p - sun));
    float di = length(p - sun);
    sky += vec3(2.4, 1.5, 0.45) * exp(-d * 12.0);
    sky += vec3(1.4, 0.55, 0.06) * exp(-di * 6.5);
    sky += vec3(0.35, 0.08, 0.008) * exp(-di * 2.6);
    float streak = exp(-abs(uv.y - sun.y + 0.01) * 30.0) * exp(-abs(p.x - sun.x) * 3.2);
    sky += vec3(1.1, 0.55, 0.08) * streak;
    // Crepuscular rays fanning out of the sun.
    float ang = atan(p.y - sun.y, p.x - sun.x);
    float rays = pow(noise(vec2(ang * 9.0, 1.3)), 3.0) * exp(-di * 3.5) * smoothstep(horizon, horizon + 0.12, uv.y);
    sky += vec3(1.0, 0.42, 0.05) * rays * 0.25;

    // Cloud banks: long streaky fbm. Near the sun they are lit gold from
    // below; away from it they are dark wine-red against the glow.
    float cx = uv.x * 1.5 - uScroll * 0.012 + uT * 0.004;
    vec2 cq = vec2(cx, uv.y * 9.0);
    cq += vec2(fbm(cq * 1.7 + 3.1) * 0.9, fbm(cq * 1.3 + 8.4) * 0.6);      // domain warp: torn, wind-drawn shapes
    float c = fbm(cq);
    float band = smoothstep(horizon + 0.05, horizon + 0.13, uv.y) * (1.0 - smoothstep(0.78, 0.96, uv.y));
    float cloud = smoothstep(0.4, 0.62, c) * band;
    float lit = exp(-di * 4.2);
    float under = smoothstep(0.62, 0.4, c);                                  // thin edges catch the light
    vec3 cloudCol = mix(vec3(0.07, 0.01, 0.014), vec3(0.9, 0.3, 0.04), lit * 0.8);
    cloudCol += vec3(2.2, 1.0, 0.18) * under * lit;
    cloudCol += vec3(0.25, 0.05, 0.01) * under * (1.0 - lit) * (1.0 - h);   // ember rim far from the sun
    sky = mix(sky, cloudCol, cloud * 0.92);

    vec3 col = sky;

    // Three ranges, far to near. Far ones take the sky colour (aerial haze).
    float x = uv.x;
    float sx1 = x - uScroll * 0.006, sx2 = x - uScroll * 0.016, sx3 = x - uScroll * 0.045;
    float r1 = ridge(sx1, 0.33, 0.1, 1.7, 3.0);
    float r2 = ridge(sx2, 0.27, 0.11, 2.4, 11.0);
    float r3 = ridge(sx3, 0.18, 0.1, 3.4, 23.0);
    float sunSide = exp(-abs(x - 0.34) * 2.2);
    vec3 haze = mix(vec3(0.95, 0.34, 0.05), vec3(0.22, 0.06, 0.09), smoothstep(0.0, 0.4, abs(x - 0.34)));
    if (uv.y < r1) {
      float rock = fbm(vec2(sx1 * 30.0, uv.y * 24.0));
      col = mix(vec3(0.09, 0.03, 0.05), haze, 0.42 - (r1 - uv.y) * 1.5);
      col *= 0.8 + 0.4 * rock;
      col += vec3(0.9, 0.3, 0.04) * exp(-(r1 - uv.y) * 40.0) * sunSide * 0.3;
    }
    if (uv.y < r2) {
      float rock = fbm(vec2(sx2 * 34.0, uv.y * 30.0));
      col = mix(vec3(0.02, 0.008, 0.01), haze, 0.08 - (r2 - uv.y) * 0.3);
      col *= 0.7 + 0.6 * rock;
      col += vec3(1.1, 0.36, 0.05) * exp(-(r2 - uv.y) * 70.0) * sunSide * 0.22;
    }
    if (uv.y < r3) {
      float rock = fbm(vec2(sx3 * 45.0, uv.y * 50.0));
      col = vec3(0.012, 0.007, 0.006) * (0.6 + 0.9 * rock);
      col += vec3(1.2, 0.4, 0.05) * exp(-(r3 - uv.y) * 90.0) * sunSide * 0.18;
      float g = fbm(vec2(sx3 * 60.0, uv.y * 90.0));
      col += vec3(0.05, 0.02, 0.006) * g * smoothstep(0.05, r3, uv.y);
    }

    // The low sun washing over everything near the horizon.
    float band2 = exp(-abs(uv.y - horizon - 0.03) * 9.0);
    col += vec3(1.5, 0.75, 0.12) * band2 * exp(-abs(x - 0.34) * 1.4) * 0.6 * step(r1, uv.y + 0.02);
    col += vec3(0.8, 0.3, 0.04) * exp(-abs(uv.y - horizon) * 10.0) * exp(-abs(x - 0.34) * 1.8) * 0.3;

    // The bright line under the ground, with a glint running along it.
    float lineY = 0.105;
    float line = exp(-abs(uv.y - lineY) * 420.0) * 1.6 + exp(-abs(uv.y - lineY) * 60.0) * 0.25;
    float glint = exp(-pow((uv.x - fract(uT * 0.22)) * 6.0, 2.0));
    col += vec3(0.75, 0.85, 1.6) * line * (0.7 + glint);

    // Feather into the room: soft at the top, quick below the line.
    float a = smoothstep(1.0, 0.8, uv.y) * smoothstep(lineY - 0.05, lineY + 0.005, uv.y);
    a = max(a, line * 0.9);
    float alpha = clamp(a, 0.0, 1.0) * uAlpha;
    gl_FragColor = vec4(col * alpha, alpha);
  }
`;

function buildBackdrop() {
  const uniforms = {
    uT: { value: 0 }, uScroll: { value: 0 }, uAlpha: { value: 0 }, uAspect: { value: 1.2 }
  };
  // Opaque pass, drawn first, writing premultiplied colour. As a transparent
  // object it would be drawn after the rider and paint straight over him.
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms,
    transparent: false,
    depthTest: false,
    depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }',
    fragmentShader: SUNSET_FRAG
  }));
  quad.frustumCulled = false;
  quad.renderOrder = -100;               // drawn first, everything else over it
  quad.visible = false;
  return { quad, uniforms };
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

const ENGINE = { lowPower: false };

const ENTRIES = {
  horse: {
    label: 'Horse rider',
    photoreal: true,
    // As in the reference: a golden-hour card behind the rider; the horse
    // runs in from the right, then holds the centre at full gallop while the
    // land streams past, and the whole scene fades together.
    backdrop: 'sunset',
    fadeCanvas: true,
    fade: [0.1, 0.86],
    lights: {
      key: [0xffb878, 0.95], keyOffset: [-4.5, 2.2, 6],
      rim: [0xff8a30, 7.5, [-2.2, 1.6, -7]],        // the low sun, behind the rider
      sky: 0.16, env: 0.42
    },
    accent: 0xffa845,
    trail: { color: 0xff8a1e, width: 0.12, span: 0.09 },
    scale: 1.34, y: -0.4,
    build: () => buildHorse({ coat: MAT.coatWarm, rider: true }),
    // assets/models/horse.glb faces +z, so a quarter turn puts it on the path.
    model: {
      rotationY: -Math.PI / 2, length: 3.3, groundY: -1.45,
      // Measured off the mesh: belly line, hip positions and the clean gap
      // between fore and hind legs, all in the model's own +z-forward space.
      gallop: {
        belly: -0.64, legLength: 0.36, split: 0.10,
        frontHipZ: 0.38, hindHipZ: -0.18, tailZ: -0.50, midX: 0.068,
        speed: 9.0, swing: 0.95
      },
      banner: { x: 0.66, y: -0.05, z: 0.16, tilt: 0.14, scale: 0.8 },
      // The rider's volume in model space: armour classification is limited
      // to it so the horse's pale markings stay hair.
      surface: { rider: { minZ: -0.28, maxZ: 0.44, minY: -0.66 } }
    },
    pool: 0xffa23c,
    dust: { rate: 18, wind: 2.6, points: [[-0.72, -1.42, 0.02], [-0.72, -1.42, 0.24], [0.34, -1.42, 0.02], [0.34, -1.42, 0.24]] },
    embers: { rate: 38, points: [[0.3, -1.4, 0.1], [0.45, -1.35, 0.25], [-0.7, -1.4, 0.15]], glow: [0.55, -1.25, 0.3] },
    path(u) {
      const k = easeOut(clamp(u / 0.24, 0, 1));
      return {
        x: lerp(6.2, -0.35, k), y: 0, z: 0.35,
        ry: lerp(-0.2, -0.3, k),
        rz: 0,
        // the land keeps streaming past after the horse settles
        travel: u * 44
      };
    }
  },
  carriage: {
    label: 'Royal rath',
    photoreal: true,
    // As in the reference: a golden coach drawn by a single white winged
    // horse, rearing, riding a luminous cloud bank. It glides in from the
    // right as it fades up, holds centre stage, flashes, and fades away.
    fadeCanvas: true,
    fade: [0.16, 0.86],
    lights: {
      key: [0xfff1e0, 1.25], keyOffset: [3.5, 4.5, 6],
      rim: [0xd9c2ff, 5.5, [-2.5, 2.5, -6]],
      sky: 0.35, env: 0.9
    },
    accent: 0xe0a6ff,
    trail: { color: 0xc98bff, width: 0.14, span: 0.08 },
    scale: 0.72, y: -0.5,
    contact: [0, 0],
    build: () => buildStateCoach({ lowPower: ENGINE.lowPower, fairy: true }),
    pool: 0xd79bff,
    // The scanned horse, rider cut away, white with a golden mane and tail,
    // given a pair of feathered wings and rearing in the traces.
    team: {
      model: 'horse',
      rear: true,
      wings: { at: [0.068, -0.2, 0.2], span: 1.25 },
      scale: 1.2,
      surface: { rider: { minZ: -0.28, maxZ: 0.44, minY: -0.66 }, tint: 'white', mane: 'gold', steel: 'gold', noRider: { torso: [-0.12, 0.25, -0.1], legs: [-0.12, 0.36, -0.66] } },
      gallop: {
        belly: -0.64, legLength: 0.36, split: 0.10,
        frontHipZ: 0.38, hindHipZ: -0.18, tailZ: -0.50, midX: 0.068,
        speed: 3.4, swing: 0.3, phases: [0.0, 1.2, 0.0, 0.4], rear: true
      }
    },
    path(u) {
      const k = easeOut(clamp(u / 0.3, 0, 1));
      const x = lerp(2.6, -0.2, k) - Math.max(0, u - 0.3) * 0.6;
      return { x, y: Math.sin(u * 5.2) * 0.04, z: 0.2, ry: -0.16, rz: 0, travel: (2.6 - x) * 2.2 + u * 6 };
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
  ENGINE.lowPower = lowPower;
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
  const studioEnv = pmrem.fromScene(buildStudioEnvScene(), 0.015).texture;
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

  const dust = new Dust(lowPower ? 90 : 200);
  stage.add(dust.points);
  const dustAt = new THREE.Vector3();
  // Embers flicking off the hooves, as in the reference card.
  const embers = new Dust(lowPower ? 60 : 140, {
    additive: true, color: [3.2, 1.25, 0.32], map: TEX.spark, size: [0.09, 0.02],
    alpha: 0.95, life: [0.35, 0.9], rise: [0.25, 1.0], flicker: 0.6
  });
  stage.add(embers.points);
  const hoofGlow = mesh(new THREE.PlaneGeometry(1.6, 0.9), additive(0xff8a2a, 0, TEX.spark));
  hoofGlow.renderOrder = 6;
  stage.add(hoofGlow);
  const backdrop = buildBackdrop();
  scene.add(backdrop.quad);

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
  // UnrealBloomPass blends its result with additive blending, whose alpha
  // term is srcAlpha * srcAlpha + dstAlpha. The bloom target's alpha is 1
  // everywhere, so every transparent pixel of the frame came out fully
  // opaque and the ride sat in a black box over the room. Add light, not
  // opacity: RGB still adds, and alpha rises only by how bright the bloom
  // actually is at that pixel, which is what lets a glow spill over the page.
  bloom.blendMaterial.transparent = true;
  bloom.blendMaterial.blending = THREE.CustomBlending;
  bloom.blendMaterial.blendEquation = THREE.AddEquation;
  bloom.blendMaterial.blendSrc = THREE.OneFactor;
  bloom.blendMaterial.blendDst = THREE.OneFactor;
  bloom.blendMaterial.blendSrcAlpha = THREE.OneFactor;
  bloom.blendMaterial.blendDstAlpha = THREE.OneFactor;
  bloom.blendMaterial.fragmentShader = `
    uniform float opacity;
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv) * opacity;
      gl_FragColor = vec4(c.rgb, dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)));
    }`;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /*
   * Two looks share one stage. The stylised rides (bike, dragon) are built for
   * a warm, dim key, ACES and a generous bloom. The photoreal ones need the
   * opposite: a filmic curve that rolls highlights off instead of clipping
   * them pink, reflections of a real sky, and almost no bloom — a glow around
   * a white horse is the single strongest "this is a cartoon" cue there is.
   * Everything decorative that reads as a game effect is dialled right down.
   */
  const LOOKS = {
    stylised: {
      toneMapping: THREE.ACESFilmicToneMapping, exposure: 0.78, env,
      bloom: [lowPower ? 0.28 : 0.42, 0.5, 0.9],
      key: [0xfff0d0, 1.55], keyOffset: [-3.4, 5, 5], rim: [0x8fb4ff, 1.25],
      hero: 4, under: 1, sky: 0.45, pool: 1, fx: 1, rays: 1, trail: true, dust: false, shadowSpan: 3.6
    },
    photoreal: {
      toneMapping: THREE.NeutralToneMapping, exposure: 1.0, env: studioEnv,
      bloom: [0.1, 0.3, 0.97],
      key: [0xffe0bc, 3.0], keyOffset: [-4.2, 3.6, 5.4], rim: [0xa9c6ff, 2.6],
      hero: 0, under: 0, sky: 0.28, pool: 0.22, fx: 0, rays: 0.45, trail: false, dust: true, shadowSpan: 5.4
    }
  };
  let look = LOOKS.stylised;
  function applyLook(name) {
    look = LOOKS[name] || LOOKS.stylised;
    renderer.toneMapping = look.toneMapping;
    renderer.toneMappingExposure = look.exposure;
    scene.environment = look.env;
    scene.environmentIntensity = 1;
    [bloom.strength, bloom.radius, bloom.threshold] = look.bloom;
    key.color.setHex(look.key[0]); key.intensity = look.key[1];
    rim.color.setHex(look.rim[0]); rim.intensity = look.rim[1];
    sky.intensity = look.sky;
    if (shadows) {
      const sc = key.shadow.camera, span = look.shadowSpan;
      sc.left = -span; sc.right = span; sc.top = span * 0.9; sc.bottom = -span * 0.9;
      sc.updateProjectionMatrix();
    }
  }

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
   * Stack several onBeforeCompile edits on one material.
   *
   * three.js caches programs by the source of onBeforeCompile, and every
   * material here would share the same composing arrow function — so without
   * an explicit cache key a tinted horse would silently reuse the untinted
   * horse's program. Each patch carries a key describing its parameters.
   */
  function addShaderPatch(material, key, fn) {
    const list = material.userData.patches || (material.userData.patches = []);
    list.push({ key, fn });
    material.onBeforeCompile = (shader, r) => list.forEach((p) => p.fn(shader, r));
    material.customProgramCacheKey = () => list.map((p) => p.key).join('|');
    material.needsUpdate = true;
  }

  /**
   * Relief from the albedo.
   *
   * Scanned and generated models ship a single colour texture with the
   * lighting of the scan baked in: crevices are darker. Read as a height field
   * that is a good-enough relief map, and a normal map built from it gives the
   * armour its engraving and the coat its muscle and hair without any extra
   * download. Built once at load, at 1024 or 512 depending on the device.
   */
  function detailNormalFromMap(map, size, strength) {
    const img = map && map.image;
    if (!img || !img.width) return null;
    const w = Math.min(size, img.width);
    const h = Math.max(1, Math.round(w * img.height / img.width));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const src = g.getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      lum[i] = (src[i * 4] * 0.2126 + src[i * 4 + 1] * 0.7152 + src[i * 4 + 2] * 0.0722) / 255;
    }
    const at = (x, y) => lum[((y + h) % h) * w + ((x + w) % w)];
    const out = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Sobel, so single-pixel noise in the texture does not read as grit.
        const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
                 - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
        const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
                 - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
        const nx = -dx * strength, ny = -dy * strength;
        const inv = 1 / Math.hypot(nx, ny, 1);
        const i = (y * w + x) * 4;
        out.data[i] = (nx * inv * 0.5 + 0.5) * 255;
        out.data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
        out.data[i + 2] = (inv * 0.5 + 0.5) * 255;
        out.data[i + 3] = 255;
      }
    }
    g.putImageData(out, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = map.flipY;             // glTF textures are not flipped; match the albedo
    tex.wrapS = map.wrapS;
    tex.wrapT = map.wrapT;
    tex.channel = map.channel;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  /**
   * Split one baked texture into real materials.
   *
   * The imported knight-and-horse is a single material with a single colour
   * texture, so the plate armour renders exactly like the horse's coat: matte,
   * the colour of plaster. Real surfaces differ mostly in how they reflect,
   * so the fragment shader classifies each texel by what it looks like and
   * where it sits on the model:
   *   steel   grey, and inside the rider's volume -> fully metallic, polished
   *   coat    saturated and mid-bright            -> satin hair, deeper chestnut
   *   leather dark                                 -> saddle, bridle, mane
   * `tint: 'white'` turns the coat into a grey-white horse for the carriage
   * team, with a silvered mane and tail.
   *
   * `rider` is the rider's bounding box in the model's own space, so a white
   * blaze on the horse's face never gets mistaken for armour.
   */
  function applyRealisticSurface(model, opts) {
    const r = opts.rider;
    const white = opts.tint === 'white';
    const cut = opts.noRider;               // model-space height above which the rider is cut away
    const gold = opts.mane === 'gold';
    const gildTack = opts.steel === 'gold';
    const key = `surface:${JSON.stringify(opts)}`;
    const vDecl = 'varying vec3 vRestPos;';
    const frag = `
      {
        vec3 c = diffuseColor.rgb;
        float mx = max(c.r, max(c.g, c.b));
        float mn = min(c.r, min(c.g, c.b));
        float sat = mx > 1e-4 ? (mx - mn) / mx : 0.0;
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));

        vec3 p = vRestPos;
        float inRider =
            smoothstep(${(r.minZ - 0.04).toFixed(3)}, ${r.minZ.toFixed(3)}, p.z)
          * (1.0 - smoothstep(${r.maxZ.toFixed(3)}, ${(r.maxZ + 0.04).toFixed(3)}, p.z))
          * smoothstep(${(r.minY - 0.04).toFixed(3)}, ${r.minY.toFixed(3)}, p.y);

        ${cut != null ? `{
          // Measured off the mesh: above the saddle, between cantle and
          // withers, everything is rider; lower down, along the flank, only
          // the grey of the armoured legs is, so the horse itself survives.
          float steelLike = (1.0 - smoothstep(0.12, 0.30, sat)) * smoothstep(0.03, 0.10, lum);
          bool torso = p.z > ${cut.torso[0].toFixed(3)} && p.z < ${cut.torso[1].toFixed(3)} && p.y > ${cut.torso[2].toFixed(3)};
          bool legs = p.z > ${cut.legs[0].toFixed(3)} && p.z < ${cut.legs[1].toFixed(3)} && p.y > ${cut.legs[2].toFixed(3)} && steelLike > 0.5;
          // Nothing of the horse stands higher than its ears (y 0.15); the
          // raised sword does, well forward of the torso.
          if (torso || legs || p.y > 0.2) discard;
        }` : ''}
        float steel = (1.0 - smoothstep(0.12, 0.30, sat)) * smoothstep(0.03, 0.10, lum) * inRider${cut != null && !gildTack ? ' * 0.0' : ''};
        float dark  = (1.0 - smoothstep(0.03, 0.075, lum)) * (1.0 - steel);
        float coat  = clamp(1.0 - steel - dark, 0.0, 1.0);

        // Steel: bring the grey up to real steel reflectance, keep the
        // texture's engraving and wear as variation, polish the plate.
        ${gildTack
          ? `vec3 steelCol = vec3(0.86, 0.62, 0.22) * clamp(0.6 + lum * 1.5, 0.5, 1.2);
             float steelRough = 0.24 + (1.0 - smoothstep(0.08, 0.4, lum)) * 0.16;`
          : `vec3 steelCol = vec3(0.60, 0.61, 0.64) * clamp(0.55 + lum * 1.6, 0.45, 1.15);
             float steelRough = 0.2 + (1.0 - smoothstep(0.08, 0.4, lum)) * 0.22;`}

        // Coat.
        ${white
          ? `float hair = clamp(0.78 + lum * 1.2, 0.74, 1.2);
             vec3 coatCol = vec3(0.94, 0.93, 0.92) * hair;
             float coatRough = 0.56;`
          : `vec3 coatCol = c * vec3(0.84, 0.70, 0.60);
             float coatRough = 0.46;`}

        // Leather and hair that is darker than the coat.
        vec3 darkCol = ${white ? 'coatCol * 0.9' : 'c * 0.92'};
        ${white
          ? `float maneZone = max(step(0.42, p.z) * step(-0.36, p.y), step(p.z, -0.45));
             darkCol = mix(darkCol, vec3(0.52, 0.52, 0.53) * clamp(0.6 + lum * 6.0, 0.5, 1.1), maneZone);
`
          : ''}
        float darkRough = 0.5;

        diffuseColor.rgb = steelCol * steel + coatCol * coat + darkCol * dark;
        metalnessFactor = steel * 0.96;
        roughnessFactor = steelRough * steel + coatRough * coat + darkRough * dark;
        ${gold ? `{
          // Mane and forelock are the dark hair along the crest; the tail is
          // the whole switch behind the rump. Both become spun gold.
          float m = max(step(0.40, p.z) * step(-0.34, p.y) * dark, step(p.z, -0.44)) * (1.0 - steel);
          vec3 goldHair = vec3(1.0, 0.72, 0.26) * clamp(0.5 + lum * 1.8, 0.45, 1.35);
          diffuseColor.rgb = mix(diffuseColor.rgb, goldHair, m);
          roughnessFactor = mix(roughnessFactor, 0.4, m);
          // Harness: saddle, girth, breastcollar and bridle are the dark
          // texels over the barrel and the head — gilded, like the reference.
          float tack = dark * max(
            step(-0.25, p.z) * step(p.z, 0.45) * step(-0.46, p.y),
            step(0.58, p.z));
          tack = clamp(tack * 1.6, 0.0, 1.0) * (1.0 - m);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.64, 0.2), tack);
          metalnessFactor = max(metalnessFactor, tack * 0.9);
          roughnessFactor = mix(roughnessFactor, 0.28, tack);
        }` : ''}
      }
    `;
    model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        // Several meshes can share one material; patch it once.
        if (!m || !m.isMeshStandardMaterial || m.userData.surface) return;
        m.userData.surface = true;
        if (!m.normalMap && m.map) {
          const n = detailNormalFromMap(m.map, lowPower ? 512 : 1024, 2.4);
          if (n) { m.normalMap = n; m.normalScale.set(0.7, 0.7); }
        }
        m.envMapIntensity = 1;
        if (cut != null) m.side = THREE.DoubleSide;     // the cut leaves openings; show the far wall, not nothing
        addShaderPatch(m, key, (shader) => {
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', `#include <common>\n${vDecl}`)
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n vRestPos = position;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\n${vDecl}`)
            .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${frag}`);
        });
      });
    });
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
      `const float MIDX   = ${(g.midX ?? 0).toFixed(3)};`,
      ...(() => {
        // [fore, left of midline] [fore, right] [hind, left] [hind, right]
        const [fl, fr, hl, hr] = g.phases || [3.05, 0.0, 0.75, 4.30];
        return [`const float PFL = ${fl.toFixed(3)};`, `const float PFR = ${fr.toFixed(3)};`,
                `const float PHL = ${hl.toFixed(3)};`, `const float PHR = ${hr.toFixed(3)};`];
      })(),
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
      '// Rearing: forelegs raised and folded, pawing; hind legs planted.',
      'vec2 rearFore(float phase, float w) {',
      '  float a = uT * SPEED + phase;',
      '  float kneeW = clamp((w - 0.4) / 0.6, 0.0, 1.0);',
      '  return vec2((-1.45 + sin(a) * SWING) * min(w * 1.8, 1.0), (1.85 + sin(a - 0.8) * 0.3) * kneeW);',
      '}',
      'vec2 rearHind(float phase, float w) {',
      '  float a = uT * SPEED + phase;',
      '  return vec2((-0.28 + sin(a) * 0.05) * w, 0.12 * clamp((w - 0.45) / 0.55, 0.0, 1.0));',
      '}',
      `#define REAR ${g.rear ? 1 : 0}`,
      '',
      '// The animal\'s midline is MIDX, measured off the leg clusters: a rider\'s',
      '// outstretched arm shifts the bounding box, so x = 0 is not the middle.',
      '// Blend between the four legs instead of branching between them. A hard',
      '// left/right test tears every triangle that crosses the midline, because',
      '// the two sides are half a stride apart; blending keeps the chest, belly',
      '// and rump continuous, and the weight is faded out along the centre line',
      '// so the body itself barely moves.',
      'void gallopFor(vec3 rest, out vec2 ang, out float hipZ) {',
      '  float w = clamp((BELLY - rest.y) / LEGLEN, 0.0, 1.0);',
      '  w = w * w * (3.0 - 2.0 * w);',
      '  float sx = rest.x - MIDX;',
      '  w *= smoothstep(0.004, 0.024, abs(sx));',
      '  float side = smoothstep(-0.02, 0.02, sx);',
      '  float fore = smoothstep(SPLIT - 0.09, SPLIT + 0.09, rest.z);',
      '#if REAR',
      '  vec2 front = mix(rearFore(PFL, w), rearFore(PFR, w), side);',
      '  vec2 hind  = mix(rearHind(PHL, w), rearHind(PHR, w), side);',
      '#else',
      '  vec2 front = mix(legAngles(PFL, w), legAngles(PFR, w), side);',
      '  vec2 hind  = mix(legAngles(PHL, w), legAngles(PHR, w), side);',
      '#endif',
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

    const key = `gallop:${JSON.stringify(g)}`;
    model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m || m.userData.gallop) return;
        m.userData.gallop = true;
        addShaderPatch(m, key, (shader) => inject(shader, true));
      });
      // The shadow pass renders with its own depth material, which would
      // otherwise cast the rest pose while the visible mesh gallops.
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      depth.onBeforeCompile = (shader) => inject(shader, false);
      depth.customProgramCacheKey = () => `depth-${key}`;
      o.customDepthMaterial = depth;
    });
    return time;
  }

  /**
   * A knight's swallowtail guidon on a lance.
   *
   * What makes cloth read as cloth: velvet's soft sheen at grazing angles
   * (MeshPhysicalMaterial.sheen exists for exactly this), metallic gold
   * embroidery that catches the light differently from the pile, folds that
   * travel from the hoist to the fly, and the flag streaming BEHIND the rider —
   * a banner on a galloping horse cannot point forward.
   */
  function buildBanner(spec) {
    const W = 0.78, H = 0.46;
    const root = group(spec.x, spec.y, spec.z);
    root.scale.setScalar(spec.scale ?? 1);
    const lean = group();
    lean.rotation.z = -(spec.tilt ?? 0.18);          // top leans back, away from travel
    root.add(lean);

    // Lance: dark ash shaft, gilt ferrules, a leaf-bladed steel head.
    const wood = new THREE.MeshStandardMaterial({ color: 0x3a2518, roughness: 0.55, metalness: 0.05, ...{
      roughnessMap: TEX.grainRough, normalMap: TEX.grainNormal, normalScale: new THREE.Vector2(0.3, 0.3) } });
    lean.add(mesh(new THREE.CylinderGeometry(0.024, 0.03, 1.9, 12), wood, 0, 0.5, 0));
    [1.36, 1.02, -0.3].forEach((y) => lean.add(mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.05, 14), MAT.gold, 0, y, 0)));
    const blade = new THREE.LatheGeometry([
      new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.03, 0.0), new THREE.Vector2(0.034, 0.04),
      new THREE.Vector2(0.022, 0.07), new THREE.Vector2(0.05, 0.14), new THREE.Vector2(0.046, 0.22),
      new THREE.Vector2(0.02, 0.32), new THREE.Vector2(0.0, 0.38)
    ], 14);
    const head = mesh(blade, MAT.silver, 0, 1.45, 0);
    head.scale.set(1, 1, 0.42);                     // a flat blade, not a cone
    lean.add(head);

    // Cloth texture: crimson velvet, gold border and fringe, a crowned device.
    const art = document.createElement('canvas');
    art.width = 512; art.height = 300;
    const orm = document.createElement('canvas');
    orm.width = 512; orm.height = 300;
    const g = art.getContext('2d'), o = orm.getContext('2d');
    const outline = (ctx) => {
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(512, 0); ctx.lineTo(372, 150); ctx.lineTo(512, 300); ctx.lineTo(0, 300);
      ctx.closePath();
    };
    // velvet pile: deep crimson with a faint nap
    const vel = g.createLinearGradient(0, 0, 0, 300);
    vel.addColorStop(0, '#7a0f22'); vel.addColorStop(0.5, '#8e1328'); vel.addColorStop(1, '#6a0c1d');
    outline(g); g.fillStyle = vel; g.fill();
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,120,140' : '30,0,6'},${Math.random() * 0.05})`;
      g.fillRect(Math.random() * 512, Math.random() * 300, 2, 2);
    }
    o.fillStyle = 'rgb(0,220,0)'; o.fillRect(0, 0, 512, 300);   // G = roughness, B = metalness
    const gold = (ctx, isOrm) => { ctx.strokeStyle = ctx.fillStyle = isOrm ? 'rgb(0,90,255)' : '#e2b24a'; };
    for (const [ctx, isOrm] of [[g, false], [o, true]]) {
      gold(ctx, isOrm);
      ctx.save(); outline(ctx); ctx.clip();
      ctx.lineWidth = 10; outline(ctx); ctx.stroke();            // border
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(22, 22); ctx.lineTo(470, 22); ctx.lineTo(346, 150); ctx.lineTo(470, 278); ctx.lineTo(22, 278); ctx.closePath(); ctx.stroke();
      // crown: band, five points, orbs, and a cross on the centre point
      const cx = 150, cy = 165;
      ctx.beginPath();
      ctx.moveTo(cx - 70, cy + 30); ctx.lineTo(cx - 70, cy - 10); ctx.lineTo(cx - 44, cy + 8);
      ctx.lineTo(cx - 24, cy - 34); ctx.lineTo(cx, cy + 2); ctx.lineTo(cx + 24, cy - 34);
      ctx.lineTo(cx + 44, cy + 8); ctx.lineTo(cx + 70, cy - 10); ctx.lineTo(cx + 70, cy + 30);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(cx - 76, cy + 30, 152, 16);
      [[-70, -10], [-24, -34], [24, -34], [70, -10]].forEach(([dx, dy]) => { ctx.beginPath(); ctx.arc(cx + dx, cy + dy - 6, 7, 0, 7); ctx.fill(); });
      ctx.fillRect(cx - 3, cy - 62, 6, 34); ctx.fillRect(cx - 11, cy - 52, 22, 6);
      ctx.restore();
    }
    // jewels on the band and a gold fringe on the hoist-free edges
    [['#1c3fb0', -44], ['#c01030', 0], ['#138a4a', 44]].forEach(([col, dx]) => {
      g.fillStyle = col; g.beginPath(); g.arc(150 + dx, 203, 6, 0, 7); g.fill();
    });
    const fringe = (ctx, isOrm) => {
      ctx.fillStyle = isOrm ? 'rgb(0,110,255)' : '#caa04a';
      for (let x = 20; x < 360; x += 7) ctx.fillRect(x, 288, 3, 12);
    };
    fringe(g, false); fringe(o, true);

    const map = new THREE.CanvasTexture(art);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    const ormTex = new THREE.CanvasTexture(orm);
    // Alpha comes from the outline, so the swallowtail notch is a real cut.
    const alpha = document.createElement('canvas');
    alpha.width = 512; alpha.height = 300;
    const a = alpha.getContext('2d'); a.fillStyle = '#000'; a.fillRect(0, 0, 512, 300);
    outline(a); a.fillStyle = '#fff'; a.fill();
    a.fillRect(20, 290, 340, 10);
    const alphaTex = new THREE.CanvasTexture(alpha);

    const cloth = new THREE.PlaneGeometry(W, H, 22, 10);
    cloth.translate(W / 2, 0, 0);                  // hoist at the lance, fly trailing behind
    const rest = cloth.attributes.position.array.slice();
    const flag = new THREE.Mesh(cloth, new THREE.MeshPhysicalMaterial({
      map, roughnessMap: ormTex, metalnessMap: ormTex, alphaMap: alphaTex,
      roughness: 1, metalness: 1, alphaTest: 0.5, side: THREE.DoubleSide,
      sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color(0xff5a70)
    }));
    flag.position.set(0.03, 1.08, 0);
    flag.castShadow = true;
    lean.add(flag);

    // Two gold tassels on cords from the lance head.
    const tassels = [-1, 1].map((side) => {
      const t = group(0, 1.33, side * 0.02);
      t.add(mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.16, 5), MAT.gold, 0, -0.08, 0));
      t.add(mesh(new THREE.LatheGeometry([
        new THREE.Vector2(0.0, 0.0), new THREE.Vector2(0.022, -0.01), new THREE.Vector2(0.018, -0.04),
        new THREE.Vector2(0.03, -0.1), new THREE.Vector2(0.0, -0.11)], 10), MAT.goldDeep, 0, -0.16, 0));
      lean.add(t);
      return t;
    });

    return {
      root,
      update(t) {
        const p = cloth.attributes.position;
        for (let i = 0; i < p.count; i++) {
          const x = rest[i * 3], y = rest[i * 3 + 1];
          const k = x / W;                          // 0 at the hoist, 1 at the fly
          // Two travelling waves plus a little droop and lift at the fly.
          const wave = Math.sin(k * 7.5 - t * 11) * 0.075 + Math.sin(k * 15 - t * 17 + y * 6) * 0.02;
          p.setXYZ(i,
            x - k * k * 0.04 * (1 + Math.sin(t * 5)),
            y - k * k * 0.05 + Math.sin(k * 4 - t * 6) * 0.02 * k,
            wave * k * (0.6 + 0.4 * k));
        }
        p.needsUpdate = true;
        cloth.computeVertexNormals();
        lean.rotation.z = -(spec.tilt ?? 0.18) + Math.sin(t * 3.1) * 0.03;
        tassels.forEach((tt, i) => { tt.rotation.z = 0.5 + Math.sin(t * 9 + i) * 0.25; tt.rotation.x = Math.sin(t * 7 + i * 2) * 0.2; });
      }
    };
  }

  /**
   * An ostrich-feather plume for a harness horse's head.
   *
   * Each feather is a narrow strip bent into an arc, textured with a fluffy
   * barbed feather drawn once on a canvas; at this size that reads as plumage,
   * where a tube would read as a noodle.
   */
  let featherTex = null;
  function buildPlume(color = 0xa3172e) {
    if (!featherTex) {
      const c = document.createElement('canvas'); c.width = 64; c.height = 256;
      const g = c.getContext('2d');
      g.clearRect(0, 0, 64, 256);
      g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(32, 256); g.lineTo(32, 6); g.stroke();       // shaft
      for (let y = 250; y > 8; y -= 2.2) {                                  // barbs, longest mid-way
        const k = 1 - Math.abs((y - 120) / 130);
        const len = 6 + 24 * Math.max(0, k) + Math.random() * 4;
        for (const dir of [-1, 1]) {
          g.strokeStyle = `rgba(255,255,255,${0.35 + Math.random() * 0.4})`;
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(32, y);
          g.quadraticCurveTo(32 + dir * len * 0.6, y - 4, 32 + dir * len, y - 10 - Math.random() * 6);
          g.stroke();
        }
      }
      featherTex = new THREE.CanvasTexture(c);
    }
    const mat = new THREE.MeshStandardMaterial({
      color, alphaMap: featherTex, alphaTest: 0.2, side: THREE.DoubleSide, roughness: 0.9, metalness: 0
    });
    const root = group();
    root.add(mesh(lathe([[0, 0], [0.03, 0], [0.036, 0.03], [0.022, 0.05], [0.03, 0.08], [0, 0.09]], 12), MAT.gold));
    const feathers = [];
    for (let i = 0; i < 5; i++) {
      const geo = new THREE.PlaneGeometry(0.16, 0.6, 1, 12);
      const pos = geo.attributes.position;
      for (let v = 0; v < pos.count; v++) {
        const y = pos.getY(v) + 0.3;                 // 0 at the root, 0.6 at the tip
        const k = y / 0.6;
        pos.setXYZ(v, pos.getX(v) * (0.5 + 0.7 * Math.sin(Math.PI * Math.min(k * 1.1, 1))), y * 0.9, -k * k * 0.32);
      }
      geo.computeVertexNormals();
      const f = new THREE.Mesh(geo, mat);
      f.position.y = 0.07;
      f.rotation.y = Math.PI / 2 + (i - 2) * 0.35;    // arc back over the neck, fanned
      f.rotation.x = (i - 2) * 0.05;
      root.add(f);
      feathers.push(f);
    }
    return {
      root,
      update(t) { feathers.forEach((f, i) => { f.rotation.z = Math.sin(t * 6.6 + i * 0.7) * 0.08; }); }
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
  // One download per model file; every use gets its own instance.
  const gltfCache = new Map();
  function loadGLTF(file) {
    if (!gltfCache.has(file)) {
      gltfCache.set(file, (async () => {
        const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
          import('./vendor/three/loaders/GLTFLoader.js'),
          import('./vendor/three/libs/meshopt_decoder.module.js')
        ]);
        const loader = new GLTFLoader();
        loader.setMeshoptDecoder(MeshoptDecoder);
        return loader.loadAsync(`assets/models/${file}.glb`);
      })());
    }
    return gltfCache.get(file);
  }

  /**
   * A fresh copy of a loaded model. Geometry and textures are shared; the
   * materials are cloned so each use can carry its own shader patches (a
   * white trotting team and a chestnut galloping charger from one file).
   */
  function instantiate(gltf) {
    const scene = gltf.scene.clone(true);
    const clones = new Map();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const one = (m) => {
        if (!m) return m;
        if (!clones.has(m)) {
          const c = m.clone();
          c.userData = {};
          clones.set(m, c);
        }
        return clones.get(m);
      };
      o.material = Array.isArray(o.material) ? o.material.map(one) : one(o.material);
    });
    return scene;
  }

  /** Aim and size a model onto the path, fitted on its oriented bounds. */
  function fitModel(model, spec) {
    model.rotation.y = spec.rotationY ?? 0;
    model.scale.setScalar(1);
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const fit = (spec.length ?? 3.3) / Math.max(size.x, 0.0001);
    model.scale.setScalar(fit);
    model.position.set(-(box.min.x + size.x / 2) * fit, -box.min.y * fit + (spec.groundY ?? -1.45), -(box.min.z + size.z / 2) * fit);
    model.traverse((o) => {
      if (!o.isMesh) return;
      if (shadows) { o.castShadow = true; o.receiveShadow = true; }
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => { if (m && m.side === THREE.DoubleSide) m.side = THREE.FrontSide; });
    });
    return fit;
  }

  async function tryLoadModel(name) {
    if (!(window.ENTRY3D_MODELS || []).includes(name)) return false;
    try {
      const gltf = await loadGLTF(name);
      const e = rigFor(name);
      const spec = { rotationY: 0, length: 3.3, groundY: -1.45, ...(e.cfg.model || {}) };
      const model = instantiate(gltf);
      fitModel(model, spec);
      if (spec.surface) applyRealisticSurface(model, spec.surface);

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

  /**
   * Put real horses in the coach's shafts. Only attempted when the horse model
   * is known to be present (it is listed in ENTRY3D_MODELS), so a missing file
   * never produces a failed request — the procedural pair simply stays.
   */
  async function attachTeam(name) {
    const e = rigFor(name);
    const team = e.cfg.team;
    if (!team || !(window.ENTRY3D_MODELS || []).includes(team.model) || !e.rig.slots) return false;
    try {
      const gltf = await loadGLTF(team.model);
      const horseSpec = { rotationY: 0, length: 3.3, groundY: -1.45, ...(ENTRIES[team.model]?.model || {}) };
      // Build the first horse, patch it, then clone it so both share one
      // material — one program, one clock, a pair trotting in step.
      const first = instantiate(gltf);
      const fit = fitModel(first, horseSpec);
      applyRealisticSurface(first, team.surface);
      const time = applyGallopShader(first, team.gallop);
      const cut = team.surface?.noRider;
      if (cut) {
        // The shadow pass must not see the rider either, or an invisible
        // knight shades the horse's back. Depth has no colour to test, so it
        // takes the torso volume and the height cut, which carry the mass.
        first.traverse((o) => {
          const d = o.isMesh && o.customDepthMaterial;
          if (!d) return;
          const inner = d.onBeforeCompile;
          d.onBeforeCompile = (shader, r) => {
            inner(shader, r);
            const [z0, z1, y0] = cut.torso;
            shader.vertexShader = shader.vertexShader
              .replace('#include <common>', '#include <common>\nvarying vec3 vRestPos;')
              .replace('#include <begin_vertex>', '#include <begin_vertex>\n vRestPos = position;');
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <common>', '#include <common>\nvarying vec3 vRestPos;')
              .replace('void main() {', `void main() {
                vec3 p = vRestPos;
                if ((p.z > ${z0.toFixed(3)} && p.z < ${z1.toFixed(3)} && p.y > ${y0.toFixed(3)}) || p.y > 0.2) discard;`);
          };
          const key = d.customProgramCacheKey();
          d.customProgramCacheKey = () => `${key}|norider`;
        });
      }
      const midline = (team.gallop.midX ?? 0) * fit;
      const carriers = e.rig.slots.map((slot, i) => {
        const model = i === 0 ? first : first.clone(true);
        const carrier = new THREE.Group();
        carrier.position.z = -midline;          // stand the animal's midline on the slot
        carrier.add(model);
        if (team.plume) {
          // The poll, measured off the mesh, carried into the fitted model's space.
          const plume = buildPlume(team.plume.color);
          plume.root.position.copy(new THREE.Vector3(...team.plume.at).applyMatrix4(model.matrix));
          plume.root.scale.setScalar(team.plume.scale ?? 1);
          carrier.add(plume.root);
          (e.plumes || (e.plumes = [])).push(plume);
        }
        if (team.rear) {
          // The hind hooves, in the carrier's space: the rearing pivot.
          const g = team.gallop;
          carrier.userData.pivot = new THREE.Vector3(g.midX ?? 0, g.belly - g.legLength, g.hindHipZ).applyMatrix4(model.matrix);
          carrier.userData.scale = team.scale ?? 1;
        }
        if (team.wings) {
          const at = new THREE.Vector3(...team.wings.at).applyMatrix4(model.matrix);
          carrier.userData.wings = attachWings(carrier, at, team.wings.span);
        }
        slot.add(carrier);
        return carrier;
      });
      // clone(true) does not copy customDepthMaterial; walk both trees together.
      const firstMeshes = [], otherMeshes = [];
      first.traverse((o) => o.isMesh && firstMeshes.push(o));
      carriers[1]?.children[0].traverse((o) => o.isMesh && otherMeshes.push(o));
      otherMeshes.forEach((o, i) => { o.customDepthMaterial = firstMeshes[i]?.customDepthMaterial; });
      e.rig.useTeam(carriers);
      e.teamTime = time;
      return true;
    } catch {
      return false;
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

  /*
   * Shader warm-up.
   *
   * WebGL compiles a program the first time something is drawn with it, and
   * it does so synchronously: a physical material with clearcoat and sheen,
   * its shadow-depth twin and the tone-mapping pass can hold the main thread
   * long enough that the first entrance visibly stalls — on a phone, badly.
   * So once the models are in, every rig is drawn once, in both looks, while
   * the stage is still transparent and nobody is watching.
   */
  const pendingLoads = [];
  let warmed = false;
  async function warmUp() {
    if (warmed) return;
    await Promise.allSettled(pendingLoads);
    if (running || warmed) return;
    warmed = true;
    try { await renderer.compileAsync(scene, camera); } catch { /* optional */ }
    if (running) return;
    const saved = [];
    rigs.forEach((r) => {
      saved.push([r, r.rig.root.visible, r.pivot.position.clone()]);
      r.rig.root.visible = true;
      r.pivot.position.set(0, r.cfg.y, 0);
    });
    resize();
    backdrop.quad.visible = true;
    for (const name of ['photoreal', 'stylised']) { applyLook(name); composer.render(); }
    backdrop.quad.visible = false;
    saved.forEach(([r, vis, pos]) => { r.rig.root.visible = vis; r.pivot.position.copy(pos); });
    renderer.clear();
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
      if (e.mixer) e.mixer.update(dt);
      else animateStaticModel(e.glb, t, u);
    } else {
      if (e.teamTime) e.teamTime.value = t;
      e.plumes?.forEach((pl) => pl.update(t));
      e.rig.update(t, u, { travel: p.travel, scale: e.cfg.scale });
    }

    // Fade the ride in and out at the edges instead of popping.
    const [fadeIn, fadeOut] = e.cfg.fade || [0.07, 0.94];
    const vis = window01(u, fadeIn, fadeOut);
    e.rig.root.visible = vis > 0.02;

    // Trail is laid along the path already flown, anchored just behind the body.
    e.trail.follow(e.cfg.path, u, e.cfg.trail.span ?? 0.07, e.cfg.y, TRAIL_OFFSET, vis);
    e.trail.mesh.visible = look.trail && vis > 0.02;

    // Dust where hooves and wheels meet the ground — more when moving fast.
    if (look.dust && e.cfg.dust && vis > 0.05) {
      const speed = Math.abs(p.travel - (e.lastTravel ?? p.travel)) / Math.max(dt, 1e-3);
      const rate = e.cfg.dust.rate * (0.3 + Math.min(speed / 2.5, 1)) * vis;
      e.dustAcc = (e.dustAcc || 0) + rate * dt;
      if (e.dustAcc >= 1) e.pivot.updateMatrixWorld(true);
      while (e.dustAcc >= 1) {
        e.dustAcc -= 1;
        const pts = e.cfg.dust.points;
        const [dx, dy, dz] = pts[(Math.random() * pts.length) | 0];
        e.rig.root.localToWorld(dustAt.set(dx, dy, dz));
        dust.spawn(dustAt, 0.35);
      }
    }
    // Embers and a hot glow at the hooves.
    if (e.cfg.embers && vis > 0.05) {
      e.emberAcc = (e.emberAcc || 0) + e.cfg.embers.rate * vis * dt;
      if (e.emberAcc >= 1) e.pivot.updateMatrixWorld(true);
      while (e.emberAcc >= 1) {
        e.emberAcc -= 1;
        const pts = e.cfg.embers.points;
        const [ex, ey, ez] = pts[(Math.random() * pts.length) | 0];
        e.rig.root.localToWorld(dustAt.set(ex, ey + Math.random() * 0.25, ez));
        embers.spawn(dustAt, 0.6, 0.3);
      }
      const [gx, gy, gz] = e.cfg.embers.glow;
      e.rig.root.localToWorld(hoofGlow.position.set(gx, gy, gz));
      hoofGlow.material.opacity = vis * (0.55 + 0.25 * Math.sin(t * 17) * Math.sin(t * 5.3));
      hoofGlow.visible = true;
    } else {
      hoofGlow.visible = false;
    }
    e.lastX = p.x;
    e.lastTravel = p.travel;
    const pxScale = size.h * renderer.getPixelRatio() * camera.projectionMatrix.elements[5] * 0.5;
    dust.wind = e.cfg.dust?.wind ?? 0;
    embers.wind = e.cfg.dust?.wind ?? 0;
    dust.update(dt, look.dust ? 1 : 0);
    embers.update(dt, 1);
    dust.uniforms.uScale.value = pxScale;
    embers.uniforms.uScale.value = pxScale;

    // Scene card behind the ride.
    if (backdrop.quad.visible) {
      backdrop.uniforms.uT.value = t;
      backdrop.uniforms.uScroll.value = p.travel;
      backdrop.uniforms.uAspect.value = size.w / Math.max(size.h, 1);
      backdrop.uniforms.uAlpha.value = 1;
    }
    // Rides that arrive, hold and fade take the whole layer down together —
    // horse, card, dust and all — instead of popping out.
    if (e.cfg.fadeCanvas) canvas.style.opacity = vis.toFixed(3);

    // Lighting and stage react to where the ride is.
    if (shadows) {
      const [kx, ky, kz] = e.cfg.lights?.keyOffset || look.keyOffset;
      key.position.set(p.x + kx, ky, p.z + kz);
      key.target.position.set(p.x, e.cfg.y + p.y, p.z);
      key.target.updateMatrixWorld();
    }
    // Contact shadow fades and spreads with height off the floor.
    const lift = clamp((e.cfg.y + p.y + 1.7) / 2.6, 0, 1);
    contact.position.x = p.x;
    contact.material.opacity = vis * 0.7 * (1 - lift * 0.72);
    const [csx, csy] = e.cfg.contact || [1, 1];
    contact.scale.set((1 + lift * 0.7) * csx, (1 + lift * 0.7) * csy, 1);
    hero.position.set(p.x, e.cfg.y + p.y + 0.6, p.z + 2.2);
    hero.intensity = vis * look.hero;
    hero.color.setHex(e.cfg.accent);
    pool.position.x = p.x * 0.55;
    pool.material.color.setHex(e.cfg.pool);
    pool.material.opacity = (0.12 + vis * 0.26) * look.pool;
    podium.material.opacity = vis * 0.16 * look.pool;
    under.intensity = (2.5 + vis * 4) * look.under;

    // Arrival flare and spark burst peak as the ride reaches centre.
    const peak = pulse(u, 0.4, 0.13);
    flare.position.set(p.x + 0.9, e.cfg.y + p.y - 0.5, -3);
    flare.material.opacity = peak * 0.08 * look.fx;
    flare.rotation.z = t * 0.5;
    flare.scale.setScalar(0.55 + peak * 0.6);

    ambient.drift(t, { x: 13, y: 4.4, z: 5 });
    ambient.points.material.opacity = (0.18 + vis * 0.32) * (0.35 + 0.65 * look.fx);
    burst.burstFrom(t, new THREE.Vector3(p.x, e.cfg.y + p.y, p.z), 2.6, 0.4 + peak * 1.4);
    burst.points.material.color.setHex(e.cfg.accent);
    burst.points.material.opacity = peak * 0.75 * look.fx;

    rays.forEach((r, i) => { r.material.opacity = (0.018 + 0.012 * Math.sin(t * 1.4 + i)) * (0.35 + vis * 0.65) * look.rays; });

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
    const settle = smooth(clamp(u * 2.4, 0, 1)) * (1 - smooth(clamp((u - 0.74) / 0.26, 0, 1)));
    camera.position.x = p.x * 0.07;
    camera.position.y = 0.25 + p.y * 0.1 + Math.sin(t * 0.7) * 0.05;
    camera.position.z = lerp(11.6, 10.3, settle);
    camera.lookAt(p.x * 0.18, e.cfg.y * 0.5 + p.y * 0.35, 0);

    resize();
    composer.render();

    if (t >= e.duration) {
      running = false;
      cancelAnimationFrame(raf);
      e.rig.root.visible = false;
      e.trail.mesh.visible = false;
      backdrop.quad.visible = false;
      canvas.style.opacity = '';
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
      if (opts.noModels) return;
      pendingLoads.push(tryLoadModel(name));
      if (ENTRIES[name].team) pendingLoads.push(attachTeam(name));
    },
    warmUp,
    play(name, duration, done) {
      if (!ENTRIES[name]) return false;
      this.stop();
      const e = rigFor(name);
      e.key = name;
      e.duration = reduced ? Math.min(duration, 2.2) : duration;
      rigs.forEach((r) => { r.rig.root.visible = false; r.trail.mesh.visible = false; });
      applyLook(e.cfg.photoreal ? 'photoreal' : 'stylised');
      const L = e.cfg.lights;
      if (L?.key) { key.color.setHex(L.key[0]); key.intensity = L.key[1]; }
      if (L?.rim) { rim.color.setHex(L.rim[0]); rim.intensity = L.rim[1]; rim.position.set(...L.rim[2]); }
      else rim.position.set(6, 2.5, -5);
      if (L?.sky != null) sky.intensity = L.sky;
      if (L?.env != null) scene.environmentIntensity = L.env;
      backdrop.quad.visible = e.cfg.backdrop === 'sunset';
      canvas.style.opacity = '';
      dust.clear(); embers.clear();
      e.lastX = undefined; e.lastTravel = undefined;
      e.dustAcc = 0; e.emberAcc = 0;
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
      backdrop.quad.visible = false;
      canvas.style.opacity = '';
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
