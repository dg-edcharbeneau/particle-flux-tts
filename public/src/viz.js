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

  // --- scene -----------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.0075);

  const camera = new THREE.PerspectiveCamera(
    60,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camera.position.set(0, 38, 110);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, VIZ.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  composer.addPass(bloomPass);

  // --- instanced mesh ---------------------------------------------------------
  const geometry = new THREE.TetrahedronGeometry(VIZ.size);
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
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
  const target = { ...VIZ.palette.idle };
  const palette = { ...VIZ.palette.idle };

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
    bloomPass.strength = VIZ.bloom.strength * palette.bloom * (1 + audio.rms * 0.9);

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
    for (let i = 0; i < COUNT; i++) {
      mapping.particle(i, G, out);

      const p = i * 3;
      pos[p] += (out.x - pos[p]) * k;
      pos[p + 1] += (out.y - pos[p + 1]) * k;
      pos[p + 2] += (out.z - pos[p + 2]) * k;

      const m = i * 16;
      const s = out.scale;
      M[m] = s;
      M[m + 5] = s;
      M[m + 10] = s;
      M[m + 12] = pos[p];
      M[m + 13] = pos[p + 1];
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

  return {
    start() {
      if (running) return;
      running = true;
      clock.getDelta(); // discard the gap since construction
      frame();
    },
    /** Conversation state drives the palette and glow. */
    setState(state) {
      Object.assign(target, VIZ.palette[state] ?? VIZ.palette.idle);
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
