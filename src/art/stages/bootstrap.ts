import * as THREE from 'three';
import { buildFightRig, type FightRig, type LightPresetName } from './lighting';

/**
 * Bootstrap stage.
 *
 * A deliberately simple lit environment that exists so the render pipeline is
 * runnable and screenshottable from day one. It establishes the conventions the
 * real stages follow — three parallax groups, the shared `buildFightRig` light
 * rig, a `tick` for anything animated, and the contact-shadow contract below —
 * and is expected to be replaced wholesale by the authored stages in this
 * directory.
 *
 * ## What this stage is actually for: the value structure
 *
 * The version of this file that shipped for review 002 was a black plane under a
 * black sky with one additive orange pool in the middle of it. Measured, that is
 * a median frame luminance of 21 with 35% of pixels under L=16 and 2.5% over
 * L=128 — no midtones at all. It also silently destroyed another agent's work:
 * the ink pass had just been rewritten to colour contours as a *dark tint of the
 * local surface*, which is correct, and which is invisible on a black ground.
 *
 * So the numbers below are not mood, they are load-bearing, and they are quoted
 * as **display luminance in the final graded frame** rather than as albedo,
 * because albedo on its own tells you nothing once a tone curve and a LUT are in
 * the way. Targets from `docs/FRAME_BUDGET.md`:
 *
 * ```
 *   sky, top of frame              L  30
 *   sky, just above the horizon    L  71
 *   floor, far edge                L  64      <- 7 L from the sky it meets
 *   floor, under the fighters      L 112
 *   floor, bottom of frame         L 148
 * ```
 *
 * Read as a whole that is one continuous dark-top-to-light-bottom ramp with the
 * fighters standing across the middle of it. The roster then owns *both* ends of
 * the value scale that nothing else in the frame is using: lit skin sits above
 * the floor at L≈160-190, ink and cast shadow sit below the sky at L≈25-50. That
 * is the whole reason a KOF XIII stage is mid-range and not moody.
 *
 * Three consequences worth stating, because each one is a mistake this file has
 * already made once:
 *
 * - **The stage gets brighter by raising the rig's `keyLuminance`, never by
 *   raising post exposure.** Exposure moves the fighters too, and they are
 *   already where they should be; see `lighting.ts` for why the NPR shader is
 *   invariant to that particular dial.
 * - **Nothing in this file may vary along screen-x at the fighting line.** The
 *   old additive pool made the floor 2.6x brighter at midscreen than at the
 *   wings, so a fighter walking from one side to the other crossed ground that
 *   more than doubled in brightness. Every falloff below is a function of depth
 *   or of |x| far outside the playfield, and the budget has a measured invariant
 *   for it.
 * - **Fighters are grounded by geometry, not by a light.** See
 *   `setContactPoints`.
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

/**
 * Where a fighter is touching the floor, in world metres on the fighting plane.
 *
 * The stage cannot work this out for itself — it has no reference to the roster
 * and must not acquire one, or every stage becomes coupled to the character rig.
 * The scene owns the skeletons, so the scene reports the contacts and the stage
 * draws them. See `BootstrapStage.setContactPoints`.
 */
export interface ContactPoint {
  /** World X of the sole's centre. */
  x: number;
  /** World Z. Defaults to 0, the fighting plane. */
  z?: number;
  /**
   * Half-width of the contact patch in metres — roughly the sole's own radius,
   * *not* the extent of the shadow. The falloff reaches about six times this.
   * Default 0.10, which is a human foot.
   */
  radius?: number;
  /**
   * 0..1. Scale it down for a foot carrying less weight and to zero as a foot
   * leaves the ground, which is what stops a jumping fighter dragging a patch of
   * darkness around under them.
   */
  strength?: number;
}

