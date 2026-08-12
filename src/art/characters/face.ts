import * as THREE from 'three';
import type { FighterDef } from '../../data/roster';
import type { BuiltCharacter } from './rig';
import { HeadForm, faceSpec, refineHead, type FaceSpec } from './head';
import { createToonMaterial } from '../../render/npr/ToonMaterial';
import type { SurfaceKind } from '../../render/npr/contract';
import { ColorField, albedoTexture, cached, clamp01, mix, skinDetail, smoothstep } from '../textures';

/**
 * Faces: eyes, lids, lashes, brows, lips, mouth, nostrils, ear detail — and the
 * expression controls that move them.
 *
 * ## The three decisions that shape this file
 *
 * **1. Features are geometry, not paint.** A nose drawn on a sphere survives
 * exactly until the head turns, and in a fighting game the head turns on the
 * first frame. The skull, jaw, brow, nose, chin and ears live in `head.ts` and
 * are cut into the body mesh's own silhouette; everything here is the layer of
 * small forms that sits on that skin — each one built by *projecting onto the
 * sculpted surface* (`HeadForm.project`) rather than by placing it at authored
 * coordinates, so a brow can never float off a face whose brow ridge moved.
 *
 * **2. The eye is a textured globe, not a stack of discs.** Sclera, limbal ring,
 * two-tone iris, pupil and the specular catch light are five concentric shapes;
 * as geometry that is five draw calls per eye and a z-fighting problem, and as
 * one generated 128px texture on one globe it is one draw call for both eyes and
 * the iris can carry radial fibre detail no mesh would afford. The catch light
 * is painted rather than shaded because that is what makes it *reliable*: a
 * specular highlight vanishes the moment the key swings behind the fighter, and
 * an eye without a catch light is a dead eye. This is also what 2D fighting
 * games do.
 *
 * **3. Expression is morph targets, generated the same way as the base.** Every
 * part is produced by a generator taking a small parameter record; a morph
 * target is that generator run again with different parameters and stored as a
 * delta. So a squint is not a rigid rotation of a lid that slides off the
 * eyeball — it is the lid rebuilt with a narrower aperture, still projected onto
 * the same skin. Four controls are exposed: `brow`, `squint`, `mouthOpen`,
 * `snarl`, plus `blink` and `gaze` which animation wants anyway.
 *
 * ## Materials
 *
 * Face skin uses `createToonMaterial({kind:'skin'})` with the roster palette and
 * `skinDetail()`'s normal map — its *albedo* is deliberately not used, because
 * the shader multiplies `uColor * map` and `skinDetail` returns a full-tone
 * albedo, so passing both would darken the face away from the body it has to
 * match. The body's cylindrical unwrap is useless at this scale anyway; every
 * part here carries its own locally-projected UVs.
 */

// ---------------------------------------------------------------------------
// Small geometry kit
// ---------------------------------------------------------------------------

type Grid = THREE.Vector3[][];

/**
 * Accumulates quad grids into one indexed geometry, with parallel grids stored
 * as morph deltas.
 *
 * Every visible part of a face is a strip or a patch, so one builder covers all
 * of them, and merging left and right into a single geometry is what keeps the
 * whole face down to seven draw calls.
 */
class PartBuilder {
  private pos: number[] = [];
  private uvs: number[] = [];
  private idx: number[] = [];
  private morphs: number[][];

  /**
   * `outward` is a point deep inside the head. Every patch on a face points away
   * from it, so each grid's winding can be settled by measurement rather than by
   * the author guessing a `flip` flag per mirrored copy — which is exactly the
   * bug that left one eyeball back-face culled and every lash invisible.
   */
  constructor(readonly morphCount: number, private readonly outward: THREE.Vector3) {
    this.morphs = Array.from({ length: morphCount }, () => []);
  }

  /**
   * Appends one quad grid. `variants` must have one grid per morph slot, with
   * identical dimensions; pass the base grid itself for "does not move".
   */
  grid(base: Grid, variants: Grid[], uv: (r: number, c: number, rows: number, cols: number) => [number, number]): void {
    const rows = base.length;
    const cols = base[0].length;
    const v0 = this.pos.length / 3;
    const flip = this.windingFlipped(base);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const p = base[r][c];
        this.pos.push(p.x, p.y, p.z);
        const t = uv(r, c, rows, cols);
        this.uvs.push(t[0], t[1]);
        for (let m = 0; m < this.morphCount; m++) {
          const q = variants[m][r][c];
          this.morphs[m].push(q.x - p.x, q.y - p.y, q.z - p.z);
        }
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = v0 + r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        if (flip) this.idx.push(a, d, b, b, d, e);
        else this.idx.push(a, b, d, b, e, d);
      }
    }
  }

  /** True if (a,b,d) winding would face into the head for this patch. */
  private windingFlipped(base: Grid): boolean {
    const rows = base.length;
    const cols = base[0].length;
    let acc = 0;
    for (let r = 0; r + 1 < rows; r++) {
      for (let c = 0; c + 1 < cols; c++) {
        const a = base[r][c];
        const b = base[r][c + 1];
        const d = base[r + 1][c];
        _ab.subVectors(b, a);
        _ad.subVectors(d, a);
        _cr.crossVectors(_ab, _ad);
        _out.subVectors(a, this.outward);
        acc += _cr.dot(_out);
      }
    }
    return acc < 0;
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  build(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    if (this.morphCount > 0) {
      g.morphAttributes.position = this.morphs.map(
        (m) => new THREE.Float32BufferAttribute(m, 3),
      );
      g.morphTargetsRelative = true;
    }
    g.name = name;
    g.computeBoundingSphere();
    return g;
  }
}

