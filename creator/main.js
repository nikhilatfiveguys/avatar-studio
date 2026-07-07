import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AvaturnSDK } from '@avaturn/sdk';

const stageEl = document.getElementById('stage');
const creatorEl = document.getElementById('creator');
const loadingEl = document.getElementById('loading');
const hudBottom = document.getElementById('hud-bottom');
const addBtn = document.getElementById('btn-add');

// Built-in animations shipped with the site. Add more entries here
// (e.g. Mixamo exports dropped into assets/dances/) to get buttons for
// every visitor.
const BUILT_IN = [
  { name: 'idle', label: '🧍 Idle', url: 'assets/animation.glb' },
];

let renderer, scene, camera, controls, mixer, clock, animationGroup;
let currentAvatar = null;
let currentAction = null;
const actions = new Map();
let sdkStarted = false;

init();

async function init() {
  const canvas = document.getElementById('stage-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.3, 3.4);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.95, 0);
  controls.enableDamping = true;
  controls.minDistance = 1.2;
  controls.maxDistance = 7;
  controls.maxPolarAngle = Math.PI * 0.55;

  scene.add(new THREE.HemisphereLight(0xbcaaff, 0x1a1424, 0.9));

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(2, 4, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.001;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x8f7bff, 1.2);
  rim.position.set(-3, 2, -3);
  scene.add(rim);

  new RGBELoader().load('assets/brown_photostudio_01.hdr', (texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = texture;
  });

  // Platform
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 1.25, 0.07, 64),
    new THREE.MeshStandardMaterial({ color: 0x241f33, roughness: 0.55, metalness: 0.35 })
  );
  disc.position.y = -0.035;
  disc.receiveShadow = true;
  scene.add(disc);

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.22, 0.014, 16, 96),
    new THREE.MeshBasicMaterial({ color: 0x7c5cff })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.004;
  scene.add(ring);

  clock = new THREE.Clock();
  animationGroup = new THREE.AnimationObjectGroup();
  mixer = new THREE.AnimationMixer(animationGroup);

  renderer.setAnimationLoop(() => {
    controls.update();
    mixer.update(clock.getDelta());
    renderer.render(scene, camera);
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Default avatar so the stage is never empty; replaced on export.
  const direct = new URLSearchParams(location.search).get('avatar');
  await swapAvatar(direct || 'assets/default_model.glb');

  for (const entry of BUILT_IN) {
    await registerClipFromUrl(entry.name, entry.url, entry.label, false);
  }
  play('idle');
}

async function swapAvatar(url) {
  loadingEl.classList.remove('hidden');
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    const model = gltf.scene;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
        if (o.material) {
          o.material.envMapIntensity = 0.3;
          if (o.material.map && !o.material.name.includes('hair')) {
            o.material.map.generateMipmaps = false;
          }
        }
      }
    });

    if (currentAvatar) {
      currentAvatar.removeFromParent();
      animationGroup.uncache(currentAvatar);
      animationGroup.remove(currentAvatar);
    }
    scene.add(model);
    animationGroup.add(model);
    currentAvatar = model;
    if (currentAction) currentAction.play();
  } finally {
    loadingEl.classList.add('hidden');
  }
}

// Keep only root motion + rotations so clips retarget cleanly.
function filterClip(clip) {
  clip.tracks = clip.tracks
    .filter((t) => t.name.endsWith('Hips.position') || t.name.endsWith('.quaternion'))
    .map((t) => {
      // Mixamo exports prefix bones with "mixamorig[:]"; Avaturn rigs don't.
      t.name = t.name.replace(/^mixamorig:?/i, '').replace(/mixamorig:?/gi, '');
      return t;
    });
  return clip;
}

async function registerClipFromUrl(name, url, label, autoplay = true) {
  const isFbx = /\.fbx$/i.test(url);
  const loader = isFbx ? new FBXLoader() : new GLTFLoader();
  const asset = await loader.loadAsync(url);
  const clip = filterClip((asset.animations || [])[0]);
  addAction(name, clip, label, autoplay);
}

function addAction(name, clip, label, autoplay) {
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  actions.set(name, action);

  if (!hudBottom.querySelector(`[data-anim="${CSS.escape(name)}"]`)) {
    const btn = document.createElement('button');
    btn.className = 'pill anim-btn';
    btn.dataset.anim = name;
    btn.textContent = label || `💃 ${name}`;
    btn.addEventListener('click', () => play(name));
    hudBottom.insertBefore(btn, addBtn);
  }
  if (autoplay) play(name);
}

function play(name) {
  const action = actions.get(name);
  if (!action) return;
  action.reset();
  if (currentAction && currentAction !== action) {
    currentAction.crossFadeTo(action, 0.35, true);
  }
  action.play();
  currentAction = action;
  document.querySelectorAll('.anim-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.anim === name)
  );
}

// ---------- Local animation files (Mixamo .fbx / .glb) ----------

document.getElementById('file-input').addEventListener('change', async (e) => {
  for (const file of e.target.files) {
    const url = URL.createObjectURL(file);
    const base = file.name.replace(/\.(fbx|glb)$/i, '');
    try {
      await registerClipFromUrl(base, url + '#.' + file.name.split('.').pop(), `💃 ${base}`);
    } catch (err) {
      console.error('Failed to load animation', file.name, err);
    }
  }
  e.target.value = '';
});

// ---------- Avaturn creator ----------

document.getElementById('btn-create').addEventListener('click', async () => {
  creatorEl.classList.remove('hidden');
  if (sdkStarted) return;
  sdkStarted = true;

  const sdk = new AvaturnSDK();
  await sdk.init(document.getElementById('avaturn-sdk-container'), {
    url: 'https://demo.avaturn.dev',
  });
  sdk.on('export', (data) => {
    creatorEl.classList.add('hidden');
    swapAvatar(data.url);
  });
});

document.getElementById('btn-close').addEventListener('click', () => {
  creatorEl.classList.add('hidden');
});
