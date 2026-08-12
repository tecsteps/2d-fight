import * as THREE from 'three';

/**
 * Bootstrap stage.
 *
 * A deliberately simple lit environment that exists so the render pipeline is
 * runnable and screenshottable from day one. It establishes the conventions the
 * real stages follow — three parallax groups, a key/fill/rim light rig sized to
 * the fighting plane, and a `tick` for anything animated — and is expected to be
 * replaced wholesale by the authored stages in this directory.
 *
 * Everything here is generated in code. No textures are loaded.
 */

export interface Stage {
  background: THREE.Group;
  world: THREE.Group;
  foreground: THREE.Group;
  tick?(frame: number): void;
}

/** Procedural gradient sky, drawn on a large backing plane. */
function makeSky(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(120, 60);
  const mat = new THREE.ShaderMaterial({
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x121a2e) },
      uMid: { value: new THREE.Color(0x3a2a3f) },
      uBot: { value: new THREE.Color(0x8a4a35) },
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
      uniform vec3 uTop, uMid, uBot;
      void main() {
        float t = vUv.y;
        // Two-stop gradient with a warm horizon band, then a subtle vertical
        // dither so the sky never shows 8-bit banding on a dark display.
        vec3 c = mix(uBot, uMid, smoothstep(0.0, 0.45, t));
        c = mix(c, uTop, smoothstep(0.4, 1.0, t));
        float dither = fract(sin(dot(vUv * 1024.0, vec2(12.9898, 78.233))) * 43758.5453);
        c += (dither - 0.5) / 255.0;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(0, 12, -34);
  m.renderOrder = -100;
  return m;
}

/** Procedural checker-ish floor with a subtle radial vignette toward the edges. */
function makeFloor(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(80, 40, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2b2620,
    roughness: 0.86,
    metalness: 0.02,
  });
  const m = new THREE.Mesh(geo, mat);
  m.position.y = 0;
  m.receiveShadow = true;
  return m;
}

export function buildBootstrapStage(): Stage {
  const background = new THREE.Group();
  const world = new THREE.Group();
  const foreground = new THREE.Group();

  background.add(makeSky());
  world.add(makeFloor());

  // --- Light rig -----------------------------------------------------------
  // Key from camera-left and above, warm. Fill from the opposite side, cool and
  // much weaker. Rim from behind to punch the silhouette off the backdrop —
  // the single most important light in a fighting game.
  const key = new THREE.DirectionalLight(0xffd9b0, 2.6);
  key.position.set(-5.5, 8.0, 6.0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -12;
  key.shadow.camera.right = 12;
  key.shadow.camera.top = 12;
  key.shadow.camera.bottom = -4;
  key.shadow.bias = -0.0012;
  key.shadow.normalBias = 0.02;
  world.add(key, key.target);

  const fill = new THREE.DirectionalLight(0x6f86c9, 0.55);
  fill.position.set(6.5, 3.5, 4.0);
  world.add(fill);

  const rim = new THREE.DirectionalLight(0xff9f5a, 1.9);
  rim.position.set(1.5, 4.5, -8.0);
  world.add(rim);

  const ambient = new THREE.HemisphereLight(0x5a6a93, 0x2a1d16, 0.45);
  world.add(ambient);

  // A pool of warm light on the floor where the fighters stand, so the plane
  // does not read as a flat grey slab.
  const pool = new THREE.PointLight(0xffb070, 12, 22, 2);
  pool.position.set(0, 3.2, 2.0);
  world.add(pool);

  return { background, world, foreground };
}
