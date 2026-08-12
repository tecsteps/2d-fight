import * as THREE from 'three';
import type { NPRMaterial } from './contract';
import { ToonMaterial, registerNprMaterial, unregisterNprMaterial } from './ToonMaterial';
import { inkColor } from './ramps';

/**
 * Ink linework.
 *
 * Inverted hull: the mesh is drawn a second time with back faces only, expanded
 * along smoothed normals, so what survives the depth test is a shell of dark
 * pixels hugging the silhouette and every interior fold.
 *
 * Three details separate this from the version everyone writes first:
 *
 * 1. **Constant screen weight.** The expansion happens in clip space, scaled by
 *    `w`, so a line is the same number of pixels whether the fighter is in a
 *    close-up intro or at full stage distance. Expanding in world space instead
 *    is why so many toon shaders have lines that balloon on zoom-in.
 * 2. **Welded normals.** A hull built on split (hard-edge) normals tears open at
 *    every crease. `computeOutlineNormals` averages normals across coincident
 *    vertices into a separate attribute, leaving the shading normals untouched.
 * 3. **Varying weight.** A uniform-weight outline is the single loudest tell of
 *    programmer art. Real linework is heaviest under the form and on the shadow
 *    side and thins out into the light, which is what `lowerBias`, `shadowBias`
 *    and `litTaper` reproduce.
 */

export interface OutlineOptions {
  /**
   * Line weight in pixels at `referenceHeight`. Multiplied by the source
   * material's per-surface `outlineWidth` unless given explicitly.
   */
  width?: number;
  color?: THREE.ColorRepresentation;
  /**
   * Colour the line trends toward where the surface faces the key. Defaults to
   * a lift of `color`; ink that picks up a little light stops the fighter
   * looking like a sticker.
   */
  litColor?: THREE.ColorRepresentation;
  /** Extra weight on downward-facing edges, 0..1.5. */
  lowerBias?: number;
  /** Extra weight on edges turned away from the key, 0..1.5. */
  shadowBias?: number;
  /** How much the line thins where it faces the key, 0..1. */
  litTaper?: number;
  /** World-space direction toward the key light. */
  keyDir?: THREE.Vector3;
  /** Hard clamps in pixels so close-ups and long shots both stay legible. */
  minWidth?: number;
  maxWidth?: number;
  /** View distances over which the line tapers to `farWeight`. */
  near?: number;
  far?: number;
  farWeight?: number;
  /** Screen height the width is authored against. */
  referenceHeight?: number;
  opacity?: number;
}

const DEFAULTS = {
  width: 4.2,
  lowerBias: 0.5,
  shadowBias: 0.3,
  litTaper: 0.22,
  keyDir: new THREE.Vector3(-5.5, 8.0, 6.0).normalize(),
  minWidth: 1.7,
  maxWidth: 12.0,
  near: 6,
  far: 22,
  farWeight: 0.6,
  referenceHeight: 1080,
  opacity: 1,
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

varying float vLit;

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
  float key = dot( wn, uKeyDir );
  vLit = saturate( key * 0.5 + 0.5 );

  // Weight the line the way a inker would: heavy underneath, heavy on the side
  // turned from the light, thinning to a hairline where the form catches it.
  float down = saturate( - wn.y );
  float away = saturate( - key );
  float weight = uWidth
    * ( 1.0 + uLowerBias * down + uShadowBias * away )
    * ( 1.0 - uLitTaper * saturate( key ) );

  // Long shots get a lighter line — a full-weight outline on a small figure
  // crawls and aliases, and reads as noise rather than as drawing.
  float depth = - mvPosition.z;
  weight *= mix( 1.0, uFarWeight, smoothstep( uDepthRange.x, uDepthRange.y, depth ) );

  float px = clamp( weight * uPixelScale, uMinPx * uPixelScale, uMaxPx * uPixelScale );

  // Expand in clip space, undoing the perspective divide with w, so the line is
  // a fixed number of pixels at any distance.
  vec2 dir = transformedNormal.xy;
  float len = length( dir );
  dir = len > 1e-5 ? dir / len : vec2( 0.0 );
  gl_Position.xy += dir * ( px * 2.0 / uResolution ) * gl_Position.w;

  #include <fog_vertex>

}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uLitColor;
uniform float uOpacity;
uniform float uLightingScale;
uniform vec3 uFlashColor;
uniform float uFlash;
uniform vec3 uSilhouetteColor;
uniform float uSilhouette;

