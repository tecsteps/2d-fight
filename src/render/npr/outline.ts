import * as THREE from 'three';
import type { NPRMaterial } from './contract';
import { ToonMaterial, registerNprMaterial, unregisterNprMaterial } from './ToonMaterial';
import {
  CreaseInkMaterial,
  createCreaseInkMesh,
  type CreaseInkOptions,
} from './inkPass';

/**
 * Ink linework.
 *
 * Three cooperating passes per surface, because no single technique draws all
 * three kinds of line a hand-inked fighter needs:
 *
 * 1. **Hull** — the mesh redrawn back-faced and expanded along welded normals,
 *    giving the outer silhouette *and* every place one form occludes another
 *    (arm over torso, near shin over far shin).
 * 2. **Relief** — the same hull, coincident, pushed `reliefBias` metres deeper
 *    along the view ray and blended additively. It therefore survives *only*
 *    where whatever sits behind the line is at least that far away, i.e. on the
 *    silhouette against open sky, where it lifts the ink toward a lighter
 *    weight. Contours where a form occludes another keep the full-dark line.
 *    That difference is what stops the outline reading as a traced border.
 * 3. **Crease** (`inkPass.ts`) — a surface overlay that inks from normal and
 *    depth discontinuity, catching folds the hull cannot see at all and
 *    reinforcing the interior contour from the occluding form's own side.
 *
 * ## What was wrong before, measured
 *
 * - `polygonOffset: true / factor 1` applied a **slope-scaled** depth bias. Depth
 *   slope explodes on surfaces near-tangent to the view, which is exactly where
 *   interior contours live, so the shell was pushed metres behind the surface it
 *   was supposed to draw over and failed the depth test. Vera's inner shin had
 *   *zero* ink pixels along ~150 px of boundary. Removing the offset restored a
 *   continuous line, verified in an ink mask before and after.
 * - Weight was driven by `dot(normal, keyDir)`, so the line thickened to 7–8 px
 *   on the shadow side and thinned to 3 px on the key side of the same edge.
 *   A line that changes weight with the light is not a line, it is shading — and
 *   the wide shadow-side band is what read as a soft dark halo.
 * - `farWeight: 0.6` tapered the line with distance, which is the opposite of
 *   constant screen weight.
 * - The ink colour came from a helper that clamps saturation to 1.0, so pale
 *   skin got a fully saturated orange line, measured at (54, 5, 0) — *brighter*
 *   than the backdrop it was drawn against, which reads as a glow, not ink.
 */

export interface OutlineOptions {
  /**
   * Line weight in pixels at `referenceHeight`. Multiplied by the source
   * material's per-surface `outlineWidth` unless given explicitly.
   */
  width?: number;
  color?: THREE.ColorRepresentation;
  /**
   * Retained for API compatibility. The line is no longer a lighting term, so
   * this is only used as a fallback if `color` is absent.
   */
  litColor?: THREE.ColorRepresentation;
  /**
   * Extra weight on downward-facing edges, 0..1.5. Geometric, not lighting: an
   * inker weights the underside of a form heavily whichever way the key points.
   */
  lowerBias?: number;
  /**
   * Deprecated. Weighting the line by the key direction is what made the old
   * outline appear and disappear; defaults to 0 and is kept only so existing
   * callers still typecheck.
   */
  shadowBias?: number;
  /** Deprecated, defaults to 0. See `shadowBias`. */
  litTaper?: number;
  /** World-space direction toward the key light. Unused unless `shadowBias` > 0. */
  keyDir?: THREE.Vector3;
  /** Hard clamps in pixels so close-ups and long shots both stay legible. */
  minWidth?: number;
  maxWidth?: number;
  /** Retained; `farWeight` defaults to 1 so screen weight really is constant. */
  near?: number;
  far?: number;
  farWeight?: number;
  /** Screen height the width is authored against. */
  referenceHeight?: number;
  opacity?: number;

  /**
   * Draw the relief pass that lightens the contour against open space. Set
   * false for a uniform-weight line (cheaper by one draw call per surface).
   */
  relief?: boolean;
  /**
   * How far behind the line, in metres, the background has to be before the
   * relief lift applies. Roughly "gaps narrower than this are occlusion, and
   * occlusion gets the heavy line".
   */
  reliefBias?: number;
  /** Strength of the lift, as a multiple of the ink colour. */
  reliefLift?: number;

  /** Draw the crease overlay. See `inkPass.ts`. */
  crease?: boolean;
  creaseOptions?: CreaseInkOptions;
}