export interface BootstrapStage extends Stage {
  /** Exposed so a capture or debug overlay can print `describeRig(rig)`. */
  rig: FightRig;
  /**
   * Publishes this frame's foot contacts. Call once per frame, before render,
   * with every sole that is on the floor; pass `[]` when nobody is grounded.
   *
   * ```ts
   * stage.setContactPoints([
   *   { x: fighter.x - 0.09, strength: fighter.groundedL },
   *   { x: fighter.x + 0.09, strength: fighter.groundedR },
   * ]);
   * ```
   *
   * This exists because contact occlusion is the one shadow a cast-shadow map
   * cannot draw. The key is 44° up, so its shadow leaves the foot sideways and
   * the ground directly under the sole is left at full brightness — review 002
   * measured the floor as 26-29% *brighter* under three of four fighters' soles
   * than beside them, which reads as four figures hovering over a glowing plane.
   * What is missing is ambient occlusion at the contact: a tight, dark, cool
   * core right at the sole, an order of magnitude smaller than the cast shadow
   * and completely independent of where the key is.
   *
   * Cheap by construction — one screen-aligned quad, one multiply, no extra
   * render target — so it costs the same whether nobody or everybody is on the
   * floor. Points past `MAX_CONTACTS` are dropped with a warning.
   */
  setContactPoints(points: readonly ContactPoint[]): void;
}

/**
 * Contact patches the shader can carry. Two feet times four fighters plus room
 * for a knee, a hand or a downed body, which is what a throw or a knockdown
 * needs and is the point at which a fixed array stops being a limitation.
 */
const MAX_CONTACTS = 12;

/** Shared GLSL: one cheap value-noise field, used by the sky and the floor. */
const NOISE_GLSL = /* glsl */ `
  float sHash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }
  float sNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = sHash(i);
    float b = sHash(i + vec2(1.0, 0.0));
    float c = sHash(i + vec2(0.0, 1.0));
    float d = sHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
`;

/**
 * Procedural sky.
 *
 * Five stops on **world height**, not on the quad's own UV. That distinction is
 * the whole reason this shader was rewritten: the quad is 70 metres tall and the
 * camera sees about 14 of them, so authoring against UV meant every value in the
 * gradient was placed by solving a linear map in your head, and the version that
 * shipped for review 002 had its entire sunset band below the bottom of frame.
 * Against world Y the stops are just heights, and `y = 0` is the horizon.
 *
 * The colours are hexes at the value they would be *painted*, scaled into scene
 * radiance by a per-stop multiplier solved against the tone curve and the grade.
 * The multipliers look arbitrary and are not: each one is the number that lands
 * that stop on its target display luminance in the final frame. Change a hex and
 * the multiplier is wrong.
 *
 * The frame is warm on the ground and cool in the air, so the sky is the cool
 * half of that opposition everywhere except the last metre above the horizon,
 * where it turns to a desaturated warm haze that the floor's far edge can meet
 * without a seam. It is *desaturated* warm on purpose: the roster is warm and
 * saturated, and a saturated warm sky behind them would take the only free
 * chroma contrast the frame has.
 */