varying float vLit;

#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

void main() {

  #include <logdepthbuf_fragment>

  gl_FragColor = vec4( mix( uColor, uLitColor, vLit ) * uLightingScale, uOpacity );

  #include <tonemapping_fragment>

  // Same ordering as the surface shader: the ink has to reach the exact flash
  // colour, or the linework survives an impact frame as a dark ghost outline.
  gl_FragColor.rgb = mix( gl_FragColor.rgb, uFlashColor, uFlash );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, uSilhouetteColor, uSilhouette );

  #include <colorspace_fragment>
  #include <fog_fragment>

}
`;

const _size = new THREE.Vector2();

export class OutlineMaterial extends THREE.ShaderMaterial implements NPRMaterial {
  referenceHeight: number;

  constructor(opts: OutlineOptions = {}) {
    const color = new THREE.Color(opts.color ?? 0x140b12);
    // Lifted by a scalar, never lerped toward white: ink is so dark in linear
    // light that even a 15% lerp lands it in mid grey, and a grey outline reads
    // as a rendering artefact rather than as a drawn line.
    const lit = opts.litColor ? new THREE.Color(opts.litColor) : color.clone().multiplyScalar(1.35);

    super({
      fog: true,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      // Nudge the shell behind the surface it wraps. Without it the hull and the
      // fill land on the same depth at the silhouette and stipple against
      // each other.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uColor: { value: color },
          uLitColor: { value: lit },
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
          uLightingScale: { value: 1 },
          uFlashColor: { value: new THREE.Color(0xffffff) },
          uFlash: { value: 0 },
          uSilhouetteColor: { value: new THREE.Color(0xffffff) },
          uSilhouette: { value: 0 },
        },
      ]),
    });

    this.type = 'OutlineMaterial';
    this.referenceHeight = opts.referenceHeight ?? DEFAULTS.referenceHeight;
    this.transparent = (opts.opacity ?? 1) < 1;
    registerNprMaterial(this);
  }

  /** Line weight in pixels at the reference height. */
  setWidth(px: number): void {
    this.uniforms.uWidth.value = px;
  }

  /** World-space direction toward the key light; drives the weight variation. */
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

/**
 * Builds the ink shell for one mesh and parents it to that mesh.
 *
 * Geometry is *shared*, not cloned: the hull is the same vertices drawn with a
 * different material, so a skinned fighter costs one extra draw call and zero
 * extra memory, and the ink can never desync from the pose.
 *
 * Width and colour default to the source `ToonMaterial`'s per-surface
 * suggestions, so a quilted vest gets a heavier line than a hand wrap without
 * the caller having to know that.
 */
export function createOutlineMesh(mesh: THREE.Mesh, opts: OutlineOptions = {}): THREE.Mesh {
  computeOutlineNormals(mesh.geometry);

  const src = firstMaterial(mesh);
  const toon = src instanceof ToonMaterial ? src : null;

  const material = new OutlineMaterial({
    ...opts,
    width: opts.width ?? DEFAULTS.width * (toon?.outlineWidth ?? 1),
    color: opts.color ?? toon?.outlineColor ?? inkColor(0x2a2028),
  });

  let outline: THREE.Mesh;
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const skinnedSource = mesh as THREE.SkinnedMesh;
    const skinned = new THREE.SkinnedMesh(skinnedSource.geometry, material);
    skinned.bindMode = skinnedSource.bindMode;
    skinned.bind(skinnedSource.skeleton, skinnedSource.bindMatrix);
    outline = skinned;
  } else {
    outline = new THREE.Mesh(mesh.geometry, material);
  }

  outline.name = mesh.name ? `${mesh.name}:ink` : 'ink';
  outline.userData[INK_FLAG] = true;
  // The shell is not a light blocker — casting from it would double every
  // shadow and receiving would light a flat colour for no reason.
  outline.castShadow = false;
  outline.receiveShadow = false;
  outline.frustumCulled = mesh.frustumCulled;
  outline.renderOrder = mesh.renderOrder;

  // Parented to the source with an identity transform, so it inherits the world
  // matrix, the skeleton bind, and — usefully — visibility.
  outline.matrixAutoUpdate = false;
  mesh.add(outline);

  return outline;
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
  outline.removeFromParent();
  (outline.material as THREE.Material).dispose();
}
