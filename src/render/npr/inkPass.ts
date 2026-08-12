import * as THREE from 'three';
import type { NPRMaterial } from './contract';
import { ToonMaterial, registerNprMaterial, unregisterNprMaterial } from './ToonMaterial';

/**
 * Interior ink: the lines an inverted hull cannot draw.
 *
 * ## Why this pass exists
 *
 * A hull is a good outer silhouette and a fair occlusion contour, and it is
 * structurally incapable of anything else. Its fragments carry the depth of the
 * *back* of the form, so a contour only survives where the depth gap to whatever
 * is behind exceeds the form's own thickness. Two shins side by side at the same
 * depth have no gap at all, which is why the inner shin on all four fighters had
 * a boundary with **zero** ink pixels along it, and why fixing it by loosening a
 * depth threshold cannot work: there is no threshold that makes a gap of zero
 * pass. And a hull is blind to a crease — a fold where the surface bends sharply
 * but never turns away from the eye — because a crease casts no silhouette for
 * the shell to hug.
 *
 * ## How it works
 *
 * This pass draws *on the surface itself*, so there is no depth comparison
 * against a neighbouring form anywhere in it, and therefore **no dropout is
 * possible** at any camera angle. It multiplies rather than replaces, so the
 * line is always a darkened version of whatever colour is under it — plum-brown
 * on warm skin, near-black indigo on navy cloth — which is what makes a line
 * read as ink rather than as a composited black border.
 *
 * Three discontinuity measures, all per-fragment screen-space derivatives:
 *
 * - **Facing ratio** `|N·V|`. Zero exactly on a silhouette, interior or outer.
 *   Dividing it by its own screen-space gradient converts it into a *distance in
 *   pixels* from that silhouette, which is what makes the line a constant number
 *   of pixels wide on a near fighter and a far one, on a fingertip and on a
 *   ribcage. Thresholding `|N·V|` directly — the version everyone writes — gives
 *   a band whose width is inversely proportional to curvature, so it balloons
 *   across flat forms and vanishes on tight ones.
 * - **Normal discontinuity** `|∂N|`. Catches creases: the underside of a pec, the
 *   fold at an elbow, a knuckle break. Depth alone is blind to all of these,
 *   because the surface is continuous in depth right across the fold.
 * - **Depth gradient** `|∂z|`. How much depth this surface covers per pixel, i.e.
 *   how much of the form behind it this edge is actually occluding. It weights
 *   the line: heavy where a form overlaps another, light where a small form ends
 *   against open space.
 */

export interface CreaseInkOptions {
  /**
   * Base line width in pixels at `referenceHeight`, measured inward from the
   * silhouette it hugs.
   */
  width?: number;
  /** Extra width where the surface occludes depth, as a fraction of `width`. */
  occlusionGain?: number;
  /** Depth gradient, in metres per pixel, that counts as fully occluding. */
  occlusionScale?: number;
  /**
   * Per-channel multiplier applied at full ink. Because it multiplies the
   * surface under it, the result is always a dark tint of the local colour and
   * can never be flat black. Green is cut hardest, which is what sends the
   * residue toward plum.
   */
  tint?: THREE.ColorRepresentation;
  /** Overall opacity of the pass, 0..1. */
  strength?: number;
  /** Normal-gradient magnitude at which a crease is fully inked. */
  creaseThreshold?: number;
  /** Weight of the crease term relative to the silhouette term, 0..1. */
  creaseGain?: number;
  /**
   * How close to edge-on the surface must be before the silhouette term is
   * allowed to ink, as `|N·V|`. Bounds the pass to real edges.
   */
  facingGate?: number;
  /** Screen height `width` is authored against. */
  referenceHeight?: number;
}

const DEFAULTS = {
  width: 1.15,
  occlusionGain: 1.6,
  occlusionScale: 55,
  tint: 0x4d3340, // only reached when a caller passes no tint and no kind
  strength: 1,
  creaseThreshold: 0.85,
  creaseGain: 0.55,
  facingGate: 0.38,
  referenceHeight: 1080,
};

const vertexShader = /* glsl */ `
varying vec3 vViewNormal;
varying vec3 vViewPosition;

#include <common>
#include <batching_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>

void main() {

  #include <morphinstance_vertex>
  #include <batching_vertex>

  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>

  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>

  vViewNormal = transformedNormal;
  vViewPosition = mvPosition.xyz;

}
`;

