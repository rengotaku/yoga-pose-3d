import * as THREE from "three";
import {
  LM,
  toVec,
  computeActivations,
  heatColor,
  type RawLandmark,
  type ActivationMap,
} from "./muscles";

const NEUTRAL = 0xb98a7a; // 筋肉ベージュ（不活性部位）

/** 使用筋ヒートに応じたマテリアルを生成 */
const heatMaterial = (activation: number): THREE.MeshStandardMaterial => {
  const { color, emissiveIntensity } = heatColor(activation);
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color.clone(),
    emissiveIntensity,
    roughness: 0.55,
    metalness: 0.05,
  });
};

const neutralMaterial = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color: NEUTRAL,
    roughness: 0.6,
    metalness: 0.05,
  });

/** 2点間に筋肉状カプセル（肉付きの肢体）を配置 */
const addLimb = (
  group: THREE.Group,
  a: RawLandmark | undefined,
  b: RawLandmark | undefined,
  radius: number,
  material: THREE.Material
): void => {
  if (!a || !b) return;
  const av = toVec(a);
  const bv = toVec(b);
  const len = av.distanceTo(bv);
  if (len <= 0) return;
  const cylLen = Math.max(0.001, len - radius * 2);
  const geometry = new THREE.CapsuleGeometry(radius, cylLen, 6, 12);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(av).lerp(bv, 0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    bv.clone().sub(av).normalize()
  );
  group.add(mesh);
};

/** 関節を丸める球 */
const addJoint = (
  group: THREE.Group,
  p: RawLandmark | undefined,
  radius: number,
  material: THREE.Material
): void => {
  if (!p) return;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), material);
  mesh.position.copy(toVec(p));
  group.add(mesh);
};

const mid = (
  a: RawLandmark | undefined,
  b: RawLandmark | undefined
): THREE.Vector3 | null => (a && b ? toVec(a).add(toVec(b)).multiplyScalar(0.5) : null);

/** 胴体メッシュ（肩→腰の体積）を配置 */
const addTorso = (
  group: THREE.Group,
  landmarks: RawLandmark[],
  coreActivation: number
): void => {
  const ls = landmarks[LM.LEFT_SHOULDER];
  const rs = landmarks[LM.RIGHT_SHOULDER];
  const lh = landmarks[LM.LEFT_HIP];
  const rh = landmarks[LM.RIGHT_HIP];
  const shoulderMid = mid(ls, rs);
  const hipMid = mid(lh, rh);
  if (!shoulderMid || !hipMid || !ls || !rs || !lh || !rh) return;

  const shoulderW = toVec(ls).distanceTo(toVec(rs));
  const hipW = toVec(lh).distanceTo(toVec(rh));
  const height = shoulderMid.distanceTo(hipMid);
  if (height <= 0) return;

  const geometry = new THREE.CylinderGeometry(
    Math.max(0.04, shoulderW * 0.55), // +Y(top) を肩側へ
    Math.max(0.04, hipW * 0.55),
    height,
    20,
    1,
    false
  );
  geometry.scale(1, 1, 0.55); // 前後を薄くして胴体らしく
  const mesh = new THREE.Mesh(geometry, heatMaterial(coreActivation));
  mesh.position.copy(shoulderMid).lerp(hipMid, 0.5);
  // Cylinder の +Y を「腰→肩」方向へ
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    shoulderMid.clone().sub(hipMid).normalize()
  );
  mesh.name = "torso";
  group.add(mesh);
};

/**
 * worldLandmarks から肉付き筋肉ボディ（肢体カプセル + 胴体 + 頭）を生成し、
 * 使用筋のヒートマップ着色を施した Group を scene に追加して返す。
 */
export const generateMannequin = (
  worldLandmarks: RawLandmark[],
  scene: THREE.Scene
): THREE.Group => {
  const group = new THREE.Group();
  group.name = "mannequin";
  scene.add(group);

  const act: ActivationMap = computeActivations(worldLandmarks);
  const a = (k: string): number => act[k] ?? 0;
  const g = (i: number): RawLandmark | undefined => worldLandmarks[i];

  // --- 胴体 ---
  addTorso(group, worldLandmarks, a("core"));

  // --- 頭 ---
  addJoint(group, g(LM.NOSE), 0.09, neutralMaterial());

  // --- 上肢 ---
  addLimb(
    group,
    g(LM.LEFT_SHOULDER),
    g(LM.LEFT_ELBOW),
    0.05,
    heatMaterial(a("biceps:L"))
  );
  addLimb(group, g(LM.LEFT_ELBOW), g(LM.LEFT_WRIST), 0.04, heatMaterial(a("forearm:L")));
  addLimb(
    group,
    g(LM.RIGHT_SHOULDER),
    g(LM.RIGHT_ELBOW),
    0.05,
    heatMaterial(a("biceps:R"))
  );
  addLimb(
    group,
    g(LM.RIGHT_ELBOW),
    g(LM.RIGHT_WRIST),
    0.04,
    heatMaterial(a("forearm:R"))
  );

  // --- 下肢（大腿は四頭筋/ハムの max でヒート） ---
  addLimb(
    group,
    g(LM.LEFT_HIP),
    g(LM.LEFT_KNEE),
    0.08,
    heatMaterial(Math.max(a("quadriceps:L"), a("hamstrings:L")))
  );
  addLimb(group, g(LM.LEFT_KNEE), g(LM.LEFT_ANKLE), 0.055, heatMaterial(a("calf:L")));
  addLimb(
    group,
    g(LM.RIGHT_HIP),
    g(LM.RIGHT_KNEE),
    0.08,
    heatMaterial(Math.max(a("quadriceps:R"), a("hamstrings:R")))
  );
  addLimb(group, g(LM.RIGHT_KNEE), g(LM.RIGHT_ANKLE), 0.055, heatMaterial(a("calf:R")));

  // --- 関節を丸める（肩=三角筋 / 股=大臀筋 はヒート、他は中立） ---
  addJoint(group, g(LM.LEFT_SHOULDER), 0.06, heatMaterial(a("deltoid:L")));
  addJoint(group, g(LM.RIGHT_SHOULDER), 0.06, heatMaterial(a("deltoid:R")));
  addJoint(group, g(LM.LEFT_HIP), 0.07, heatMaterial(a("glutes:L")));
  addJoint(group, g(LM.RIGHT_HIP), 0.07, heatMaterial(a("glutes:R")));
  addJoint(group, g(LM.LEFT_ELBOW), 0.045, neutralMaterial());
  addJoint(group, g(LM.RIGHT_ELBOW), 0.045, neutralMaterial());
  addJoint(group, g(LM.LEFT_WRIST), 0.04, neutralMaterial());
  addJoint(group, g(LM.RIGHT_WRIST), 0.04, neutralMaterial());
  addJoint(group, g(LM.LEFT_KNEE), 0.065, neutralMaterial());
  addJoint(group, g(LM.RIGHT_KNEE), 0.065, neutralMaterial());
  addJoint(group, g(LM.LEFT_ANKLE), 0.05, neutralMaterial());
  addJoint(group, g(LM.RIGHT_ANKLE), 0.05, neutralMaterial());

  return group;
};
