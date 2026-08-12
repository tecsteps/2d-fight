import * as THREE from 'three';
import { BoxKind, boxDebug, type DebugBox } from './Boxes';

/**
 * Three.js view of the CLSN boxes.
 *
 * Deliberately the *only* file in `src/engine` that imports Three: the
 * simulation records the boxes it tested into `boxDebug` and this turns that
 * recording into line geometry. Nothing here can affect the fight, and the sim
 * still runs with no renderer attached at all.
 *
 * Colours follow the training-mode convention every fighting game uses, so the
 * display reads instantly to anyone who has opened one before: red attacks,
 * blue can be attacked, green is the body, yellow is throw range.
 */

const COLORS: Record<BoxKind, number> = {
  [BoxKind.Hurt]: 0x3fa9f5,
  [BoxKind.Hit]: 0xff3b30,
  [BoxKind.Push]: 0x4cd964,
  [BoxKind.Throw]: 0xffd400,
};

/** Boxes per kind we are willing to draw in one frame. */
const CAPACITY = 64;

export class BoxDebugRenderer {
  readonly root = new THREE.Group();

  private readonly layers = new Map<BoxKind, THREE.LineSegments>();
  private readonly positions = new Map<BoxKind, Float32Array>();

  constructor() {
    this.root.name = 'clsn-debug';
    this.root.renderOrder = 999;
    for (const kind of [BoxKind.Hurt, BoxKind.Hit, BoxKind.Push, BoxKind.Throw]) {
      // 4 edges × 2 endpoints × 3 components per box.
      const buf = new Float32Array(CAPACITY * 24);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(buf, 3));
      geo.setDrawRange(0, 0);
      const mat = new THREE.LineBasicMaterial({
        color: COLORS[kind],
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      });
      const lines = new THREE.LineSegments(geo, mat);
      lines.frustumCulled = false;
      this.root.add(lines);
      this.layers.set(kind, lines);
      this.positions.set(kind, buf);
    }
    this.root.visible = false;
  }

  get enabled(): boolean {
    return boxDebug.enabled;
  }

  /** Wire this to a key in the UI layer; the sim never toggles itself. */
  toggle(): boolean {
    const on = boxDebug.toggle();
    this.root.visible = on;
    return on;
  }

  setEnabled(on: boolean): void {
    boxDebug.setEnabled(on);
    this.root.visible = on;
  }

  /** Call once per rendered frame, after the sim tick. */
  update(z = 0.02): void {
    if (!boxDebug.enabled) return;
    const counts = new Map<BoxKind, number>();

    for (const box of boxDebug.boxes) {
      const buf = this.positions.get(box.kind);
      if (!buf) continue;
      const n = counts.get(box.kind) ?? 0;
      if (n >= CAPACITY) continue;
      writeRect(buf, n * 24, box, z);
      counts.set(box.kind, n + 1);
    }

    for (const [kind, lines] of this.layers) {
      const n = counts.get(kind) ?? 0;
      lines.geometry.setDrawRange(0, n * 8);
      lines.geometry.attributes.position.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const lines of this.layers.values()) {
      lines.geometry.dispose();
      (lines.material as THREE.Material).dispose();
    }
  }
}

/** Four edges of an axis-aligned rect, on the fighting plane. */
function writeRect(buf: Float32Array, o: number, b: DebugBox, z: number): void {
  const pts = [
    b.x0, b.y0, b.x1, b.y0,
    b.x1, b.y0, b.x1, b.y1,
    b.x1, b.y1, b.x0, b.y1,
    b.x0, b.y1, b.x0, b.y0,
  ];
  for (let i = 0; i < 8; i++) {
    buf[o + i * 3] = pts[i * 2];
    buf[o + i * 3 + 1] = pts[i * 2 + 1];
    buf[o + i * 3 + 2] = z;
  }
}