/** A rows x cols grid of vectors, filled by `fn`. */
function makeGrid(rows: number, cols: number, fn: (r: number, c: number) => THREE.Vector3): Grid {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => fn(r, c)),
  );
}

// ---------------------------------------------------------------------------
// Placing things on the sculpted skin
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ad = new THREE.Vector3();
const _cr = new THREE.Vector3();
const _out = new THREE.Vector3();

/**
 * Where the skin is, along a ray.
 *
 * Returns the offset `h` along `dir` from `origin` at which the head surface is
 * crossed, searching outward from well inside the head. Every feature that has
 * to *lie on the face* — brow, lip, nostril, lid skirt — is placed with this
 * rather than with an authored z, so the features track the sculpt instead of
 * having to be re-tuned every time the skull changes.
 */
function skinAlong(
  form: HeadForm,
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  from: number,
  to: number,
): number {
  const steps = 26;
  let prevH = from;
  let prev = form.sd(
    origin.x + dir.x * from,
    origin.y + dir.y * from,
    origin.z + dir.z * from,
  );
  for (let i = 1; i <= steps; i++) {
    const h = from + ((to - from) * i) / steps;
    const d = form.sd(origin.x + dir.x * h, origin.y + dir.y * h, origin.z + dir.z * h);
    if (prev < 0 && d >= 0) {
      // Bisect: the surface is between prevH and h.
      let lo = prevH;
      let hi = h;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) * 0.5;
        const dm = form.sd(origin.x + dir.x * mid, origin.y + dir.y * mid, origin.z + dir.z * mid);
        if (dm < 0) lo = mid;
        else hi = mid;
      }
      return (lo + hi) * 0.5;
    }
    prev = d;
    prevH = h;
  }
  return to;
}

// ---------------------------------------------------------------------------
// The eye texture
// ---------------------------------------------------------------------------

/**
 * Sclera, limbus, two-tone iris, pupil and catch light, on one 128px disc.
 *
 * The iris is two rings — a darker outer half and a lighter inner half with
 * radial fibres — because a flat disc of colour reads as a button. The catch
 * light is a hard-edged white oval at ten o'clock with a small secondary at
 * four; two lights is what stops it reading as a sticker.
 */
function eyeTexture(spec: FaceSpec, scleraHex: number): THREE.Texture {
  const key = {
    iris: spec.irisColor,
    edge: spec.irisEdge,
    r: spec.irisR,
    pupil: spec.pupil,
    sclera: scleraHex,
  };
  return cached('faceEye', key, () => {
    const size = 128;
    const field = new ColorField(size, scleraHex);
    const iris = new THREE.Color(spec.irisColor);
    const irisDark = iris.clone().multiplyScalar(0.45);
    const irisLight = iris.clone().lerp(new THREE.Color(0xffffff), 0.34);
    const scler = new THREE.Color(scleraHex);
    const scleraShade = scler.clone().multiplyScalar(0.82);

    // The disc maps the globe cap orthographically, so an iris of angular radius
    // `irisR` lands at this fraction of the texture's half-width.
    const capAngle = 1.0;
    const rIris = Math.sin(spec.irisR) / Math.sin(capAngle);
    const rPupil = rIris * spec.pupil;

    const c = new THREE.Color();
    field.fill((_u, _v, x, y, out) => {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = 1 - (y + 0.5) / size * 2;
      const d = Math.hypot(dx, dy);

      // Sclera, shaded a little toward the outside so the globe reads round even
      // when the cel ramp gives it one flat band.
      c.copy(scler).lerp(scleraShade, smoothstep(0.35, 1.0, d));

      if (d < rIris * 1.08) {
        const t = clamp01(d / rIris);
        // Fibres: a radial ripple that only shows in the outer half.
        const ang = Math.atan2(dy, dx);
        const fib = 0.5 + 0.5 * Math.cos(ang * 34 + Math.sin(ang * 7) * 1.4);
        const body = irisDark.clone().lerp(irisLight, clamp01(1 - t * 1.05) ** 0.8);
        body.lerp(irisDark, spec.irisEdge * 0.55 * smoothstep(0.45, 1.0, t) * (0.55 + 0.45 * fib));
        // Limbal ring: a dark rim just inside the edge, which is most of what
        // makes a drawn iris look wet.
        body.lerp(new THREE.Color(0x120b0a), smoothstep(0.82, 1.0, t) * 0.85);
        const inIris = 1 - smoothstep(rIris * 0.94, rIris * 1.06, d);
        c.lerp(body, inIris);
        if (d < rPupil * 1.1) {
          c.lerp(new THREE.Color(0x08060a), 1 - smoothstep(rPupil * 0.86, rPupil * 1.08, d));
        }
      }

      // Catch lights. Hard-edged: a soft blob reads as bloom, a hard one reads
      // as a reflected window, which is what an artist draws.
      const k1 = Math.hypot((dx + 0.30) / 0.22, (dy - 0.30) / 0.19);
      const k2 = Math.hypot((dx - 0.26) / 0.10, (dy + 0.24) / 0.09);
      const spec1 = 1 - smoothstep(0.85, 1.0, k1);
      const spec2 = (1 - smoothstep(0.8, 1.0, k2)) * 0.45;
      c.lerp(new THREE.Color(0xffffff), clamp01(spec1 + spec2));

      out[0] = c.r;
      out[1] = c.g;
      out[2] = c.b;
    });

    const tex = albedoTexture(field, 'face-eye');
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  });
}