const DEFAULTS = {
  width: 3.4,
  lowerBias: 0.34,
  shadowBias: 0,
  litTaper: 0,
  keyDir: new THREE.Vector3(-5.5, 8.0, 6.0).normalize(),
  minWidth: 2.0,
  maxWidth: 5.0,
  near: 6,
  far: 22,
  farWeight: 1,
  referenceHeight: 1080,
  opacity: 1,
  reliefBias: 0.22,
  reliefLift: 0.9,
};

const vertexShader = /* glsl */ `
attribute vec3 outlineNormal;

uniform float uWidth;
uniform float uMinPx;
uniform float uMaxPx;
uniform float uPixelScale;
uniform vec2  uResolution;
uniform vec3  uKeyDir;
uniform float uLowerBias;
uniform float uShadowBias;
uniform float uLitTaper;
uniform vec2  uDepthRange;
uniform float uFarWeight;
uniform float uReliefBias;

#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>

void main() {

  #include <morphinstance_vertex>
  #include <batching_vertex>

  #include <beginnormal_vertex>
  // Swap in the welded normal. The shading normal stays split so the surface
  // shader keeps its hard edges; the hull must not, or it tears at every crease.
  objectNormal = outlineNormal;
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  #ifdef FLIP_SIDED
    // The hull is drawn back-faced, which makes Three negate the view normal.
    // Undo that, otherwise the shell contracts instead of expanding.
    transformedNormal = - transformedNormal;
  #endif

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>

  vec3 wn = normalize( mat3( modelMatrix ) * objectNormal );

  // Geometric weighting only. The underside of a form gets the heavy line the
  // way an inker draws it; nothing here reads the lighting, so the line cannot
  // fade in and out as the key moves.
  float down = saturate( - wn.y );
  float weight = uWidth * ( 1.0 + uLowerBias * down );

  // Both kept at 0 by default — see OutlineOptions. Present so a stage that
  // really wants a light-biased line can still ask for one.
  float key = dot( wn, uKeyDir );
  weight *= 1.0 + uShadowBias * saturate( - key );
  weight *= 1.0 - uLitTaper * saturate( key );

  float depth = - mvPosition.z;
  weight *= mix( 1.0, uFarWeight, smoothstep( uDepthRange.x, uDepthRange.y, depth ) );

  float px = clamp( weight, uMinPx, uMaxPx ) * uPixelScale;

  // Outward direction, in *pixels*.
  //
  // Taking the view-space normal's xy directly (the version everyone writes) is
  // wrong on any non-square viewport: projection scales x and y by different
  // amounts, so a 3 px line comes out 3 px vertically and 1.7 px horizontally at
  // 16:9. Push the normal through the projection's diagonal first, then measure
  // the direction in pixel space.
  vec2 clipDir = vec2(
    projectionMatrix[0][0] * transformedNormal.x,
    projectionMatrix[1][1] * transformedNormal.y
  );
  vec2 pxDir = clipDir * uResolution;
  float len = length( pxDir );
  pxDir = len > 1e-6 ? pxDir / len : vec2( 0.0 );

  // Undo the perspective divide with w so the offset is a fixed pixel count at
  // any distance from the camera.
  gl_Position.xy += pxDir * px * ( 2.0 / uResolution ) * gl_Position.w;

  #ifdef INK_RELIEF
    // Same pixels, deeper depth. Re-project a point uReliefBias metres further
    // down the view ray and take only its depth, leaving xy untouched, so this
    // shell is coincident with the base hull but loses the depth test unless the
    // geometry behind it is at least that far back.
    vec4 pushed = projectionMatrix * vec4( mvPosition.xy, mvPosition.z - uReliefBias, 1.0 );
    gl_Position.z = ( pushed.z / pushed.w ) * gl_Position.w;
  #endif

  #include <fog_vertex>

}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uLightingScale;
uniform float uReliefLift;
uniform vec3 uFlashColor;
uniform float uFlash;
uniform vec3 uSilhouetteColor;
uniform float uSilhouette;

#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

void main() {

  #include <logdepthbuf_fragment>

  // Flat. A constant-colour line is the whole point: the previous version mixed
  // toward a lit colour across the shell, which made the contour brighten on the
  // key side and vanish where the form caught the light.
  gl_FragColor = vec4( uColor * uLightingScale, uOpacity );

  #ifdef INK_RELIEF
    // Additive: this pass only ever lifts the line that is already there.
    gl_FragColor.rgb *= uReliefLift;
  #endif

  #include <tonemapping_fragment>

  // Same ordering as the surface shader: the ink has to reach the exact flash
  // colour, or the linework survives an impact frame as a dark ghost outline.
  #ifdef INK_RELIEF
    // The lift is additive, so on a flash it has to fall to zero rather than
    // rise to white, or the silhouette grows a bright fringe.
    gl_FragColor.rgb *= ( 1.0 - max( uFlash, uSilhouette ) );
  #else
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uFlashColor, uFlash );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, uSilhouetteColor, uSilhouette );
  #endif

  #include <colorspace_fragment>
  #include <fog_fragment>

}
`;

