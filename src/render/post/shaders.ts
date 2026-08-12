/**
 * Every fragment program in the post chain, as GLSL source strings.
 *
 * They are strings rather than `.glsl` files so the shared helper block below
 * can be composed into each one without a preprocessor, and so a tuning change
 * is a single-file edit. Three compiles these as GLSL ES 3.00 with the ES 1.00
 * aliases in place, which is why `texture2D` / `varying` / `gl_FragColor` still
 * appear — matching the style of Three's own passes.
 */

/** Shared by every full-screen pass; the geometry is a single oversized triangle. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const COMMON = /* glsl */ `
const float TAU = 6.28318530718;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash21(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

vec2 hash12(float n) {
  return fract(sin(vec2(n * 12.9898, n * 78.233 + 3.71)) * vec2(43758.5453, 24634.6345));
}

/** Interpolated value noise — a hard hash grid reads as digital speckle, not grain. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/**
 * Bloom downsample: the 13-tap filter from Jimenez's "Next Generation Post
 * Processing in Call of Duty".
 *
 * A plain box or bilinear downsample makes the mip chain pulse when the camera
 * moves — small bright features fall between texel centres and blink. The 13-tap
 * kernel oversamples each level so a highlight fades smoothly instead. On the
 * first level a Karis average (weight by 1/(1+luma)) kills fireflies before they
 * can propagate up the chain and become a strobing blob.
 */
export const BLOOM_DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec4 uThreshold;   // x: threshold, y: threshold-knee, z: 2*knee, w: 0.25/knee
uniform float uFirst;      // 1 on the prefilter level: threshold + Karis + chroma boost
uniform float uSaturation;
varying vec2 vUv;

${COMMON}

vec3 tap(vec2 o) { return max(texture2D(tSrc, vUv + o * uTexel).rgb, 0.0); }

float karis(vec3 c) { return 1.0 / (1.0 + luma(c)); }

void main() {
  vec3 a = tap(vec2(-2.0, -2.0));
  vec3 b = tap(vec2( 0.0, -2.0));
  vec3 c = tap(vec2( 2.0, -2.0));
  vec3 d = tap(vec2(-1.0, -1.0));
  vec3 e = tap(vec2( 1.0, -1.0));
  vec3 f = tap(vec2(-2.0,  0.0));
  vec3 g = tap(vec2( 0.0,  0.0));
  vec3 h = tap(vec2( 2.0,  0.0));
  vec3 i = tap(vec2(-1.0,  1.0));
  vec3 j = tap(vec2( 1.0,  1.0));
  vec3 k = tap(vec2(-2.0,  2.0));
  vec3 l = tap(vec2( 0.0,  2.0));
  vec3 m = tap(vec2( 2.0,  2.0));

  vec3 g0 = (d + e + i + j) * 0.25;
  vec3 g1 = (a + b + f + g) * 0.25;
  vec3 g2 = (b + c + g + h) * 0.25;
  vec3 g3 = (f + g + k + l) * 0.25;
  vec3 g4 = (g + h + l + m) * 0.25;

  vec3 sum;
  if (uFirst > 0.5) {
    float w0 = karis(g0) * 0.5;
    float w1 = karis(g1) * 0.125;
    float w2 = karis(g2) * 0.125;
    float w3 = karis(g3) * 0.125;
    float w4 = karis(g4) * 0.125;
    sum = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);

    // Soft-knee threshold. The knee is what stops the glow switching on across a
    // whole surface the instant a light rotates a degree.
    float br = max(sum.r, max(sum.g, sum.b));
    float rq = clamp(br - uThreshold.y, 0.0, uThreshold.z);
    rq = rq * rq * uThreshold.w;
    sum *= max(rq, br - uThreshold.x) / max(br, 1e-5);

    // A blue super has to bloom blue. Left alone every bright thing converges on
    // the same white haze and the fighters stop owning their own energy colour.
    sum = mix(vec3(luma(sum)), sum, uSaturation);
  } else {
    sum = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
  }

  gl_FragColor = vec4(max(sum, 0.0), 1.0);
}
`;

/**
 * Bloom upsample: 3x3 tent, blended additively onto the next-larger mip.
 *
 * Progressive tent upsampling is what makes the falloff continuous. A single
 * wide gaussian at one resolution — the classic `UnrealBloomPass` shape — has a
 * visible edge where the kernel ends, which is the screen-wide bleed this look
 * is trying to avoid.
 */
export const BLOOM_UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;

vec3 tap(vec2 o) { return texture2D(tSrc, vUv + o * uTexel * uRadius).rgb; }