// ---------------------------------------------------------------------------
// Eye frame and aperture
// ---------------------------------------------------------------------------

/** Where an eye is and which way it points. */
interface Eye {
  side: number;
  /** Globe centre, world. */
  c: THREE.Vector3;
  /** Radius, metres. */
  r: number;
  /** Lateral axis, always toward +x, so both eyes share a texture orientation. */
  u: THREE.Vector3;
  v: THREE.Vector3;
  n: THREE.Vector3;
  /** Aperture half-width, metres. */
  A: number;
  /** Aperture half-heights, metres. */
  up: number;
  dn: number;
}

/** Outward splay of the eye axes, so the lids follow the face's curvature. */
const EYE_SPLAY = 0.3;

function makeEye(form: HeadForm, spec: FaceSpec, side: number): Eye {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), side * EYE_SPLAY);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), side * spec.eyeTilt));
  const r = form.eyeRadius;
  return {
    side,
    c: form.eyeCentre(side),
    r,
    u: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    v: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    n: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    A: r * (1.02 + 0.14 * spec.eyeOpen),
    up: r * spec.lidUpper,
    dn: r * spec.lidLower,
  };
}

/** Aperture shape parameters, varied to produce the blink and squint morphs. */
interface Aperture {
  /** 0 = fully open, 1 = shut. */
  close: number;
  /** Extra narrowing of the outer corner, for an effort squint. */
  tighten: number;
  /** Extra lid coverage from above. */
  hood: number;
}

const OPEN: Aperture = { close: 0, tighten: 0, hood: 0 };

/**
 * Upper and lower lid margin heights at outward coordinate `t` in -1..1
 * (-1 = inner canthus, +1 = outer canthus), in metres above the globe centre.
 */
function margins(eye: Eye, spec: FaceSpec, ap: Aperture): (t: number) => [number, number] {
  return (t: number) => {
    const s = clamp01(1 - t * t);
    // Upper lid: peak pushed toward the inner third, which is where a drawn eye
    // puts it; the outer end drops away faster than the inner.
    let up = eye.up * Math.pow(s, 0.4) * (1 - 0.16 * t);
    up *= 1 - (spec.hood + ap.hood) * smoothstep(-0.15, 1, t);
    // Lower lid: shallower, lowest point just outside centre.
    let dn = -eye.dn * Math.pow(s, 0.52) * (1 + 0.1 * t);
    // Closing rotates both margins toward a line a touch below centre, which is
    // where a real lid seam sits.
    const shut = -eye.r * 0.1;
    up = mix(up, shut, ap.close);
    dn = mix(dn, shut, ap.close);
    // An effort squint pinches the outer half rather than closing evenly.
    const pinch = ap.tighten * smoothstep(-0.6, 0.9, t);
    up = mix(up, shut, pinch);
    dn = mix(dn, shut, pinch * 0.55);
    return [up, dn];
  };
}

/**
 * A point of the eye region in 3D.
 *
 * `a` is lateral (signed, outward positive), `b` vertical, both in metres from
 * the globe centre in the eye's own frame. The returned point sits on whichever
 * is further forward — the globe or the skin — plus `proud` metres. That single
 * rule is what lets the lids run from the globe at the centre out onto the face
 * at the canthi without any special casing, and it is why the corners of the eye
 * do not disappear into the orbit.
 */
function eyePoint(
  form: HeadForm,
  eye: Eye,
  aOut: number,
  b: number,
  proud: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const a = eye.side * aOut;
  const rr = eye.r * 1.02;
  const q = aOut * aOut + b * b;
  const hGlobe = q < rr * rr ? Math.sqrt(rr * rr - q) : -1e9;

  _p.copy(eye.c).addScaledVector(eye.u, a).addScaledVector(eye.v, b);
  const hSkin = skinAlong(form, _p, eye.n, -eye.r * 1.6, eye.r * 2.4);
  const h = Math.max(hGlobe, hSkin) + proud;
  return out.copy(_p).addScaledVector(eye.n, h);
}

