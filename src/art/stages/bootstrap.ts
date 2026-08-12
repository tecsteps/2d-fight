import * as THREE from 'three';
import { buildFightRig, type FightRig, type LightPresetName } from './lighting';

/**
 * Bootstrap stage.
 *
 * A deliberately simple lit environment that exists so the render pipeline is
 * runnable and screenshottable from day one. It establishes the conventions the
 * real stages follow — three parallax groups, the shared `buildFightRig` light
 * rig, and a `tick` for anything animated — and is expected to be replaced
 * wholesale by the authored stages in this directory.
 *
 * The one thing worth copying from here is how the **warm pool on the floor** is
 * built. It is not a light. A point light at the centre of the plane makes a
 * fighter standing at midscreen a different colour from the same fighter in the
 * corner, because Three has no way to exclude the fighters from it and inverse
 * square does the rest — that bug is what made the first lineup capture render
 * four different skin tones as one orange. The pool here is additive geometry
 * lying on the floor, so it grounds the fighters visually and contributes
 * exactly nothing to their shading.
 *
 * Everything here is generated in code. No textures are loaded.
 */

export interface Stage {
  background: THREE.Group;
  world: THREE.Group;
  foreground: THREE.Group;
  tick?(frame: number): void;
}

export interface BootstrapStageOptions {
  /** Lighting mood. See `LIGHT_PRESETS` in `lighting.ts`. */
  preset?: LightPresetName;
}

export interface BootstrapStage extends Stage {
  /** Exposed so a capture or debug overlay can print `describeRig(rig)`. */
  rig: FightRig;
}

/**
 * Procedural gradient sky.
 *
 * Deep indigo above, one hot band at the horizon. The value of this backdrop is
 * that it is *cool where the fighters are warm*: the key is warm and the
 * characters are mostly warm-skinned, so a warm backdrop behind them removes the
 * only free contrast the frame has. The warm band is kept low and narrow so it
 * reads as a sun that has just gone down rather than as a wash.
 */
function makeSky(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(140, 70);
  const mat = new THREE.ShaderMaterial({
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x0b1024) },
      uMid: { value: new THREE.Color(0x2a2545) },
      uHorizon: { value: new THREE.Color(0x7b3f2e) },
      uGlow: { value: new THREE.Color(0xc9713a) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uTop, uMid, uHorizon, uGlow;
      void main() {
        float t = vUv.y;
        vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.30, t));
        c = mix(c, uTop, smoothstep(0.26, 0.92, t));
        // Off-centre sun glow, on the same side as the key. A backdrop whose
        // brightest point disagrees with the key light reads as two suns.
        float d = length((vUv - vec2(0.32, 0.075)) * vec2(1.0, 2.3));
        c += uGlow * pow(max(1.0 - d * 1.35, 0.0), 3.0) * 0.85;
        // Subtle dither so a dark gradient never bands on an 8-bit display.
        float dither = fract(sin(dot(vUv * 1024.0, vec2(12.9898, 78.233))) * 43758.5453);
        c += (dither - 0.5) / 255.0;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(0, 14, -34);
  m.renderOrder = -100;
  return m;
}

/**
 * Matte arena floor. Lit only by the rig, so it holds the key's cast shadows.
 *
 * The depth falloff is baked into vertex colours rather than left to the lights.
 * A flat plane lit by a directional rig is uniformly bright to the horizon, and a
 * floor that is as bright at the back as it is at the fighters' feet destroys the
 * depth read — the frame turns into a figure standing on a wall. Falling off with
 * distance and toward the wings also stops the horizon line from being the
 * highest-contrast edge in the picture, which is where the eye goes if you let
 * it.
 */
function makeFloor(): THREE.Mesh {
  const width = 90;
  const depth = 46;
  const geo = new THREE.PlaneGeometry(width, depth, 24, 24);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.getAttribute('position');
  const shade = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // Ahead of the fighting line the floor keeps its value; behind it, it sinks
    // into the backdrop so the two meet at similar values.
    const back = THREE.MathUtils.smoothstep(-z, 1, depth * 0.42);
    const wing = THREE.MathUtils.smoothstep(Math.abs(x), 5, width * 0.4);
    const near = THREE.MathUtils.smoothstep(z, 2, depth * 0.35);
    const v = (1 - back * 0.88) * (1 - wing * 0.55) * (1 - near * 0.3);
    shade[i * 3] = v;
    shade[i * 3 + 1] = v * 0.985;
    // Slightly bluer as it recedes: cheap aerial perspective, and it puts the
    // one cool note in the frame exactly where the warm pool is not.
    shade[i * 3 + 2] = v * (0.95 + back * 0.12);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(shade, 3));

  const mat = new THREE.MeshStandardMaterial({
    color: 0x4a3c2c,
    roughness: 0.92,
    metalness: 0.0,
    vertexColors: true,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = 0;
  m.receiveShadow = true;
  return m;
}

/**
 * The warm pool, as additive geometry rather than as a light.
 *
 * Lies a centimetre above the floor with `depthWrite` off and additive blending,
 * so it brightens the plane where the fighters stand and does not touch them.
 * Elliptical because the camera looks along −Z: a circular pool projects as an
 * ellipse anyway, and authoring the ellipse directly lets the falloff reach
 * further up-frame than it does toward the camera, which is what a low sun does.
 */
function makeFloorPool(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(34, 26, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(0x9d5526) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      void main() {
        vec2 d = (vUv - vec2(0.5, 0.56)) * vec2(1.0, 1.35);
        float r = length(d) * 2.0;
        // Squared falloff, then squared again at the edge, so there is no ring
        // where the quad ends — a visible pool boundary reads as a decal.
        float a = pow(max(1.0 - r, 0.0), 2.2);
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = 0.01;
  m.renderOrder = -50;
  return m;
}

export function buildBootstrapStage(opts: BootstrapStageOptions = {}): BootstrapStage {
  const background = new THREE.Group();
  const world = new THREE.Group();
  const foreground = new THREE.Group();

  background.add(makeSky());
  world.add(makeFloor(), makeFloorPool());

  const rig = buildFightRig({
    preset: opts.preset ?? 'dusk',
    planeHalfWidth: 11,
    planeHeight: 9,
  });
  world.add(rig.group);

  const stage: BootstrapStage = { background, world, foreground, rig };
  // The world group is what gets audited: anything a stage adds to the fighting
  // plane is in here, and a positional light among it is the one mistake that
  // silently recolours fighters by where they stand.
  rig.apply(world);
  return stage;
}
