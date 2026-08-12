/**
 * Face inspection harness: four heads in a row, tightly framed, at a yaw the
 * capture script drives.
 *
 * Not part of the game — nothing imports it, and vite only builds `index.html`.
 * It exists because a face cannot be reviewed at lineup scale: at 1470 px/m a
 * head is 315 px here and 60 px there, and every defect this pass fixed (an
 * eyeball buried 3 mm inside its own socket, a back-face-culled globe, a lash
 * two pixels wide) was invisible in the lineup shot and obvious in this one.
 *
 *   node tools/faceshot/capture.mjs --tag check --query light=front --yaws 0,0.6,1.35
 *   node tools/faceshot/capture.mjs --tag gp --query frame=body,hair=1,costume=1 --yaws 0.42 --h 1080
 *   node tools/faceshot/capture.mjs --tag angry --expr '{"brow":-1,"squint":0.7,"mouthOpen":0.9}'
 *
 * Query flags: `light=front`, `ink=0`, `only=face`, `hide=lashes+brows`,
 * `frame=body`, `hair=1`, `costume=1`, `face=0`, `lightlock=0`.
 */
import * as THREE from 'three';
import { buildCharacter, NEUTRAL_STANCE } from '../../src/art/characters/rig';
import { ROSTER } from '../../src/data/roster';
import { calibrateNpr, addOutlines } from '../../src/render/npr';
import type { BuiltCharacter } from '../../src/art/characters/rig';
import { buildFace } from '../../src/art/characters/face';
import { buildHair } from '../../src/art/characters/hair';

const params = new URLSearchParams(location.search);
const W = parseInt(params.get('w') ?? '1920', 10);
const H = parseInt(params.get('h') ?? '620', 10);
const withHair = params.get('hair') === '1';
const withCostume = params.get('costume') === '1';
const withFace = params.get('face') !== '0';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
canvas.width = W;
canvas.height = H;
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setSize(W, H, false);
renderer.setClearColor(0x121722, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();

const front = params.get('light') === 'front';
const key = new THREE.DirectionalLight(0xffe3c0, 2.4);
if (front) key.position.set(-2.2, 3.2, 5);
else key.position.set(-4, 6, 5);
key.castShadow = true;
const fill = new THREE.DirectionalLight(0x7a90d0, 0.5);
fill.position.set(5, 2.5, 3);
const rim = new THREE.DirectionalLight(0xffa060, 1.7);
rim.position.set(1, 3.5, -6);
scene.add(key, fill, rim, new THREE.HemisphereLight(0x5a6a93, 0x2a1d16, 0.4));

const rigs: BuiltCharacter[] = [];
const holders: THREE.Group[] = [];

// One cell per fighter. The head is placed at the cell centre and the body is
// left to hang out of frame below.
const bodyFrame = params.get('frame') === 'body';
const CELL = bodyFrame ? 0.95 : 0.34;
const x0 = -((ROSTER.length - 1) * CELL) / 2;

ROSTER.forEach((def, i) => {
  // Outlines off here, then re-run after the face lands, which is exactly the
  // order `buildCharacter` will use once the hook is wired.
  const rig = buildCharacter(def, { costume: withCostume, outlines: false, hair: withHair });
  if (withFace) buildFace(rig, def);
  if (withHair) buildHair(rig, def);
  if (params.get('ink') !== '0') rig.outlines = addOutlines(rig.root);
  if (params.get('only') === 'face') rig.meshes[0].visible = false;
  const hide = params.get('hide');
  if (hide) {
    for (const n of hide.split('+')) {
      rig.root.getObjectByName(`${def.id}:face:${n}`)?.removeFromParent();
    }
  }
  rig.resetPose();
  rig.applyPose(NEUTRAL_STANCE);
  const holder = new THREE.Group();
  holder.add(rig.root);
  // Head centre to the origin of the holder.
  const headMid = def.proportions.height - def.proportions.height * def.proportions.headRatio * 0.5;
  rig.root.position.y = -headMid;
  holder.position.x = x0 + i * CELL;
  scene.add(holder);
  rigs.push(rig);
  holders.push(holder);
});

const aspect = W / H;
// `frame=body` pulls back to gameplay scale: a fighter about 460 px tall, which
// is where the faces actually have to work.

const halfH = bodyFrame ? 1.02 : CELL * 0.62;
const cam = new THREE.OrthographicCamera(-halfH * aspect, halfH * aspect, halfH, -halfH, -20, 20);
cam.position.set(0, bodyFrame ? -0.72 : 0, 6);
cam.lookAt(0, bodyFrame ? -0.72 : 0, 0);

calibrateNpr(scene);

// The lights follow the yaw so a profile shot is keyed off the face rather than
// off the back of the head — otherwise every non-front view is judged in shadow.
const keyBase = new THREE.Vector3().copy(key.position);
const fillBase = new THREE.Vector3().copy(fill.position);
const rimBase = new THREE.Vector3().copy(rim.position);

function setYaw(y: number): void {
  for (const r of rigs) r.root.rotation.y = y;
  const spin = params.get('lightlock') === '0' ? 0 : y;
  key.position.copy(keyBase).applyAxisAngle(new THREE.Vector3(0, 1, 0), spin);
  fill.position.copy(fillBase).applyAxisAngle(new THREE.Vector3(0, 1, 0), spin);
  rim.position.copy(rimBase).applyAxisAngle(new THREE.Vector3(0, 1, 0), spin);
  scene.updateMatrixWorld(true);
}

function draw(): void {
  renderer.render(scene, cam);
}

setYaw(0);
draw();

interface FaceHarness {
  ready: boolean;
  setYaw(y: number): void;
  draw(): void;
  expr(v: Record<string, number>): void;
  rigs: BuiltCharacter[];
}

const harness: FaceHarness = {
  ready: false,
  setYaw(y) {
    setYaw(y);
    draw();
  },
  draw,
  expr(v) {
    for (const r of rigs) {
      const set = (r.root.userData.face as { set?: (k: string, n: number) => void } | undefined)?.set;
      if (set) for (const k of Object.keys(v)) set(k, v[k]);
    }
    scene.updateMatrixWorld(true);
    draw();
  },
  rigs,
};
(window as unknown as { __face: FaceHarness }).__face = harness;
requestAnimationFrame(() => {
  harness.ready = true;
});