// ---------------------------------------------------------------------------
// Face assembly
// ---------------------------------------------------------------------------

const LID_ROWS = 5;
const LID_COLS = 17;

/** How far past the lid margin the skin band runs before it tucks under. */
const LID_SKIRT = 1.7;

function buildLids(form: HeadForm, spec: FaceSpec, eyes: Eye[], part: PartBuilder): void {
  const apertures: Aperture[] = [
    OPEN,
    { close: 1, tighten: 0, hood: 0 },
    { close: 0.34, tighten: 0.44, hood: 0.18 },
  ];

  for (const eye of eyes) {
    for (const upper of [true, false]) {
      const grids = apertures.map((ap) => {
        const m = margins(eye, spec, ap);
        return makeGrid(LID_ROWS, LID_COLS, (r, c) => {
          const t = (c / (LID_COLS - 1)) * 2 - 1;
          const [mu, md] = m(t);
          const edge = upper ? mu : md;
          const reach = (upper ? eye.up : eye.dn) * LID_SKIRT + eye.r * 0.5;
          const s = r / (LID_ROWS - 1);
          const b = edge + (upper ? 1 : -1) * reach * s;
          // Proud at the margin, tucking under the skin at the skirt: the lid
          // has to be in front of the globe where it is seen and behind the
          // face where it is not, or its outer edge shows as a cut.
          const proud = mix(0.0007, -0.014, smoothstep(0.16, 0.7, s));
          // Squeeze the skirt in laterally so it does not run out past the
          // orbit and reappear on the temple.
          const lat = 1 - 0.18 * s * s;
          return eyePoint(form, eye, t * eye.A * lat, b, proud);
        });
      });
      part.grid(grids[0], [grids[1], grids[2]], (r, c, rows, cols) => [c / (cols - 1), r / (rows - 1)]);
    }
  }
}

const LASH_COLS = 21;

/**
 * The upper lash line, plus a thinner lower one on the outer half.
 *
 * This is the single most load-bearing shape on the whole head: at 300–500 px a
 * fighter's eye is under ten pixels tall, and what survives is one crisp dark
 * mass with a light inside it. It is built as a band hugging the lid margin,
 * heaviest through the outer third and tapering to nothing at both canthi.
 */
function buildLashes(form: HeadForm, spec: FaceSpec, eyes: Eye[], part: PartBuilder): void {
  const apertures: Aperture[] = [
    OPEN,
    { close: 1, tighten: 0, hood: 0 },
    { close: 0.34, tighten: 0.44, hood: 0.18 },
  ];

  for (const eye of eyes) {
    for (const upper of [true, false]) {
      const grids = apertures.map((ap) => {
        const m = margins(eye, spec, ap);
        return makeGrid(3, LASH_COLS, (r, c) => {
          const t = (c / (LASH_COLS - 1)) * 2 - 1;
          const [mu, md] = m(t);
          const edge = upper ? mu : md;
          // Held near full weight almost to both canthi, then dropped fast: a
          // lash that tapers smoothly from the middle reads as a soft smudge,
          // and at gameplay size a smudge is nothing at all.
          const taper = Math.pow(clamp01(1 - t * t), 0.2);
          const weight = upper
            ? eye.r * spec.lashWeight * (0.78 + 0.34 * smoothstep(-1, 0.8, t)) * taper
            : eye.r * spec.lashWeight * 0.34 * taper * smoothstep(-0.85, 0.2, t);
          const s = r / 2;
          const b = edge + (upper ? 1 : -1) * weight * s - (upper ? 1 : -1) * weight * 0.22;
          const proud = mix(0.0011, 0.0006, s);
          return eyePoint(form, eye, t * eye.A * (1 - 0.02 * s), b, proud);
        });
      });
      part.grid(grids[0], [grids[1], grids[2]], (r, c, rows, cols) => [c / (cols - 1), r / (rows - 1)]);
    }
  }
}

const EYE_RINGS = 8;
const EYE_SEGS = 22;

/** Both globes, as spherical caps carrying the generated eye texture. */
function buildGlobes(spec: FaceSpec, eyes: Eye[], part: PartBuilder): void {
  const capAngle = 1.0;
  for (const eye of eyes) {
    const grid = makeGrid(EYE_RINGS, EYE_SEGS + 1, (r, c) => {
      const e = (r / (EYE_RINGS - 1)) * capAngle;
      const phi = (c / EYE_SEGS) * Math.PI * 2;
      const se = Math.sin(e);
      return new THREE.Vector3()
        .copy(eye.c)
        .addScaledVector(eye.n, eye.r * Math.cos(e))
        .addScaledVector(eye.u, eye.r * se * Math.cos(phi))
        .addScaledVector(eye.v, eye.r * se * Math.sin(phi));
    });
    part.grid(
      grid,
      [],
      (r, c) => {
        const e = (r / (EYE_RINGS - 1)) * capAngle;
        const phi = (c / EYE_SEGS) * Math.PI * 2;
        const rad = Math.sin(e) / Math.sin(capAngle);
        // Gaze offset lives in the texture lookup, not in the mesh, so both eyes
        // can share one draw call and still both look at the camera.
        return [0.5 + 0.5 * rad * Math.cos(phi), 0.5 + 0.5 * rad * Math.sin(phi)];
      },
    );
  }
}