const _size = new THREE.Vector2();
const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Ink colour for a surface albedo.
 *
 * Deliberately *not* `ramps.inkColor`, which pushes saturation to
 * `s * 1.35 + 0.12` and clamps: any reasonably chromatic skin tone comes back
 * fully saturated, and pale skin measured (54, 5, 0) — luminance 16 against a
 * backdrop at luminance 10, so the "ink" was the brighter of the two and read as
 * a warm glow around the figure.
 *
 * The three moves that make a line read as ink rather than as an artefact:
 * hue nudged toward deep red-violet, chroma present but *bounded*, and a value
 * low enough that the line is always the darkest thing in its neighbourhood.
 */
export function surfaceInk(albedo: THREE.ColorRepresentation): THREE.Color {
  const c = new THREE.Color(albedo);
  c.getHSL(_hsl, THREE.SRGBColorSpace);

  // Toward 0.94 turn: the red-violet a brush-and-ink drawing biases to. Short
  // way round the wheel so a teal never travels through green.
  let d = 0.94 - _hsl.h;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  const h = (_hsl.h + d * 0.09 + 1) % 1;

  // Bounded, never clamped. 0.62 is about where a dark colour stops reading as
  // pigment and starts reading as a saturation bug.
  const s = Math.min(0.62, _hsl.s * 0.8 + 0.08);

  // Tracks the albedo only weakly, so a pale surface does not get a line pale
  // enough to disappear against a dark stage.
  const l = THREE.MathUtils.clamp(0.022 + 0.055 * _hsl.l, 0.02, 0.085);

  return c.setHSL(h, s, l, THREE.SRGBColorSpace);
}

export class OutlineMaterial extends THREE.ShaderMaterial implements NPRMaterial {
  referenceHeight: number;
  /** True for the additive relief shell. */
  readonly relief: boolean;