void main() {
  vec3 s = tap(vec2(-1.0, -1.0)) * 1.0 + tap(vec2(0.0, -1.0)) * 2.0 + tap(vec2(1.0, -1.0)) * 1.0
         + tap(vec2(-1.0,  0.0)) * 2.0 + tap(vec2(0.0,  0.0)) * 4.0 + tap(vec2(1.0,  0.0)) * 2.0
         + tap(vec2(-1.0,  1.0)) * 1.0 + tap(vec2(0.0,  1.0)) * 2.0 + tap(vec2(1.0,  1.0)) * 1.0;
  gl_FragColor = vec4(s * (1.0 / 16.0), 1.0);
}
`;

/**
 * Anamorphic streak: a one-dimensional blur run three times with an exponentially
 * growing stride, so seven taps per pass reach 7 * 4^2 texels of smear.
 *
 * Only the already-thresholded bright pass feeds this, so it can only ever
 * appear on genuine highlights — a specular on a wrap, a hitspark, an eye. That
 * is the whole trick: the streak is never seen, but its absence is what makes a
 * frame read as "renderer output" rather than "shot through a lens".
 */
export const STREAK_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uStride;
uniform float uAttenuation;
varying vec2 vUv;

void main() {
  vec3 sum = texture2D(tSrc, vUv).rgb;
  float total = 1.0;
  for (int i = 1; i <= 3; i++) {
    // Attenuation is per tap, not per texel: the stride quadruples every
    // iteration, so a distance-based falloff would extinguish the long passes
    // that give the streak its reach.
    float w = pow(uAttenuation, float(i));
    float d = float(i) * uStride;
    sum += (texture2D(tSrc, vUv + vec2(d * uTexel.x, 0.0)).rgb
          + texture2D(tSrc, vUv - vec2(d * uTexel.x, 0.0)).rgb) * w;
    total += 2.0 * w;
  }
  gl_FragColor = vec4(sum / total, 1.0);
}
`;

/**
 * The composite: everything from "linear HDR scene" to "sRGB bytes on the
 * canvas" in one pass.
 *
 * One pass rather than eight because at 1080p each extra full-screen resolve
 * costs about 0.3 ms of pure bandwidth, and eight of those is a third of the
 * frame budget spent moving pixels that never changed. Passes are compiled in
 * and out with defines, so a disabled effect costs literally nothing and the
 * A/B toggles measure something real.
 *
 * Order matters and is not arbitrary:
 *   distortion and aberration first  — they are properties of the *lens*, so
 *                                      they must displace the light before any
 *                                      of it is measured;
 *   bloom, streak, lines, flash      — still scene-referred, still HDR, so they
 *                                      go through the tone curve like light;
 *   tone map, then grade             — the camera, then the colourist;
 *   vignette, grain, dither          — the print. These are the only things that
 *                                      may touch already-graded values.
 */
export const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tStreak;
uniform sampler2D tLut;

uniform vec2 uResolution;
uniform float uAspect;
uniform float uScale;        // frame height / 1080, so px-quoted knobs are resolution-free

uniform float uExposure;
uniform float uHueShift;
uniform vec4 uCurve;         // contrast, linear start, linear length, toe

uniform float uBloom;
uniform vec3 uBloomTint;
uniform float uStreak;
uniform vec3 uStreakTint;

uniform float uLutSize;
uniform float uLutStrength;

uniform float uAberration;
uniform float uAberrationImpact;
uniform float uDrag;
uniform float uDistortion;

uniform float uImpact;
uniform vec3 uImpactColor;
uniform float uImpactFlash;

uniform float uDim;
uniform vec3 uDimColor;
uniform float uDimFloor;
uniform float uTimeStop;
uniform vec3 uTimeStopColor;

uniform float uLines;
uniform vec2 uLineCenter;
uniform float uLineCount;
uniform float uLineCountFine;
uniform float uLineGain;
uniform vec3 uLineColor;
uniform float uLineSeed;

uniform float uVignette;
uniform float uVigInner;
uniform float uVigOuter;
uniform float uVigRound;

uniform float uGrain;
uniform float uGrainSize;
uniform float uSeed;

varying vec2 vUv;

${COMMON}

/**
 * Uchimura's GT curve: a power toe, a straight linear section, an exponential
 * shoulder. Chosen over ACES because ACES bleaches saturated highlights on its
 * way to white, and a fighting game's whole visual identity is saturated
 * highlights — a red gi's rim light must stay red as it clips.
 */
float gt(float x) {
  float P = 1.0;
  float a = uCurve.x;
  float m = uCurve.y;
  float l = uCurve.z;
  float c = uCurve.w;
  float l0 = ((P - m) * l) / a;
  float S0 = m + l0;
  float S1 = m + a * l0;
  float C2 = (a * P) / (P - S1);
  float w0 = 1.0 - smoothstep(0.0, m, x);
  float w2 = step(m + l0, x);
  float w1 = 1.0 - w0 - w2;
  float T = m * pow(max(x, 1e-5) / m, c);
  float S = P - (P - S1) * exp((-C2 / P) * (x - S0));
  float L = m + a * (x - m);
  return T * w0 + L * w1 + S * w2;
}