const BROW_COLS = 15;

/**
 * Brow ribbons, lying on the brow ridge.
 *
 * Two morphs: raised, and lowered-and-drawn-together. Both are regenerated
 * against the skin rather than being a rigid rotation, so an angry brow stays
 * welded to the face instead of sinking into it at one end.
 */
function buildBrows(form: HeadForm, spec: FaceSpec, eyes: Eye[], part: PartBuilder): void {
  const HL = form.HL;
  const variants = [
    { lift: 0, anger: 0 },
    { lift: 1, anger: 0 },
    { lift: 0, anger: 1 },
  ];

  for (const eye of eyes) {
    const grids = variants.map((vv) => {
      const base = (spec.browY - spec.eyeY) * HL;
      return makeGrid(5, BROW_COLS, (r, c) => {
        const t = (c / (BROW_COLS - 1)) * 2 - 1;
        const s = clamp01(1 - t * t);
        // Ribbon centre line: base height, plus arch, tilt, and the expression.
        let b =
          base +
          spec.browArch * HL * Math.pow(s, 0.7) * (0.5 + 0.5 * smoothstep(-1, 0.4, t)) +
          spec.browTilt * HL * t;
        b += vv.lift * HL * 0.055;
        // Anger drops the inner end hard and the outer end a little: the shape
        // of the brow changes, which is what reads, not its height.
        b -= vv.anger * HL * (0.055 - 0.032 * smoothstep(-1, 1, t));
        const th = spec.browThick * HL * (0.42 + 0.58 * Math.pow(s, 0.5)) * (1 - 0.3 * smoothstep(0.2, 1, t));
        const rr = (r / 4) * 2 - 1;
        const proud = mix(0.0016, -0.0012, Math.abs(rr));
        // Both ends are measured *outward from the eye*, so the inner end is a
        // negative coordinate — it sits between the eye and the midline. Reading
        // `browInner` as an outward offset instead put the whole brow outside
        // the eye and produced a 10 mm diagonal splinter.
        const aIn = (spec.browInner - spec.eyeX) * HL + vv.anger * HL * 0.014;
        const aOut = eye.A * spec.browLen * 1.15;
        const a = aIn + (aOut - aIn) * ((t + 1) / 2);
        return eyePoint(form, eye, a, b + th * rr, proud);
      });
    });
    part.grid(grids[0], [grids[1], grids[2]], (r, c, rows, cols) => [c / (cols - 1), r / (rows - 1)]);
  }
}

// --- mouth -----------------------------------------------------------------

interface MouthState {
  open: number;
  snarl: number;
}

const MOUTH_COLS = 19;

/**
 * The mouth region, in a local frame on the front of the face.
 *
 * `a` is lateral, `b` vertical from the lip seam. Points land on the skin the
 * same way the brows do, so the lips follow the sculpt's lip mound instead of
 * hovering in front of it.
 */
function mouthPoint(
  form: HeadForm,
  spec: FaceSpec,
  a: number,
  b: number,
  proud: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const HL = form.HL;
  _p.set(a, form.y0 + (spec.mouthY * HL) + b, form.z0 - 0.05 * HL);
  _n.set(0, 0, 1);
  const h = skinAlong(form, _p, _n, 0, 0.42 * HL);
  return out.copy(_p).addScaledVector(_n, h + proud);
}

function buildLips(form: HeadForm, spec: FaceSpec, part: PartBuilder): void {
  const HL = form.HL;
  const W = spec.mouthW * HL;
  const states: MouthState[] = [
    { open: 0, snarl: 0 },
    { open: 1, snarl: 0 },
    { open: 0, snarl: 1 },
  ];

  for (const upper of [true, false]) {
    const grids = states.map((st) => {
      const h0 = spec.lipFull * HL * (upper ? 0.038 : 0.045);
      return makeGrid(4, MOUTH_COLS, (r, c) => {
        const t = (c / (MOUTH_COLS - 1)) * 2 - 1;
        const s = clamp01(1 - t * t);
        // The seam bows down at the corners; a straight seam reads as a slot.
        const seam = -Math.pow(Math.abs(t), 2.2) * HL * 0.012;
        // Cupid's bow: a dip at the midline on the upper lip's top edge.
        const bow = upper ? 1 - 0.22 * Math.exp(-((t / 0.22) ** 2)) : 1;
        const outer = upper
          ? seam + h0 * Math.pow(s, 0.4) * bow
          : seam - h0 * Math.pow(s, 0.45);
        // Opening drops the lower lip a long way and lifts the upper a little,
        // which is how a drawn mouth opens — the jaw does not have to move.
        const openShift = upper ? st.open * HL * 0.03 : -st.open * HL * 0.085;
        const snarlShift = upper ? st.snarl * HL * 0.038 : -st.snarl * HL * 0.012;
        const lift = (openShift + snarlShift) * Math.pow(s, 0.45);
        const rr = r / 3;
        const b = mix(seam, outer, rr) + lift * mix(0.35, 1, rr);
        const proud = mix(-0.0016, 0.0014, Math.pow(rr, 0.6)) * (0.3 + 0.7 * s);
        return mouthPoint(form, spec, t * W, b, proud);
      });
    });
    part.grid(grids[0], [grids[1], grids[2]], (r, c, rows, cols) => [c / (cols - 1), r / (rows - 1)]);
  }
}