function makeSky(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(190, 96);

  /** Hex as painted, times the scale that lands it on `L` in the graded frame. */
  const stop = (hex: number, scale: number): THREE.Color =>
    new THREE.Color(hex).multiplyScalar(scale);

  const mat = new THREE.ShaderMaterial({
    depthWrite: false,
    uniforms: {
      uTop: { value: stop(0x2f3a63, 0.560) }, //  y >= 15   L 30
      uHigh: { value: stop(0x36416b, 0.569) }, //  y ~  9    L 36
      uMid: { value: stop(0x415076, 0.505) }, //  y ~  5.5  L 44
      uHaze: { value: stop(0x5c6484, 0.418) }, //  y ~  1.2  L 55
      uHorizon: { value: stop(0xa89a95, 0.228) }, //  y <= 0    L 71
    },
    vertexShader: /* glsl */ `
      varying float vHeight;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vHeight = (modelMatrix * vec4(position, 1.0)).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vHeight;
      varying vec2 vUv;
      uniform vec3 uTop, uHigh, uMid, uHaze, uHorizon;

      ${NOISE_GLSL}

      // Segment-wise so each stop lands exactly on its authored value. Stacked
      // mixes over overlapping ranges do not: every later mix drags the earlier
      // stops toward itself and the measured gradient stops matching the table.
      // smoothstep rather than a straight lerp inside each segment, so the two
      // sides of a stop share a derivative and the sky cannot Mach-band.
      vec3 skyRamp(float y) {
        if (y < 1.2)  return mix(uHorizon, uHaze, smoothstep(-1.2, 1.2, y));
        if (y < 5.5)  return mix(uHaze, uMid, smoothstep(1.2, 5.5, y));
        if (y < 9.0)  return mix(uMid, uHigh, smoothstep(5.5, 9.0, y));
        return mix(uHigh, uTop, smoothstep(9.0, 15.0, y));
      }

      void main() {
        vec3 c = skyRamp(vHeight);

        // The key is at azimuth -38, i.e. off frame-left and behind the camera,
        // so what we are looking at is the anti-solar sky. It gets very slightly
        // warmer and lighter toward frame-right, away from the sun, and that
        // asymmetry is most of what stops a vertical gradient reading as a
        // gradient. Kept under 6% — any more and it becomes a second light.
        float side = smoothstep(-40.0, 40.0, (vUv.x - 0.5) * 190.0);
        c *= mix(0.97, 1.055, side);

        // A low bank of haze standing on the horizon. It is a *value* shape at
        // 8% contrast rather than a silhouette: the fighters' hips cross this
        // band, and a dark distant skyline behind a dark costume is a merge.
        // What it buys at this contrast is a horizon that has a shape at all,
        // which is the difference between depth and a backdrop.
        float ridge = sNoise(vec2(vUv.x * 6.5, 0.3)) * 1.5
                    + sNoise(vec2(vUv.x * 19.0, 4.1)) * 0.55;
        float bank = smoothstep(ridge + 0.15, ridge - 0.55, vHeight);
        c *= mix(1.0, 0.92, bank);

        // Subtle dither so a dark gradient never bands on an 8-bit display.
        float dither = fract(sin(dot(vUv * 1024.0, vec2(12.9898, 78.233))) * 43758.5453);
        c += (dither - 0.5) / 255.0;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const m = new THREE.Mesh(geo, mat);
  // Placed so its centre sits well above the camera and its lower half covers
  // everything the floor does not. The gradient is in world space, so moving
  // this quad does not move the horizon — only the quad's own coverage.
  m.position.set(0, 20, -34);
  m.renderOrder = -100;
  return m;
}

/**
 * Matte stone arena floor, lit by the rig so it holds the key's cast shadows.
 *
 * ## Why the depth ramp is a fragment shader and not vertex colours
 *
 * It used to be vertex colours, and vertex colours cannot carry the slab pattern
 * — which matters more than it sounds. A perfectly clean plane has no texture
 * frequency at all, so the eye has nothing to measure the perspective against
 * and the floor reads as a flat backdrop the fighters are pasted onto. Slabs
 * give the recession something to compress. `onBeforeCompile` keeps this a
 * `MeshStandardMaterial`, which is what keeps `receiveShadow` working; writing
 * a bespoke shader for the floor means reimplementing the shadow map, and a
 * fighting stage without cast shadows is not a trade worth making.
 *
 * ## Why the ramp is a function of depth only
 *
 * See the header. `floor luminance variation at foot height, across x < 1.4x` is
 * a measured invariant and the previous two attempts both broke it — first with
 * a point light, then with additive geometry. The wing falloff below starts at
 * |x| = 9, which is more than twice the half-width of the visible playfield, so
 * it can only ever touch the deep background corners.
 */
function makeFloor(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(120, 60, 1, 1);
  geo.rotateX(-Math.PI / 2);

  // Lambert, not Standard, and that is a measured decision rather than a
  // performance one. `MeshStandardMaterial` keeps a dielectric F0 of 0.04 that
  // no material property can switch off, and this camera looks along the floor
  // at about four degrees — so Fresnel runs to 1.0 across the entire plane and
  // the GGX lobe adds a *constant* 0.08 of linear radiance everywhere. Measured,
  // that lift more than doubled the far floor (L 58 authored, L 110 rendered)
  // while leaving the near floor alone, which flattens the depth ramp into
  // nothing and puts a uniform sheen where the value structure should be. A
  // grazing sheen is a real thing and a lovely thing; it belongs on wet
  // concrete authored on purpose, not underneath every stage by default.
  const mat = new THREE.MeshLambertMaterial({
    // Warm neutral stone. Under this rig it renders at H≈32 S≈27, which sits
    // close to skin in hue and nowhere near it in chroma — so the fighters
    // separate on saturation and value rather than fighting for the same hue.
    color: 0x8f7a63,
  });

  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFloorPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvFloorPos = (modelMatrix * vec4(position, 1.0)).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vFloorPos;
        ${NOISE_GLSL}

        float floorShade(vec3 p) {
          // Depth ramp. Solved point by point against the tone curve so the
          // floor lands on L 64 at its far edge (7 L from the sky it meets, so
          // there is no horizon seam), L 112 under the fighters, and L 148 at
          // the bottom of frame. The cubic is what keeps the bright end in the
          // near foreground where no fighter stands, instead of spreading it
          // across the fighting line and washing the roster out.
          float t = clamp((p.z + 23.0) / 28.0, 0.0, 1.0);
          float depth = 0.22 + 0.72 * pow(t, 3.2);

          // Only reaches the deep background corners: the playfield is |x| < 4.
          depth *= 1.0 - 0.45 * smoothstep(9.0, 26.0, abs(p.x));

          // Paving.
          //
          // Two things here are load-bearing and both were wrong on the first
          // pass. **Scale**: at 0.78m a slab projects to 140px at the fighting
          // line and 400 near the camera, which is not stone, it is a floor
          // tile in a rendering tutorial. **Regularity**: a perfectly square
          // grid receding to a vanishing point is the single most recognisable
          // image in 3D graphics, and putting one under the fighters undoes
          // everything the cel shading is trying to claim. So the grid is warped
          // by a low-frequency noise before it is sampled — the seams still run
          // roughly with the perspective, which is what lets the eye read the
          // recession, but no two lines are parallel and none of them are
          // straight.
          //
          // Seam contrast and per-slab jitter both fade out as a cell approaches
          // a pixel, because a sub-pixel grid does not read as stone, it reads
          // as moire crawling every time the camera moves — far more visible in
          // motion than the pattern is at rest.
          vec2 cell = p.xz / 0.42;
          cell += vec2(sNoise(p.xz * 0.31), sNoise(p.xz * 0.31 + 19.7)) * 0.55;
          vec2 w = fwidth(cell);
          float px = max(w.x, w.y);
          float detail = 1.0 - smoothstep(0.12, 0.5, px);
          vec2 f = abs(fract(cell) - 0.5);
          float aa = px * 0.9 + 1e-4;
          float seam = smoothstep(0.5 - 0.05 - aa, 0.5 - 0.05 + aa, max(f.x, f.y));
          float slab = 1.0 - seam * 0.09 * detail;
          slab *= 1.0 + (sHash(floor(cell)) - 0.5) * 0.05 * detail;
          // Two octaves of mottling. These survive at any distance and are what
          // stops the far floor going to a flat wash once the seams have faded.
          slab *= 1.0 + (sNoise(p.xz * 0.42) - 0.5) * 0.10;
          slab *= 1.0 + (sNoise(p.xz * 1.90) - 0.5) * 0.06 * detail;

          return depth * slab;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb *= floorShade(vFloorPos);',
      );
  };
  // Without this the program cache can hand a *different* MeshStandardMaterial
  // this material's compiled program, since the default key does not know about
  // an onBeforeCompile edit. The symptom is a prop elsewhere in the scene
  // rendering with the floor's paving on it.
  mat.customProgramCacheKey = () => 'bootstrap-floor-v1';

  const m = new THREE.Mesh(geo, mat);
  m.position.y = 0;
  m.receiveShadow = true;
  return m;
}

/**
 * Contact occlusion under the fighters' soles.
 *
 * One quad over the fighting line, multiplied into the floor. Multiplied and not
 * added because occlusion is a *removal* of ambient light: an additive-negative
 * patch has to know the floor's brightness to subtract the right amount, and it
 * gets it wrong twice over — it punches a hole where the floor is already in
 * cast shadow, and it barely registers on the bright near floor. A multiply is
 * correct at both ends for free.
 *
 * The falloff is `1 / (1 + (r/1.35)^2.1)` over `r = distance / radius`, which is
 * the shape a real AO integral has around a small occluder sitting on a plane:
 * no flat core, no hard edge, and a long thin tail rather than a disc. Measured
 * through the grade at the fighting line that is 38% darker than bare floor at
 * the rim of the sole, 17% at 20cm out and under 4% by half a metre — inside the
 * 15-40% the budget asks for, and small enough that it never competes with the
 * key's cast shadow for the eye.
 *
 * The tint is cool and not black: what fills a contact shadow at dusk is sky,
 * so a neutral-black patch under a warm-lit floor reads as a decal.
 */
function makeContactShadows(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(30, 16, 1, 1);
  geo.rotateX(-Math.PI / 2);

  const contacts: THREE.Vector4[] = [];
  for (let i = 0; i < MAX_CONTACTS; i++) contacts.push(new THREE.Vector4(0, 0, 0.1, 0));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.MultiplyBlending,
    // Not optional: Three only wires up the multiply blend factors on the
    // premultiplied path. Without it the pass falls back to a normal blend and
    // this quad, whose unoccluded output is vec3(1.0), paints its entire
    // footprint solid white over the floor.
    premultipliedAlpha: true,
    uniforms: {
      uContacts: { value: contacts },
      uCount: { value: 0 },
      // Multiplies scene-linear radiance, so this is the floor's colour *at
      // full occlusion*: about a quarter of its luminance, rotated cool.
      uTint: { value: new THREE.Color(0x6b86ac) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vPos;
      uniform vec4 uContacts[${MAX_CONTACTS}];
      uniform int uCount;
      uniform vec3 uTint;

      void main() {
        float occ = 0.0;
        for (int i = 0; i < ${MAX_CONTACTS}; i++) {
          if (i >= uCount) break;
          vec4 c = uContacts[i];
          float r = length(vPos.xz - c.xy) / max(c.z, 1e-3);
          // Cut off past six radii, or the tail keeps a whole-floor multiply
          // alive that costs the same and does nothing but grey the plane.
          float fade = smoothstep(9.0, 3.0, r);
          // max, not sum: two feet 20cm apart are one occluder, and adding
          // their tails would put a dark band between a fighter's legs that
          // gets darker the closer they stand.
          occ = max(occ, c.w * fade / (1.0 + pow(r / 1.35, 2.1)));
        }
        gl_FragColor = vec4(mix(vec3(1.0), uTint, clamp(occ, 0.0, 1.0)), 1.0);
      }
    `,
  });

  const m = new THREE.Mesh(geo, mat);
  // 4mm: above the floor's z-fight range and below the sole, so a foot always
  // occludes its own patch instead of the patch drawing over the foot.
  m.position.y = 0.004;
  m.renderOrder = -40;
  m.frustumCulled = false;
  return m;
}