  constructor(opts: OutlineOptions & { isRelief?: boolean } = {}) {
    const color = new THREE.Color(opts.color ?? opts.litColor ?? 0x1a0f14);
    const isRelief = opts.isRelief === true;

    super({
      fog: true,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      defines: isRelief ? { INK_RELIEF: '' } : {},
      // No polygon offset. The old `factor: 1` was slope-scaled, and depth slope
      // is unbounded on surfaces near-tangent to the view — precisely where
      // interior contours are — so the shell was shoved behind the surface it
      // needed to draw over and every near-tangent interior line dropped out.
      polygonOffset: false,
      // The shell never occludes anything: every pixel it wins, it wins on the
      // strength of the surfaces' own depth. Writing depth here would also make
      // the relief pass test against the base shell instead of the background.
      depthWrite: false,
      transparent: isRelief || (opts.opacity ?? 1) < 1,
      blending: isRelief ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uColor: { value: color },
          uOpacity: { value: opts.opacity ?? DEFAULTS.opacity },
          uWidth: { value: opts.width ?? DEFAULTS.width },
          uMinPx: { value: opts.minWidth ?? DEFAULTS.minWidth },
          uMaxPx: { value: opts.maxWidth ?? DEFAULTS.maxWidth },
          uPixelScale: { value: 1 },
          uResolution: { value: new THREE.Vector2(1920, 1080) },
          uKeyDir: { value: (opts.keyDir ?? DEFAULTS.keyDir).clone().normalize() },
          uLowerBias: { value: opts.lowerBias ?? DEFAULTS.lowerBias },
          uShadowBias: { value: opts.shadowBias ?? DEFAULTS.shadowBias },
          uLitTaper: { value: opts.litTaper ?? DEFAULTS.litTaper },
          uDepthRange: {
            value: new THREE.Vector2(opts.near ?? DEFAULTS.near, opts.far ?? DEFAULTS.far),
          },
          uFarWeight: { value: opts.farWeight ?? DEFAULTS.farWeight },
          uReliefBias: { value: opts.reliefBias ?? DEFAULTS.reliefBias },
          uReliefLift: { value: opts.reliefLift ?? DEFAULTS.reliefLift },
          uLightingScale: { value: 1 },
          uFlashColor: { value: new THREE.Color(0xffffff) },
          uFlash: { value: 0 },
          uSilhouetteColor: { value: new THREE.Color(0xffffff) },
          uSilhouette: { value: 0 },
        },
      ]),
    });

    this.type = 'OutlineMaterial';
    this.relief = isRelief;
    this.referenceHeight = opts.referenceHeight ?? DEFAULTS.referenceHeight;
    registerNprMaterial(this);
  }

  /** Line weight in pixels at the reference height. */
  setWidth(px: number): void {
    this.uniforms.uWidth.value = px;
  }

  /** World-space direction toward the key light. Inert unless `shadowBias` > 0. */
  setKeyDirection(dir: THREE.Vector3): void {
    (this.uniforms.uKeyDir.value as THREE.Vector3).copy(dir).normalize();
  }

  setFlash(color: THREE.ColorRepresentation, amount: number): void {
    (this.uniforms.uFlashColor.value as THREE.Color).set(color);
    this.uniforms.uFlash.value = amount;
  }

  setLightingScale(scale: number): void {
    // Ink is nearly black, so dimming it linearly makes it vanish long before
    // the surface does. Holding most of its value keeps the drawing readable
    // through a super freeze.
    this.uniforms.uLightingScale.value = 0.35 + 0.65 * scale;
  }

  setSilhouette(color: THREE.ColorRepresentation, amount: number): void {
    (this.uniforms.uSilhouetteColor.value as THREE.Color).set(color);
    this.uniforms.uSilhouette.value = amount;
  }

  override onBeforeRender(
    renderer: THREE.WebGLRenderer,
    _scene: THREE.Scene,
    _camera: THREE.Camera,
    _geometry: THREE.BufferGeometry,
    _object: THREE.Object3D,
    _group: THREE.Group,
  ): void {
    // Line weight is a screen-space quantity, so it has to track the drawing
    // buffer rather than be configured once and go stale on resize.
    renderer.getDrawingBufferSize(_size);
    (this.uniforms.uResolution.value as THREE.Vector2).copy(_size);
    this.uniforms.uPixelScale.value = _size.y / this.referenceHeight;
  }

  override dispose(): void {
    unregisterNprMaterial(this);
    super.dispose();
  }
}

const _n = new THREE.Vector3();

/**
 * Adds an `outlineNormal` attribute holding position-welded average normals.
 *
 * Shading wants split normals at hard edges; a hull built on those tears open
 * along every crease, so the two live side by side. Idempotent — safe to call
 * on geometry already shared by several meshes.
 */
export function computeOutlineNormals(geometry: THREE.BufferGeometry, force = false): void {
  if (!force && geometry.getAttribute('outlineNormal')) return;
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();

  const pos = geometry.getAttribute('position');
  const nrm = geometry.getAttribute('normal');
  const count = pos.count;
  const out = new Float32Array(count * 3);

  // 0.1 mm welding tolerance: tight enough to keep genuinely separate shells
  // apart, loose enough to catch seam duplicates from UV or smoothing splits.
  const q = 10000;
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }

  for (const bucket of buckets.values()) {
    _n.set(0, 0, 0);
    for (const i of bucket) {
      _n.x += nrm.getX(i);
      _n.y += nrm.getY(i);
      _n.z += nrm.getZ(i);
    }

    // A perfectly opposed pair (a zero-thickness fin) averages to nothing; fall
    // back to each vertex's own normal rather than collapsing the hull.
    const degenerate = _n.lengthSq() < 1e-10;
    if (!degenerate) _n.normalize();
    for (const i of bucket) {
      const o = i * 3;
      out[o] = degenerate ? nrm.getX(i) : _n.x;
      out[o + 1] = degenerate ? nrm.getY(i) : _n.y;
      out[o + 2] = degenerate ? nrm.getZ(i) : _n.z;
    }
  }

  geometry.setAttribute('outlineNormal', new THREE.BufferAttribute(out, 3));
}

function firstMaterial(mesh: THREE.Mesh): THREE.Material | undefined {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}

/** Marker so a second `addOutlines` pass does not stack a second shell. */
const INK_FLAG = 'nprInk';
/** Companion passes hung off the returned hull, so one removal frees all three. */
const INK_COMPANIONS = 'nprInkCompanions';