/**
 * The dark shapes: the oral slot and the two nostrils.
 *
 * At rest the slot is a hairline — that dark line is the mouth, and without it a
 * closed mouth is two skin-coloured mounds with nothing between them. Opening
 * inflates it into a cavity set back from the lips.
 */
function buildDarks(form: HeadForm, spec: FaceSpec, part: PartBuilder): void {
  const HL = form.HL;
  const W = spec.mouthW * HL * 0.99;
  const states: MouthState[] = [
    { open: 0, snarl: 0 },
    { open: 1, snarl: 0 },
    { open: 0, snarl: 1 },
  ];

  const grids = states.map((st) =>
    makeGrid(5, MOUTH_COLS, (r, c) => {
      const t = (c / (MOUTH_COLS - 1)) * 2 - 1;
      const s = clamp01(1 - t * t);
      const seam = -Math.pow(Math.abs(t), 2.2) * HL * 0.012;
      // Asymmetric: a mouth opens by dropping the jaw, so almost all of the
      // growth is downward. Growing it evenly pushed the dark up over the
      // philtrum and put the teeth in the middle of the hole.
      const shape = Math.pow(s, 0.4);
      const top = seam + HL * (0.006 + 0.024 * st.open + 0.02 * st.snarl) * shape;
      const bot = seam - HL * (0.006 + 0.075 * st.open + 0.006 * st.snarl) * shape;
      const b = mix(top, bot, r / 4);
      const rr = (r / 4) * 2 - 1;
      // Always proud of the skin, at rest and open alike. Setting it *behind*
      // the lips was the obvious move and it is wrong: the head has no hole in
      // it, so when the lips part what shows through the gap is cheek, and a
      // shouting fighter came out with his mouth closed. A dark shape lying on
      // the surface is also exactly how a 2D fighter draws an open mouth.
      const proud = (0.0010 + 0.0007 * st.open) * (1 - Math.abs(rr) * 0.25);
      return mouthPoint(form, spec, t * W, b, proud);
    }),
  );
  part.grid(grids[0], [grids[1], grids[2]], (r, c, rows, cols) => [c / (cols - 1), r / (rows - 1)]);

  // Nostrils: small dark lenses recessed into the nose's underside.
  //
  // Placed by nearest-point projection rather than by a ray march. The nostril
  // sits on a doubly-curved undercut where neighbouring rays exit the surface
  // metres apart in parameter space, and a march produced a patch stretched into
  // a black bar hanging off the philtrum. `project` cannot do that: it always
  // lands on the nearest skin.
  const seed = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const tanA = new THREE.Vector3();
  const tanB = new THREE.Vector3();
  for (const side of [1, -1]) {
    form.world([side * spec.noseW * 0.6, spec.noseY - 0.052, spec.noseLen - 0.055], seed);
    form.project(seed);
    form.normal(seed, nrm);
    tanA.set(1, 0, 0).addScaledVector(nrm, -nrm.x).normalize();
    tanB.crossVectors(nrm, tanA).normalize();
    const g = makeGrid(3, 11, (r, c) => {
      const th = (c / 10) * Math.PI * 2;
      const rad = r / 2;
      return new THREE.Vector3()
        .copy(seed)
        // Flat patches sitting a hair proud of the skin. Sinking the middle
        // into the surface instead makes a cone that intersects the undercut at
        // a different depth every column, which tore into a jagged blot.
        .addScaledVector(tanA, Math.cos(th) * rad * HL * 0.022)
        .addScaledVector(tanB, Math.sin(th) * rad * HL * 0.014)
        .addScaledVector(nrm, HL * 0.0015);
    });
    part.grid(g, [g, g], (r, c, rows, cols) => [c / (cols - 1), r / (rows - 1)]);
  }
}

