// The shared Three.js particle field.
//
// This is the original casberry.in swarm export refactored into something three
// pages can share: the scene, the instanced mesh, and the animation loop live
// here, while *what the particles do* is supplied by a mapping module (see
// ./mappings/). A mapping gets the audio frame once per frame and then answers
// one question per particle: where should this one be, and what color is it?
//
// Performance notes — this loop runs 20,000 times per frame, so a few things
// are deliberately un-idiomatic:
//
//   * Grid geometry (x, z, radius, angle) is precomputed once into typed
//     arrays. The original recomputed div/mod/floor per particle per frame.
//   * Positions live in one flat Float32Array, not 20,000 Vector3 objects.
//   * We write straight into instanceMatrix.array instead of calling
//     dummy.updateMatrix() + setMatrixAt(), which compose and copy 16 floats
//     each. Since particles only translate and uniformly scale, we touch 6.
//   * The mapping writes into a single reused `out` object. No allocation
//     happens inside the loop.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { VIZ } from "./config.js";
import { getTheme, onThemeChange } from "./theme.js";

/**
 * Build the backdrop as a screen-space texture: a vertical gradient with
 * optional soft horizontal light streaks.
 *
 * Only 4px wide — three stretches a plain (non-equirect) texture across the
 * whole frame, and the image is uniform horizontally, so there's nothing to
 * gain from more columns. That also means it never needs regenerating on
 * resize. Returns null for themes that want a flat clear colour.
 */
