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
  material: THREE.Material,
  muscles: string[] = []
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
  mesh.userData.muscles = muscles;
  group.add(mesh);
};

/** 関節を丸める球 */
const addJoint = (
  group: THREE.Group,
  p: RawLandmark | undefined,
  radius: number,
  material: THREE.Material,
  muscles: string[] = []
): void => {
  if (!p) return;
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 16), material);
  mesh.position.copy(toVec(p));
  mesh.userData.muscles = muscles;
  group.add(mesh);
};

const mid = (
  a: RawLandmark | undefined,
  b: RawLandmark | undefined
): THREE.Vector3 | null => (a && b ? toVec(a).add(toVec(b)).multiplyScalar(0.5) : null);

/**
 * 体の前方ベクトル（描画座標系）を骨盤・体幹から推定する。
 *
 * 左右 hip を結ぶベクトル（右-左）と、股→肩の体幹軸（up）の外積
 * up × right を取ると、前方向を向く単位ベクトルが得られる
 * （静止立位の landmark で検証済み: up=(0,+y,0), right=(-x,0,0) のとき
 * 外積は (0,0,+z) となり、"体の前方は概ね -z"（MediaPipe world 座標、
 * toVec 変換前）という前提と符号が一致する）。
 *
 * world -z 固定ではなく骨盤・体幹から都度推定することで、しゃがみ・前傾・
 * 体の向きが変わるポーズでも破綻しにくくしている。
 */
const computeFrontVector = (landmarks: RawLandmark[]): THREE.Vector3 => {
  const fallback = new THREE.Vector3(0, 0, 1);
  const ls = landmarks[LM.LEFT_SHOULDER];
  const rs = landmarks[LM.RIGHT_SHOULDER];
  const lh = landmarks[LM.LEFT_HIP];
  const rh = landmarks[LM.RIGHT_HIP];
  if (!ls || !rs || !lh || !rh) return fallback;

  const shoulderMid = mid(ls, rs);
  const hipMid = mid(lh, rh);
  if (!shoulderMid || !hipMid) return fallback;

  const up = shoulderMid.clone().sub(hipMid);
  const right = toVec(rh).sub(toVec(lh));
  if (up.lengthSq() === 0 || right.lengthSq() === 0) return fallback;

  const front = up.cross(right);
  if (front.lengthSq() === 0) return fallback;
  return front.normalize();
};

/**
 * 大腿を前後2つのカプセル（前=四頭筋 / 後=ハムストリングス）に分割して配置する。
 * frontVec を大腿軸（hip→knee）に直交する成分へ投影し、その方向へ
 * ±offset だけずらすことで前後の分離を表現する。
 */
const addThighLimb = (
  group: THREE.Group,
  hip: RawLandmark | undefined,
  knee: RawLandmark | undefined,
  frontVec: THREE.Vector3,
  quadActivation: number,
  hamstringActivation: number
): void => {
  if (!hip || !knee) return;
  const av = toVec(hip);
  const bv = toVec(knee);
  const axisVec = bv.clone().sub(av);
  const len = axisVec.length();
  if (len <= 0) return;
  const axis = axisVec.clone().normalize();

  // frontVec を大腿軸と直交する成分に投影（軸方向成分を除去）
  const ortho = frontVec.clone().sub(axis.clone().multiplyScalar(frontVec.dot(axis)));
  const offsetDir =
    ortho.lengthSq() > 1e-8 ? ortho.normalize() : new THREE.Vector3(0, 0, 1);

  const radius = 0.06;
  const offset = 0.025;
  const cylLen = Math.max(0.001, len - radius * 2);
  const center = av.clone().lerp(bv, 0.5);
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    axis
  );

  const addHalf = (
    dirSign: number,
    material: THREE.Material,
    muscles: string[]
  ): void => {
    const geometry = new THREE.CapsuleGeometry(radius, cylLen, 6, 12);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(center).addScaledVector(offsetDir, dirSign * offset);
    mesh.quaternion.copy(quat);
    mesh.userData.muscles = muscles;
    group.add(mesh);
  };

  addHalf(1, heatMaterial(quadActivation), ["quadriceps"]); // 前=四頭筋
  addHalf(-1, heatMaterial(hamstringActivation), ["hamstrings"]); // 後=ハムストリングス
};

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
  mesh.userData.muscles = ["core"];
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
    heatMaterial(a("biceps:L")),
    ["biceps"]
  );
  addLimb(group, g(LM.LEFT_ELBOW), g(LM.LEFT_WRIST), 0.04, heatMaterial(a("forearm:L")), [
    "forearm",
  ]);
  addLimb(
    group,
    g(LM.RIGHT_SHOULDER),
    g(LM.RIGHT_ELBOW),
    0.05,
    heatMaterial(a("biceps:R")),
    ["biceps"]
  );
  addLimb(
    group,
    g(LM.RIGHT_ELBOW),
    g(LM.RIGHT_WRIST),
    0.04,
    heatMaterial(a("forearm:R")),
    ["forearm"]
  );

  // --- 下肢（大腿は前=四頭筋 / 後=ハムストリングスの2カプセルに分割） ---
  const frontVec = computeFrontVector(worldLandmarks);
  addThighLimb(
    group,
    g(LM.LEFT_HIP),
    g(LM.LEFT_KNEE),
    frontVec,
    a("quadriceps:L"),
    a("hamstrings:L")
  );
  addLimb(group, g(LM.LEFT_KNEE), g(LM.LEFT_ANKLE), 0.055, heatMaterial(a("calf:L")), [
    "calf",
  ]);
  addThighLimb(
    group,
    g(LM.RIGHT_HIP),
    g(LM.RIGHT_KNEE),
    frontVec,
    a("quadriceps:R"),
    a("hamstrings:R")
  );
  addLimb(group, g(LM.RIGHT_KNEE), g(LM.RIGHT_ANKLE), 0.055, heatMaterial(a("calf:R")), [
    "calf",
  ]);

  // --- 関節を丸める（肩=三角筋 / 股=大臀筋 はヒート、他は中立） ---
  addJoint(group, g(LM.LEFT_SHOULDER), 0.06, heatMaterial(a("deltoid:L")), ["deltoid"]);
  addJoint(group, g(LM.RIGHT_SHOULDER), 0.06, heatMaterial(a("deltoid:R")), ["deltoid"]);
  addJoint(group, g(LM.LEFT_HIP), 0.07, heatMaterial(a("glutes:L")), ["glutes"]);
  addJoint(group, g(LM.RIGHT_HIP), 0.07, heatMaterial(a("glutes:R")), ["glutes"]);
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