function buildTeeth(form: HeadForm, spec: FaceSpec, part: PartBuilder): void {
  const HL = form.HL;
  const W = spec.mouthW * HL * 0.82;
  const states: MouthState[] = [
    { open: 0, snarl: 0 },
    { open: 1, snarl: 0 },
    { open: 0, snarl: 1 },
  ];
  for (const upper of [true, false]) {
    const grids = states.map((st) =>
      makeGrid(3, 13, (r, c) => {
        const t = (c / 12) * 2 - 1;
        const s = clamp01(1 - t * t);
        const seam = -Math.pow(Math.abs(t), 2.2) * HL * 0.012;
        const sign = upper ? 1 : -1;
        const height = HL * (upper ? 0.022 : 0.016) * Math.pow(s, 0.35);
        // Hung from the top / bottom edge of the cavity, so the strip reads as
        // teeth behind a lip rather than as a bar across the opening.
        const shift = upper
          ? HL * (0.024 * st.open + 0.026 * st.snarl)
          : -HL * (0.073 * st.open + 0.004 * st.snarl);
        const rr = r / 2;
        const b = seam + shift - sign * height * rr;
        // Buried at rest, brought in front of the dark when the lip lifts.
        return mouthPoint(form, spec, t * W, b, -0.012 + 0.0136 * clamp01(st.open * 0.7 + st.snarl));
      }),
    );
    part.grid(grids[0], [grids[1], grids[2]], (r, c, rows, cols) => [c / (cols - 1), r / (rows - 1)]);
  }
}

/**
 * Helix rim on each ear.
 *
 * The ear's *mass* is in the body mesh (it is the one feature that breaks the
 * head's silhouette sideways, and the silhouette is drawn from that mesh); this
 * is the raised rim that turns the mass into a recognisable ear.
 */