function makeBackdrop(theme) {
  const g = theme.gradient;
  if (!g) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");

  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, g.top);
  if (g.mid) grad.addColorStop(g.midStop ?? 0.5, g.mid);
  grad.addColorStop(1, g.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Each streak is its own transparent -> white -> transparent gradient, which
  // gives soft edges without needing a blur filter.
  for (const band of g.bands ?? []) {
    const half = (band.thickness * canvas.height) / 2;
    const centre = band.at * canvas.height;
    const streak = ctx.createLinearGradient(0, centre - half, 0, centre + half);
    streak.addColorStop(0, "rgba(255,255,255,0)");
    streak.addColorStop(0.5, `rgba(255,255,255,${band.alpha})`);
    streak.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = streak;
    ctx.fillRect(0, centre - half, canvas.width, half * 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  // Canvas pixels are sRGB; without this three treats them as linear and the
  // whole backdrop renders washed out.
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** Shortest-arc hue interpolation, so green -> magenta doesn't sweep through
 *  every hue in between the long way round. */
function lerpHue(from, to, t) {
  let d = to - from;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  let h = from + d * t;
  return h - Math.floor(h);
}

/**
 * @param {object} mapping   from ./mappings/*.js — { prepare, particle }
 * @param {(dt:number)=>object} getAudio  returns the current audio frame
 */
export function createViz({ mapping, getAudio }) {
  const COUNT = VIZ.count;
  const span = VIZ.span;

  let theme = getTheme();

  // --- scene -----------------------------------------------------------------
  const scene = new THREE.Scene();
  // Fog must match the backdrop or the far field fades toward the wrong colour
  // and the horizon shows a seam. With a gradient that can only be approximate,
  // so theme.background is set to the gradient's midpoint — where the horizon
  // and the most heavily fogged particles actually are.
  scene.fog = new THREE.FogExp2(theme.background, theme.fogDensity);

  let backdrop = makeBackdrop(theme);
  scene.background = backdrop;

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camera.position.set(...(mapping.camera ?? VIZ.camera));

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, VIZ.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(theme.background, 1);
  renderer.domElement.id = "viz";
  document.body.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);

  // Camera sweep. Rather than orbiting forever, the camera swings through
  // VIZ.sweep.arcDegrees and reverses, pendulum-style.
  //
  // We reuse OrbitControls' autoRotate rather than moving the camera ourselves,
  // because autoRotate composes correctly with damping and is automatically
  // suppressed while the user is dragging. It applies
  // (2π/60 * autoRotateSpeed) * deltaTime radians per update, so we can drive
  // any motion we like by setting autoRotateSpeed to the angular velocity we
  // want, converted into those units.
  //
  // Position is halfArc * sin(phase), so velocity is its derivative:
  // halfArc * cos(phase) * dphase/dt. Feeding the analytic velocity (instead of
  // differencing successive positions) keeps the arc exact even when the sweep
  // rate changes with the audio, and avoids dividing by dt.
  controls.autoRotate = true;
  const halfArc = (VIZ.sweep.arcDegrees * Math.PI) / 360; // half of the arc, in radians
  const RAD_PER_SPEED_UNIT = (Math.PI * 2) / 60; // OrbitControls' internal scale
  let sweepPhase = 0;

  // --- post processing --------------------------------------------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    VIZ.bloom.strength,
    VIZ.bloom.radius,
    VIZ.bloom.threshold
  );
  // The threshold must sit above the theme's own background luminance,
  // otherwise the pass blooms the backdrop and greys out the frame.
  bloomPass.threshold = theme.bloomThreshold;
  bloomPass.enabled = theme.bloomScale > 0;
  composer.addPass(bloomPass);

  // --- instanced mesh ---------------------------------------------------------
  const geometry = new THREE.TetrahedronGeometry(VIZ.size);
  // Measure the geometry rather than assuming VIZ.size is its height: a
  // tetrahedron of circumradius r spans only ±r/√3 in Y, so both the trail
  // length maths and the shader's gradient normalisation need the real extent.
  geometry.computeBoundingBox();
  const geomHalfY = geometry.boundingBox.max.y;
  const geomHeightY = geometry.boundingBox.max.y - geometry.boundingBox.min.y;

  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });

  // Trail shading. The loop stretches a falling particle along Y, but a stretched
  // instance is a single flat colour — which just reads as a longer particle,
  // not a trail. This injection gives it a gradient along its own length: the
  // head keeps the particle's colour, the tail fades to the theme's trail
  // colour.
  //
  // The stretch factor is recovered from the instance matrix rather than passed
  // as another attribute — column 0 and column 1 are the X and Y basis vectors,
  // so their lengths are the axis scales, and their ratio is exactly the
  // stretch the loop applied.
  const trailUniforms = {
    uTrailColor: { value: new THREE.Color(theme.trailColor) },
    uHalfHeight: { value: geomHalfY },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, trailUniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vTrail;
        uniform float uHalfHeight;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          float sx = length( instanceMatrix[ 0 ].xyz );
          float sy = length( instanceMatrix[ 1 ].xyz );
          float stretch = sy / max( sx, 1e-4 );
          // Self-normalising: 0 when unstretched, approaching 1 for long
          // trails. No reference maximum to keep in sync with the CPU side.
          float amount = clamp( 1.0 - 1.0 / max( stretch, 1.0 ), 0.0, 1.0 );
          // Local +y is the head (where the particle actually is, leading the
          // rise); -y is the tail streaming downward behind it.
          float along = clamp( -position.y / uHalfHeight * 0.5 + 0.5, 0.0, 1.0 );
          vTrail = along * amount;
        }`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vTrail;
        uniform vec3 uTrailColor;`
      )
      // After color_fragment so it blends over the per-instance colour, and
      // before fog_fragment so the trail is fogged like everything else.
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        diffuseColor.rgb = mix( diffuseColor.rgb, uTrailColor, vTrail );`
      );
  };
  const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false; // instances move well outside the initial bounds
  scene.add(mesh);

  // InstancedMesh does not initialize its matrices — an all-zero matrix
  // collapses the instance to a point. Write identity once; from here on the
  // loop only touches translation and scale.
  const M = mesh.instanceMatrix.array;
  for (let i = 0; i < COUNT; i++) {
    const m = i * 16;
    M[m] = 1;
    M[m + 5] = 1;
    M[m + 10] = 1;
    M[m + 15] = 1;
  }
  // Calling setColorAt once lets three allocate instanceColor for us; after
  // that we write into the array directly.
  mesh.setColorAt(0, new THREE.Color(0xffffff));
  const C = mesh.instanceColor.array;

  // --- precomputed grid geometry ---------------------------------------------
  const gridSize = Math.ceil(Math.sqrt(COUNT));
  const maxR = (span / 2) * Math.SQRT2;
  const G = {
    count: COUNT,
    gridSize,
    span,
    maxR,
    x: new Float32Array(COUNT),
    z: new Float32Array(COUNT),
    r: new Float32Array(COUNT), // distance from origin
    nr: new Float32Array(COUNT), // normalized 0..1
    a: new Float32Array(COUNT), // angle around Y
  };
  for (let i = 0; i < COUNT; i++) {
    const row = Math.floor(i / gridSize);
    const col = i % gridSize;
    const x = (col / gridSize - 0.5) * span;
    const z = (row / gridSize - 0.5) * span;
    const r = Math.sqrt(x * x + z * z);
    G.x[i] = x;
    G.z[i] = z;
    G.r[i] = r;
    G.nr[i] = r / maxR;
    G.a[i] = Math.atan2(z, x);
  }

  // --- particle state ---------------------------------------------------------
  // Start scattered so the first frame resolves into the pattern rather than
  // popping into place.
  const pos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT * 3; i++) pos[i] = (Math.random() - 0.5) * span;

  // The single object every mapping writes into.
  const out = { x: 0, y: 0, z: 0, scale: 1, color: new THREE.Color() };

  // --- state-driven palette ---------------------------------------------------
  let state = "idle";
  const target = { ...theme.palette.idle };
  const palette = { ...theme.palette.idle };

  function easePalette(dt) {
    const t = 1 - Math.exp(-4 * dt);
    palette.hue = lerpHue(palette.hue, target.hue, t);
    palette.sat += (target.sat - palette.sat) * t;
    palette.bloom += (target.bloom - palette.bloom) * t;
  }

  // --- loop -------------------------------------------------------------------
  const clock = new THREE.Clock();
  let elapsed = 0;
  let raf = 0;
  let running = false;

  function frame() {
    raf = requestAnimationFrame(frame);

    // getElapsedTime() internally calls getDelta(), so we accumulate our own
    // clock instead of calling both. Clamp dt so returning to a backgrounded
    // tab doesn't fire one enormous step through the envelope followers.
    const dt = Math.min(clock.getDelta(), 0.1);
    elapsed += dt;

    const audio = getAudio(dt);
    easePalette(dt);

    // Louder audio -> more glow, and a livelier sweep.
    bloomPass.strength =
      VIZ.bloom.strength * theme.bloomScale * palette.bloom * (1 + audio.rms * 0.9);

    const phaseRate =
      ((Math.PI * 2) / VIZ.sweep.periodSec) * (1 + audio.rms * VIZ.sweep.audioBoost);
    sweepPhase += dt * phaseRate;
    const angularVelocity = halfArc * Math.cos(sweepPhase) * phaseRate;
    controls.autoRotateSpeed = angularVelocity / RAD_PER_SPEED_UNIT;

    // Passing dt makes the sweep frame-rate independent — without it
    // OrbitControls assumes 60 fps and spins ~2.4x too fast on a 144 Hz display.
    controls.update(dt);

    mapping.prepare(audio, elapsed, dt, palette, G);

    const k = 1 - Math.exp(-VIZ.lerpPerSec * dt);
    // Per-frame displacement converted to units/second, so trail length doesn't
    // depend on frame rate.
    const invDt = dt > 0 ? 1 / dt : 0;
    const shutter = VIZ.trail.shutterSec;
    const maxTrail = VIZ.trail.maxLength;

    for (let i = 0; i < COUNT; i++) {
      mapping.particle(i, G, out);

      const p = i * 3;
      pos[p] += (out.x - pos[p]) * k;
      const prevY = pos[p + 1];
      pos[p + 1] += (out.y - prevY) * k;
      pos[p + 2] += (out.z - pos[p + 2]) * k;

      // Trail: stretch along Y while rising. Motion in this field is almost
      // entirely vertical, so Y *is* the velocity axis — no per-particle basis
      // to build, and the matrix stays diagonal.
      const dy = pos[p + 1] - prevY;
      const m = i * 16;
      const s = out.scale;

      // Trail length is the distance travelled during the shutter — an
      // absolute world-space length, converted to a stretch factor afterwards
      // so it looks the same whatever size the particle happens to be.
      let trailLen = 0;
      let stretch = 1;
      if (dy > 0) {
        trailLen = dy * invDt * shutter;
        if (trailLen > maxTrail) trailLen = maxTrail;
        stretch = 1 + trailLen / (geomHeightY * s);
      }

      M[m] = s;
      M[m + 5] = s * stretch;
      M[m + 10] = s;
      M[m + 12] = pos[p];
      // Scaling grows the shape about its centre, which would push the head
      // above the particle. Offsetting by half the added length keeps the head
      // put and lets the tail stream downward, behind the rise.
      M[m + 13] = pos[p + 1] - trailLen * 0.5;
      M[m + 14] = pos[p + 2];

      const c = out.color;
      C[p] = c.r;
      C[p + 1] = c.g;
      C[p + 2] = c.b;
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    composer.render();
  }

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", onResize);

  // Swap backdrop, fog, bloom and palette when the user flips the theme. The
  // palette re-targets rather than snapping, so the field eases across.
  const unsubscribeTheme = onThemeChange((next) => {
    theme = next;
    scene.fog.color.setHex(theme.background);
    scene.fog.density = theme.fogDensity;
    renderer.setClearColor(theme.background, 1);
    backdrop?.dispose();
    backdrop = makeBackdrop(theme);
    scene.background = backdrop;
    bloomPass.threshold = theme.bloomThreshold;
    bloomPass.enabled = theme.bloomScale > 0;
    // Shared uniform object, so the running shader picks this up immediately.
    trailUniforms.uTrailColor.value.setHex(theme.trailColor);
    Object.assign(target, theme.palette[state] ?? theme.palette.idle);
  });

  return {
    start() {
      if (running) return;
      running = true;
      clock.getDelta(); // discard the gap since construction
      frame();
    },
    /** Conversation state drives the palette and glow. */
    setState(next) {
      state = next;
      Object.assign(target, theme.palette[state] ?? theme.palette.idle);
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      unsubscribeTheme();
      window.removeEventListener("resize", onResize);
      controls.dispose();
      backdrop?.dispose();
      geometry.dispose();
      material.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