export function buildBootstrapStage(opts: BootstrapStageOptions = {}): BootstrapStage {
  const background = new THREE.Group();
  const world = new THREE.Group();
  const foreground = new THREE.Group();

  background.add(makeSky());
  const contactMesh = makeContactShadows();
  world.add(makeFloor(), contactMesh);

  const rig = buildFightRig({
    preset: opts.preset ?? 'dusk',
    planeHalfWidth: 11,
    planeHeight: 9,
  });
  world.add(rig.group);

  const contactUniforms = (contactMesh.material as THREE.ShaderMaterial).uniforms;
  let warnedOverflow = false;

  const stage: BootstrapStage = {
    background,
    world,
    foreground,
    rig,

    setContactPoints(points: readonly ContactPoint[]): void {
      const slots = contactUniforms.uContacts.value as THREE.Vector4[];
      const n = Math.min(points.length, MAX_CONTACTS);
      if (points.length > MAX_CONTACTS && !warnedOverflow) {
        warnedOverflow = true;
        console.warn(
          `[stage] ${points.length} contact points but only ${MAX_CONTACTS} slots; ` +
            `the extras are dropped and those feet will read as hovering.`,
        );
      }
      for (let i = 0; i < n; i++) {
        const p = points[i];
        slots[i].set(p.x, p.z ?? 0, p.radius ?? 0.1, THREE.MathUtils.clamp(p.strength ?? 1, 0, 1));
      }
      contactUniforms.uCount.value = n;
    },
  };

  // The world group is what gets audited: anything a stage adds to the fighting
  // plane is in here, and a positional light among it is the one mistake that
  // silently recolours fighters by where they stand.
  rig.apply(world);
  return stage;
}
