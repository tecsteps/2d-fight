/**
 * Post-processing.
 *
 * `PostStack` is the only thing the renderer needs; everything else is exported
 * so the tuning harness and the blind-comparison critic can drive individual
 * pieces. Attaching it is three lines:
 *
 * ```ts
 * const post = new PostStack(this.renderer, this.scene, this.cam.camera);
 * // in resize():  post.setSize(w, h)
 * // in render():  this.cam.apply(frame, alpha); post.render(1 / 60);
 * ```
 *
 * The stack draws the scene itself, so `renderer.render(scene, camera)` must not
 * also be called — the world would be drawn twice and the second pass would land
 * straight on the canvas, unbloomed and ungraded.
 */

export { PostStack, postDebugToggles } from './PostStack';
export { BloomChain } from './bloom';
export { AnamorphicStreak } from './streak';
export { buildGradeLUT, gradeColor, displayRGB } from './grade';
export {
  PASS_NAMES,
  DEFAULT_TUNING,
  resolveTuning,
  type PassName,
  type PostTuning,
  type PostStackOptions,
  type GradeSpec,
  type BloomSpec,
  type StreakSpec,
  type DeepPartial,
} from './contract';