const fragmentShader = /* glsl */ `
uniform vec3  uTint;
uniform float uStrength;
uniform float uWidth;
uniform float uPixelScale;
uniform float uOcclusionGain;
uniform float uOcclusionScale;
uniform float uCreaseThreshold;
uniform float uCreaseGain;
uniform float uFacingGate;
uniform float uFlash;
uniform float uSilhouette;
uniform float uLightingScale;

varying vec3 vViewNormal;
varying vec3 vViewPosition;

#include <common>
#include <logdepthbuf_pars_fragment>

void main() {

  #include <logdepthbuf_fragment>

  vec3 n = normalize( vViewNormal );
  vec3 v = normalize( - vViewPosition );

  // 1 facing the camera, 0 exactly on a silhouette — inner or outer, this pass
  // makes no distinction, which is the point: the arm's edge over the torso and
  // the near shin's edge over the far shin are silhouettes too.
  float facing = abs( dot( n, v ) );

  // Rate of change of the facing ratio per pixel. Dividing through by it turns the
  // facing ratio into an estimate of distance-to-silhouette in *pixels*, which
  // is the only way to get a line of constant screen weight out of a
  // surface-space quantity.
  float grad = max( fwidth( facing ), 1e-5 );
  float distPx = facing / grad;

  // Depth covered per pixel. Large where the surface is raked away from the
  // camera and therefore where it is hiding the most of whatever is behind it.
  float dz = length( vec2( dFdx( vViewPosition.z ), dFdy( vViewPosition.z ) ) );
  float occl = saturate( dz * uOcclusionScale );

  float widthPx = uWidth * uPixelScale * ( 1.0 + uOcclusionGain * occl );

  // Half a pixel of feather on the inner edge only. Any more and the line stops
  // being a line and starts being the soft dark gradient this pass replaced.
  float silhouette = 1.0 - smoothstep( widthPx - 0.75, widthPx + 0.5, distPx );

  // Gate on actually being near-tangent.
  //
  // distPx is an extrapolation: it answers "how many pixels until this surface
  // WOULD turn away", which on a broad, gently raked flank comes back small over
  // a very wide band even though no silhouette is anywhere near. Measured on
  // Vera's shadow-side flank, an ungated version darkened a 15 px band by 60%
  // — a painted shadow, not a line. Requiring the surface to be genuinely close
  // to edge-on bounds the pass to real edges.
  silhouette *= smoothstep( uFacingGate, uFacingGate * 0.3, facing );

  // Normal discontinuity: a fold that never turns away from the eye, so neither
  // the hull nor the facing term above can see it at all. Already a per-pixel
  // angular rate, so it needs no further screen-space normalisation.
  //
  // Suppressed where the surface is raked, because there the term above already
  // owns the line and a raked smooth flank produces a large normal gradient for
  // reasons that have nothing to do with a fold.
  float bend = length( fwidth( n ) );
  float crease = smoothstep( uCreaseThreshold, uCreaseThreshold * 2.4, bend )
    * uCreaseGain
    * smoothstep( uFacingGate * 0.7, uFacingGate * 1.8, facing );

  float ink = saturate( max( silhouette, crease ) ) * uStrength * uLightingScale;

  // Impact frames blow the whole fighter to one colour; ink that survived would
  // read as a dark ghost of the pose.
  ink *= 1.0 - max( uFlash, uSilhouette );

  // Multiply blend: 1.0 leaves the surface untouched, uTint darkens it. The line
  // colour is therefore derived from whatever it is drawn over, for free.
  gl_FragColor = vec4( mix( vec3( 1.0 ), uTint, ink ), 1.0 );

}
`;

const _size = new THREE.Vector2();

export class CreaseInkMaterial extends THREE.ShaderMaterial implements NPRMaterial {
  referenceHeight: number;

  constructor(opts: CreaseInkOptions = {}) {
    super({
      vertexShader,
      fragmentShader,
      side: THREE.FrontSide,
      // Drawn in the transparent pass so the full opaque depth buffer is in
      // place; it never writes depth, and it never has to, because it is
      // coincident with the surface it darkens.
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // dst = dst * src.rgb, alpha untouched. Spelled out rather than using
      // `MultiplyBlending`, which in r185 insists on premultiplied alpha and
      // logs a warning per material otherwise.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: {
        uTint: { value: new THREE.Color(opts.tint ?? DEFAULTS.tint) },
        uStrength: { value: opts.strength ?? DEFAULTS.strength },
        uWidth: { value: opts.width ?? DEFAULTS.width },
        uPixelScale: { value: 1 },
        uOcclusionGain: { value: opts.occlusionGain ?? DEFAULTS.occlusionGain },
        uOcclusionScale: { value: opts.occlusionScale ?? DEFAULTS.occlusionScale },
        uCreaseThreshold: { value: opts.creaseThreshold ?? DEFAULTS.creaseThreshold },
        uCreaseGain: { value: opts.creaseGain ?? DEFAULTS.creaseGain },
        uFacingGate: { value: opts.facingGate ?? DEFAULTS.facingGate },
        uFlash: { value: 0 },
        uSilhouette: { value: 0 },
        uLightingScale: { value: 1 },
      },
    });