function buildEarDetail(form: HeadForm, spec: FaceSpec, part: PartBuilder): void {
  const HL = form.HL;
  const es = spec.earSize;
  for (const side of [1, -1]) {
    const c = form.earCentre(side);
    const g = makeGrid(3, 15, (r, cc) => {
      // Open C, from the top front, round the back, down to the lobe.
      const t = cc / 14;
      const th = -1.15 + t * 4.5;
      const ry = 0.082 * es * HL;
      const rz = 0.052 * es * HL;
      const rad = 1 - (r / 2) * 0.34;
      _p.set(
        side * (form.hw * HL),
        c.y + Math.cos(th) * ry * rad,
        c.z + Math.sin(th) * rz * rad,
      );
      _n.set(side, 0, 0);
      const h = skinAlong(form, _p, _n, -0.2 * HL, 0.16 * HL);
      return new THREE.Vector3().copy(_p).addScaledVector(_n, h + HL * 0.004 * (1 - r / 2));
    });
    part.grid(g, [g, g], (r, cc, rows, cols) => [cc / (cols - 1), r / (rows - 1)]);
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** The named expression channels animation drives. All 0..1 unless noted. */
export interface FaceValues {
  /** -1 = furrowed and drawn together, +1 = raised. */
  brow: number;
  /** Effort/pain narrowing of the eyes. */
  squint: number;
  /** 0 = shut, 1 = shouting. */
  mouthOpen: number;
  /** Lip pulled off the teeth. */
  snarl: number;
  /** Full lid closure, for blinks and knockdowns. */
  blink: number;
}

export interface FaceControls extends FaceValues {
  set(name: keyof FaceValues, value: number): void;
  get(name: keyof FaceValues): number;
  /** Push the current values onto the morph influences. */
  update(): void;
  /** Everything at rest. */
  reset(): void;
  root: THREE.Object3D;
}

const REST: FaceValues = { brow: 0, squint: 0, mouthOpen: 0, snarl: 0, blink: 0 };

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Slightly warm off-white; a pure white sclera reads as plastic. */
const SCLERA = 0xf2ece3;

function faceMaterial(
  kind: SurfaceKind,
  color: THREE.ColorRepresentation,
  def: FighterDef,
  opts: { map?: THREE.Texture; normalMap?: THREE.Texture; outline?: number; specular?: number } = {},
): THREE.Material {
  return createToonMaterial({
    kind,
    color,
    shadowColor: def.palette.skinShadow,
    sssColor: def.palette.skinSSS,
    rimColor: def.palette.rim,
    map: opts.map ?? null,
    normalMap: opts.normalMap ?? null,
    normalScale: 0.55,
    specular: opts.specular,
    // Everything on the face is inside the head's own silhouette, so a second
    // ink shell per part buys nothing and costs three draw calls each.
    outlineWidth: opts.outline ?? 0,
  }) as unknown as THREE.Material;
}

/**
 * Builds the face onto an already-built fighter.
 *
 * **Wiring:** call this from `buildCharacter` right after the body mesh is bound
 * and *before* `addOutlines`, because it re-sculpts the body's head vertices and
 * the ink hull caches a welded normal off that geometry. It repairs the cached
 * normal if it has already run, so a late call is wasteful rather than broken.
 *
 * The returned group is parented to the head bone, so the whole face rides the
 * skeleton with no skinning of its own — a head is rigid, and rigid parts under
 * a bone cost nothing to deform.
 */
export function buildFace(rig: BuiltCharacter, def: FighterDef = rig.def): THREE.Object3D {
  const spec = faceSpec(def);
  const { form } = refineHead(rig, spec);
  const HL = form.HL;

  const root = new THREE.Group();
  root.name = `${def.id}:face`;
  // The head bone's rest transform is a pure translation to the head joint, so
  // undoing that translation lets every part below be authored in the same
  // world-rest coordinates the sculpt uses.
  root.position.copy(rig.joints.head).negate();
  rig.bones.head.add(root);

  const eyes = [makeEye(form, spec, 1), makeEye(form, spec, -1)];
  const p = def.palette;

  const detail = skinDetail({
    tone: p.skin,
    sss: p.skinSSS,
    freckles: spec.freckles,
    freckleColor: 0x9a5334,
    micro: 0.5,
    pores: 0.4,
    tileMetres: 0.11,
    resolution: 256,
    seed: 700 + def.id.charCodeAt(0),
  });

  const skinMat = faceMaterial('skin', p.skin, def, { normalMap: detail.normalMap });
  const lipColor = new THREE.Color(p.skin).lerp(new THREE.Color(p.skinSSS), spec.lipTint);
  const lipMat = faceMaterial('skin', lipColor, def, { normalMap: detail.normalMap });
  const lashColor = new THREE.Color(p.hair).multiplyScalar(0.42).lerp(new THREE.Color(0x090608), 0.5);
  const lashMat = faceMaterial('hair', lashColor, def, { specular: 0.05 });
  const browMat = faceMaterial('hair', new THREE.Color(p.hair).multiplyScalar(0.82), def);
  const eyeMat = faceMaterial('wrap', 0xffffff, def, {
    map: eyeTexture(spec, SCLERA),
    specular: 0.12,
  });
  const darkMat = faceMaterial('leather', 0x2a1218, def, { specular: 0 });
  const teethMat = faceMaterial('wrap', 0xe8e2d8, def, { specular: 0.1 });

  const parts: { name: string; part: PartBuilder; mat: THREE.Material; order: number }[] = [];
  const inside = form.world([0, 0.55, -0.05]);
  const add = (name: string, morphs: number, mat: THREE.Material, order: number, fn: (b: PartBuilder) => void) => {
    const b = new PartBuilder(morphs, inside);
    fn(b);
    if (!b.empty) parts.push({ name, part: b, mat, order });
  };

  // Draw order matters where surfaces are within a millimetre of each other.
  add('globes', 0, eyeMat, 0, (b) => buildGlobes(spec, eyes, b));
  add('darks', 2, darkMat, 0, (b) => buildDarks(form, spec, b));
  add('teeth', 2, teethMat, 0, (b) => buildTeeth(form, spec, b));
  add('skin', 2, skinMat, 1, (b) => {
    buildLids(form, spec, eyes, b);
    buildEarDetail(form, spec, b);
  });
  add('lips', 2, lipMat, 1, (b) => buildLips(form, spec, b));
  add('lashes', 2, lashMat, 2, (b) => buildLashes(form, spec, eyes, b));
  add('brows', 2, browMat, 2, (b) => buildBrows(form, spec, eyes, b));

  const meshes: THREE.Mesh[] = [];
  for (const { name, part, mat, order } of parts) {
    const mesh = new THREE.Mesh(part.build(`${def.id}:${name}`), mat);
    mesh.name = `${def.id}:face:${name}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = order;
    root.add(mesh);
    meshes.push(mesh);
  }

  const byName = new Map(meshes.map((m) => [m.name.split(':').pop() as string, m]));
  const setMorph = (part: string, slot: number, value: number): void => {
    const m = byName.get(part);
    if (m?.morphTargetInfluences) m.morphTargetInfluences[slot] = value;
  };

  const controls: FaceControls = {
    ...REST,
    root,
    set(name, value) {
      (controls as unknown as Record<string, number>)[name] = value;
      controls.update();
    },
    get(name) {
      return controls[name];
    },
    reset() {
      Object.assign(controls, REST);
      controls.update();
    },
    update() {
      const blink = clamp01(controls.blink);
      const squint = clamp01(controls.squint);
      // A blink swallows a squint rather than adding to it, or a squinting
      // fighter blinking pushes the lid through the cheek.
      const sq = squint * (1 - blink);
      for (const part of ['skin', 'lashes']) {
        setMorph(part, 0, blink);
        setMorph(part, 1, sq);
      }
      const up = clamp01(controls.brow);
      const down = clamp01(-controls.brow);
      setMorph('brows', 0, up);
      // A squint pulls the brow down with it; a face that squints with level
      // brows reads as sleepy rather than as effort.
      setMorph('brows', 1, Math.max(down, sq * 0.45));
      const open = clamp01(controls.mouthOpen);
      const snarl = clamp01(controls.snarl);
      for (const part of ['lips', 'darks', 'teeth']) {
        setMorph(part, 0, open);
        setMorph(part, 1, snarl);
      }
    },
  };
  controls.update();

  root.userData.face = controls;
  rig.root.userData.face = controls;
  rig.triangles += meshes.reduce((n, m) => n + (m.geometry.getIndex()?.count ?? 0) / 3, 0);
  void HL;
  return root;
}

/** The controls for a fighter whose face has been built, if it has one. */
export function faceControls(rig: BuiltCharacter): FaceControls | undefined {
  return rig.root.userData.face as FaceControls | undefined;
}

export { faceSpec } from './head';
export type { FaceSpec } from './head';