/** Clones `mesh` as a skin-bound or plain mesh sharing its geometry. */
function shellFor(mesh: THREE.Mesh, material: THREE.Material, suffix: string): THREE.Mesh {
  let shell: THREE.Mesh;
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const src = mesh as THREE.SkinnedMesh;
    const skinned = new THREE.SkinnedMesh(src.geometry, material);
    skinned.bindMode = src.bindMode;
    skinned.bind(src.skeleton, src.bindMatrix);
    shell = skinned;
  } else {
    shell = new THREE.Mesh(mesh.geometry, material);
  }

  shell.name = mesh.name ? `${mesh.name}:${suffix}` : suffix;
  shell.userData[INK_FLAG] = true;
  // Not a light blocker — casting from it would double every shadow and
  // receiving would light a flat colour for no reason.
  shell.castShadow = false;
  shell.receiveShadow = false;
  shell.frustumCulled = mesh.frustumCulled;
  shell.renderOrder = mesh.renderOrder;
  // Identity transform under the source, so it inherits the world matrix, the
  // skeleton bind, and — usefully — visibility.
  shell.matrixAutoUpdate = false;
  mesh.add(shell);
  return shell;
}

/**
 * Builds the ink for one mesh and parents it to that mesh.
 *
 * Geometry is *shared*, not cloned: every pass is the same vertices drawn with a
 * different material, so the ink can never desync from the pose and costs no
 * extra memory.
 *
 * Returns the hull. The relief and crease passes are recorded in the hull's
 * `userData` so `removeOutlineMesh` frees all of them together.
 */
export function createOutlineMesh(mesh: THREE.Mesh, opts: OutlineOptions = {}): THREE.Mesh {
  computeOutlineNormals(mesh.geometry);

  const src = firstMaterial(mesh);
  const toon = src instanceof ToonMaterial ? src : null;
  const albedo = (toon?.uniforms.uColor.value as THREE.Color | undefined) ?? null;

  const width = opts.width ?? DEFAULTS.width * (toon?.outlineWidth ?? 1);
  // Per-surface albedo first, then the material's own suggestion, then a
  // neutral. `toon.outlineColor` comes from `ramps.inkColor`, whose saturation
  // clamp is what produced the neon contour, so it is the fallback rather than
  // the source.
  const color =
    opts.color ?? (albedo ? surfaceInk(albedo) : (toon?.outlineColor ?? new THREE.Color(0x1a0f14)));

  const hull = shellFor(mesh, new OutlineMaterial({ ...opts, width, color }), 'ink');
  const companions: THREE.Mesh[] = [];

  if (opts.relief !== false) {
    const relief = shellFor(
      mesh,
      new OutlineMaterial({ ...opts, width, color, isRelief: true }),
      'ink:relief',
    );
    companions.push(relief);
  }

  if (opts.crease !== false) {
    companions.push(createCreaseInkMesh(mesh, opts.creaseOptions));
  }

  hull.userData[INK_COMPANIONS] = companions;
  return hull;
}

/**
 * Inks every mesh under `root` that carries a surface asking for an outline.
 *
 * The usual entry point for a built `CharacterRig`: surfaces whose kind sets
 * `outlineWidth` to zero (stage geometry) are skipped.
 */
export function addOutlines(root: THREE.Object3D, opts: OutlineOptions = {}): THREE.Mesh[] {
  const made: THREE.Mesh[] = [];
  const targets: THREE.Mesh[] = [];

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData[INK_FLAG]) return;
    if (mesh.children.some((c) => c.userData[INK_FLAG])) return;
    const toon = firstMaterial(mesh);
    if (!toon) return;
    if (toon instanceof ToonMaterial && toon.outlineWidth <= 0) return;
    targets.push(mesh);
  });

  // Collected first: `createOutlineMesh` adds children, and mutating the graph
  // mid-traverse would have us inking our own ink.
  for (const mesh of targets) made.push(createOutlineMesh(mesh, opts));
  return made;
}

/** Removes and disposes an ink shell created by `createOutlineMesh`. */
export function removeOutlineMesh(outline: THREE.Mesh): void {
  const companions = (outline.userData[INK_COMPANIONS] as THREE.Mesh[] | undefined) ?? [];
  for (const c of companions) {
    c.removeFromParent();
    (c.material as THREE.Material).dispose();
  }
  outline.userData[INK_COMPANIONS] = [];
  outline.removeFromParent();
  (outline.material as THREE.Material).dispose();
}

export { CreaseInkMaterial, createCreaseInkMesh };
export type { CreaseInkOptions };