    this.type = 'CreaseInkMaterial';
    this.referenceHeight = opts.referenceHeight ?? DEFAULTS.referenceHeight;
    registerNprMaterial(this);
  }

  /** Line width in pixels at the reference height. */
  setWidth(px: number): void {
    this.uniforms.uWidth.value = px;
  }

  setFlash(_color: THREE.ColorRepresentation, amount: number): void {
    // Colour is ignored on purpose: a multiply pass cannot reach a flash colour,
    // it can only get out of the way, which is exactly what is wanted.
    this.uniforms.uFlash.value = amount;
  }

  setLightingScale(scale: number): void {
    // Holds most of its weight through a dim so the drawing survives a super
    // freeze, matching how the hull behaves.
    this.uniforms.uLightingScale.value = 0.4 + 0.6 * scale;
  }

  setSilhouette(_color: THREE.ColorRepresentation, amount: number): void {
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
    renderer.getDrawingBufferSize(_size);
    this.uniforms.uPixelScale.value = _size.y / this.referenceHeight;
  }

  override dispose(): void {
    unregisterNprMaterial(this);
    super.dispose();
  }
}

/**
 * Ink tint for a surface, as a **linear-light** multiplier.
 *
 * Authored in linear rather than as a hex, because a hex would be decoded from
 * sRGB before reaching the shader and 0x53 would arrive as 0.09 rather than the
 * 0.33 it looks like — a factor of nearly four on how dark the line comes out.
 * These are the numbers the multiply actually applies.
 *
 * A flat grey multiplier would darken every hue equally and the linework would
 * read as a wash. Cutting green hardest and blue least sends the residue toward
 * red-violet, so warm skin inks to plum-brown and cool cloth to indigo, from one
 * triple per surface kind.
 */
function tintFor(kind: string | null): THREE.Color {
  const c = new THREE.Color();
  switch (kind) {
    // Skin takes the deepest line, and plum on warm skin is the single most
    // recognisable ink colour in the reference.
    case 'skin':
      return c.setRGB(0.1, 0.042, 0.062, THREE.LinearSRGBColorSpace);
    case 'wrap':
      return c.setRGB(0.2, 0.115, 0.145, THREE.LinearSRGBColorSpace);
    // Already dark; a heavy multiply here just makes a hole.
    case 'hair':
    case 'leather':
      return c.setRGB(0.26, 0.17, 0.21, THREE.LinearSRGBColorSpace);
    case 'metal':
      return c.setRGB(0.17, 0.18, 0.24, THREE.LinearSRGBColorSpace);
    default:
      return c.setRGB(0.14, 0.075, 0.105, THREE.LinearSRGBColorSpace);
  }
}

/** Marker shared with `outline.ts` so neither pass inks the other. */
const INK_FLAG = 'nprInk';

/**
 * Builds the interior-ink overlay for one mesh and parents it to that mesh.
 *
 * Shares the source geometry, so it is one extra draw call and zero extra
 * memory, and it tracks the pose through the same skeleton bind.
 */
export function createCreaseInkMesh(mesh: THREE.Mesh, opts: CreaseInkOptions = {}): THREE.Mesh {
  const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const toon = src instanceof ToonMaterial ? src : null;

  const material = new CreaseInkMaterial({
    ...opts,
    tint: opts.tint ?? tintFor(toon?.kind ?? null),
    width: opts.width ?? (DEFAULTS.width * (toon?.outlineWidth ?? 1)),
  });

  let overlay: THREE.Mesh;
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const skinnedSource = mesh as THREE.SkinnedMesh;
    const skinned = new THREE.SkinnedMesh(skinnedSource.geometry, material);
    skinned.bindMode = skinnedSource.bindMode;
    skinned.bind(skinnedSource.skeleton, skinnedSource.bindMatrix);
    overlay = skinned;
  } else {
    overlay = new THREE.Mesh(mesh.geometry, material);
  }

  overlay.name = mesh.name ? `${mesh.name}:crease` : 'crease';
  overlay.userData[INK_FLAG] = true;
  overlay.castShadow = false;
  overlay.receiveShadow = false;
  overlay.frustumCulled = mesh.frustumCulled;
  // After the surface it darkens. Transparent objects are drawn after every
  // opaque one regardless, but this keeps the intent explicit and keeps two
  // overlays on nested meshes in a defined order.
  overlay.renderOrder = mesh.renderOrder + 1;
  overlay.matrixAutoUpdate = false;
  mesh.add(overlay);

  return overlay;
}

/** Adds the interior-ink overlay to every inkable mesh under `root`. */
export function addCreaseInk(root: THREE.Object3D, opts: CreaseInkOptions = {}): THREE.Mesh[] {
  const targets: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData[INK_FLAG]) return;
    if (mesh.children.some((c) => (c as THREE.Mesh).name.endsWith(':crease'))) return;
    const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!src) return;
    if (src instanceof ToonMaterial && src.outlineWidth <= 0) return;
    targets.push(mesh);
  });
  return targets.map((m) => createCreaseInkMesh(m, opts));
}