vec3 tonemap(vec3 c) {
  c = max(c, 0.0);
  vec3 perCh = vec3(gt(c.r), gt(c.g), gt(c.b));
  float lw = luma(c);
  vec3 byLuma = c * (gt(lw) / max(lw, 1e-5));
  return clamp(mix(byLuma, perCh, uHueShift), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

/**
 * Tiled-LUT lookup: bilinear inside a blue slice comes free from the sampler,
 * only the blue axis is interpolated by hand. Coordinates land on texel centres
 * so a slice can never bleed into its neighbour.
 */
vec3 lut(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  float sz = uLutSize;
  float zf = c.b * (sz - 1.0);
  float z0 = floor(zf);
  float z1 = min(z0 + 1.0, sz - 1.0);
  float xr = c.r * (sz - 1.0) + 0.5;
  float v = (c.g * (sz - 1.0) + 0.5) / sz;
  float inv = 1.0 / (sz * sz);
  vec3 s0 = texture2D(tLut, vec2((z0 * sz + xr) * inv, v)).rgb;
  vec3 s1 = texture2D(tLut, vec2((z1 * sz + xr) * inv, v)).rgb;
  return mix(s0, s1, zf - z0);
}

/**
 * One layer of radial speed lines.
 *
 * The three things that separate anime speed lines from a barcode, in order:
 *
 * 1. **They stay out of the middle.** The action has to remain readable, so
 *    every line starts well outside the centre and points away from it.
 * 2. **They taper.** A line is a brush stroke — sharp where it starts, fading
 *    where it ends. Constant-intensity bars with two hard ends read as a UI
 *    element laid over the frame.
 * 3. **Roughly a third of the slots are empty.** Evenly filled spokes are a
 *    test pattern; gaps and clusters are what make it look drawn.
 *
 * Everything per line — presence, width, start radius, length, brightness and
 * drift speed — comes from a hash of its angular index, taken modulo the count
 * so the wheel closes without a seam at the wrap.
 */
float speedLines(vec2 d, float count, float widthScale, float phase) {
  float r = length(d);
  float ang = atan(d.y, d.x) * (1.0 / TAU) + 0.5;
  float k = ang * count;
  float id = mod(floor(k), count);
  vec2 h = hash12(id + phase + uLineSeed);
  vec2 h2 = hash12(id * 1.731 + phase + 13.7 + uLineSeed);
  if (h2.x < 0.34) return 0.0;

  // Lines sweep outward: static spokes look like a decal, drifting ones sell
  // that the world is rushing past the camera.
  float drift = fract(h.x + uSeed * mix(0.008, 0.020, h.y)) * 0.10;
  float inner = mix(0.30, 0.66, h.y) - drift;
  float t = (r - inner) / mix(0.20, 0.52, h2.y);
  if (t < 0.0 || t > 1.0) return 0.0;

  float taper = pow(t, 0.45) * pow(1.0 - t, 0.75) * 2.1;
  // The stroke narrows toward its inner tip as well as fading, which is what
  // makes a bundle of them converge instead of just stopping.
  float w = mix(0.045, 0.16, h.x) * widthScale * mix(0.35, 1.0, t);
  float f = fract(k) - 0.5;
  return smoothstep(w, w * 0.15, abs(f)) * taper * (0.45 + 0.55 * h2.y);
}

vec3 sampleCA(vec2 uv, vec2 off) {
  return vec3(
    texture2D(tScene, uv + off).r,
    texture2D(tScene, uv).g,
    texture2D(tScene, uv - off).b);
}

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  vec2 dA = vec2(d.x * uAspect, d.y);
  float r = length(dA);

#ifdef USE_DISTORTION
  // Negative k pulls the sampled point inward, so the corners magnify and no
  // part of the frame can ever sample outside the target.
  uv = 0.5 + d * (1.0 + uDistortion * dot(dA, dA) * 4.0);
#endif

  vec3 scene;
#ifdef USE_ABERRATION
  vec2 radial = dA / max(r, 1e-4);
  vec2 rUv = vec2(radial.x / uAspect, radial.y);
  // Lateral CA is a fourth-power-ish function of field height on a real lens;
  // r*r*4 puts effectively all of it in the outer third, where the eye reads it
  // as glass rather than as a broken renderer.
  float caPx = (uAberration + uAberrationImpact * uImpact) * uScale * r * r * 4.0;
  vec2 off = rUv * caPx / uResolution;

  if (uImpact > 0.004) {
    // A connecting blow is a physical jolt, not just a colour fringe: the whole
    // frame drags along its radius for two or three frames.
    vec2 drag = rUv * (uDrag * uImpact * uScale) / uResolution;
    scene = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      float t = float(i) * 0.33333;
      scene += sampleCA(uv - drag * t, off * (1.0 + t * 0.6));
    }
    scene *= 0.25;
  } else {
    scene = sampleCA(uv, off);
  }
#else
  scene = texture2D(tScene, uv).rgb;
#endif

#ifdef USE_BLOOM
  scene += texture2D(tBloom, uv).rgb * uBloomTint * (uBloom * (1.0 + uImpact * 0.35));
#endif

#ifdef USE_STREAK
  scene += texture2D(tStreak, uv).rgb * uStreakTint * uStreak;
#endif

#ifdef USE_SPEEDLINES
  if (uLines > 0.001) {
    vec2 ld = (vUv - uLineCenter) * vec2(uAspect, 1.0);
    // Two layers at different densities. The sparse one gets a narrower width
    // fraction because its cells are twice as wide in pixels.
    float lines = speedLines(ld, uLineCount, 1.0, 0.0)
                + speedLines(ld, uLineCountFine, 0.55, 91.3) * 0.6;
    // Fed in above white so the tone curve clips them to paper — a super's lines
    // are ink on the frame, not a lit surface.
    scene += lines * uLines * uLineGain * uLineColor;
  }
#endif

  // Impact flash, squared so a light jab barely registers and a counter-hit
  // feels like the camera flash went off. Mostly an *exposure* kick rather than
  // an additive one: adding a constant to a stage this dark erases every
  // silhouette in the frame, and a hit that hides the fighters is a hit the
  // player cannot read. The small additive term is what lets the true blacks
  // flash at all.
  float flash = uImpactFlash * uImpact * uImpact;
  scene = scene * (1.0 + flash * 5.0) + uImpactColor * (flash * 0.22);

  // Cut-ins drain the world so the portrait layer, composited after post, owns
  // the eye completely.
  float dl = luma(scene);
  scene = mix(scene, mix(scene, vec3(dl) * uDimColor, 0.55) * uDimFloor, uDim);

#ifdef USE_TONEMAP
  vec3 color = tonemap(scene * uExposure);
#else
  vec3 color = clamp(scene * uExposure, 0.0, 1.0);
#endif
  vec3 srgb = linearToSrgb(color);

#ifdef USE_GRADE
  srgb = mix(srgb, lut(srgb), uLutStrength);
#endif

  if (uTimeStop > 0.001) {
    // Hitstop should read as the colour draining out of a held frame, not as a
    // fade — value stays put, chroma leaves and the frame goes cold.
    float g = luma(srgb);
    srgb = mix(srgb, mix(vec3(g), vec3(g) * uTimeStopColor, 0.65), uTimeStop * 0.72);
    srgb *= mix(1.0, 0.93, uTimeStop);
  }

#ifdef USE_VIGNETTE
  float vd = length(vec2(d.x * mix(1.0, uAspect, uVigRound), d.y)) * 1.4142;
  float vig = smoothstep(uVigOuter, uVigInner, vd);
  vig = mix(1.0, vig, clamp(uVignette + uTimeStop * 0.3 + uDim * 0.25, 0.0, 1.0));
  srgb *= vig;
  // Real glass loses chroma at the edge as well as light. Darkening alone reads
  // as a black sticker laid over the picture.
  srgb = mix(vec3(luma(srgb)), srgb, mix(0.88, 1.0, vig));
#endif

#ifdef USE_GRAIN
  // Floored at just over a pixel: a sub-pixel grain cell resolves into a moire
  // grid instead of grain, which is far more visible than the grain itself.
  vec2 gp = gl_FragCoord.xy / max(uGrainSize * uScale, 1.25);
  float g1 = vnoise(gp + vec2(uSeed * 37.1, uSeed * 17.7));
  float g2 = vnoise(gp * 2.13 - vec2(uSeed * 11.3, uSeed * 29.9));
  float grain = (g1 - 0.5) * 0.75 + (g2 - 0.5) * 0.25;
  // Emulsion grain lives in the midtones. Grain in the blacks is video noise and
  // grain in the speculars is a broken denoiser; both are instant tells.
  float shape = 1.0 - abs(luma(srgb) * 2.0 - 1.0);
  srgb += grain * uGrain * (0.3 + 0.7 * shape);
#endif

  // Triangular dither under half a code value. The graded shadows sit in a very
  // shallow part of the curve and band visibly in 8 bits without it.
  float d0 = hash21(gl_FragCoord.xy + uSeed);
  float d1 = hash21(gl_FragCoord.xy + uSeed + 41.7);
  srgb += (d0 - d1) * (0.5 / 255.0);

  gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}
`;
