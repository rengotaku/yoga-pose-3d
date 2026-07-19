import * as THREE from "three";
import { resolveBoneName } from "./retarget";

/**
 * ゴールデンポーズ（#71/#72）。リターゲットパイプラインを通さない手付けの
 * 正解ボーン回転で、パイプライン出力との角度誤差から再現精度スコアを出す。
 *
 * rotations のキーは mixamorig 標準名（retarget.ts の BONE_ALIASES キー）。
 * 値はバインドポーズからの相対回転（XYZ オーダーの Euler 度）。
 */
export type GoldenPose = {
  pose: string;
  description?: string;
  rotations: Record<string, [number, number, number]>;
};

export type QuatTuple = [number, number, number, number];

export type JointScore = {
  angleDeg: number;
  score: number;
  weight: number;
};

export type PoseScore = {
  /** 重み付き平均を 0〜100 に換算した総合スコア */
  total: number;
  joints: Record<string, JointScore>;
  /** golden/actual のどちらかで解決できずスコア対象外になったボーン */
  missing: string[];
};

/**
 * スコア対象ボーン（mixamorig 標準名）と重み。リターゲットが駆動する
 * ボーンのみを対象にする（foot/ball/clavicle は駆動対象外のため除外）。
 * 重みは「ポーズの見た目への寄与」の主観設計（ADR 0007）:
 * 体幹・大腿 > 前腕・下腿 > 手。
 */
export const SCORE_BONE_WEIGHTS: Record<string, number> = {
  Hips: 2.0,
  Spine: 1.0,
  Spine1: 1.0,
  Spine2: 1.0,
  Head: 1.0,
  LeftArm: 1.5,
  LeftForeArm: 1.25,
  LeftHand: 0.5,
  RightArm: 1.5,
  RightForeArm: 1.25,
  RightHand: 0.5,
  LeftUpLeg: 1.5,
  LeftLeg: 1.25,
  RightUpLeg: 1.5,
  RightLeg: 1.25,
};

/** 角度誤差→関節スコアの換算。90° ズレで 0 点になる線形減点（ADR 0007） */
export const ANGLE_FOR_ZERO_SCORE = 90;

const collectBones = (root: THREE.Object3D): Map<string, THREE.Bone> => {
  const bones = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      bones.set(child.name, child as THREE.Bone);
    }
  });
  return bones;
};

/**
 * ゴールデンポーズをスケルトンへ直接適用する（リターゲット非経由）。
 * initialQuaternions（バインドポーズ）へリセットした上で、各エントリを
 * bind * euler(XYZ 度) の相対回転として乗せる。
 * @returns 解決できなかったボーン名（呼び出し側で警告表示に使う）
 */
export const applyGoldenRotations = (
  root: THREE.Object3D,
  initialQuaternions: Map<string, THREE.Quaternion>,
  golden: GoldenPose
): string[] => {
  const bones = collectBones(root);
  const boneNames = Array.from(bones.keys());

  for (const [name, bone] of bones) {
    const q = initialQuaternions.get(name);
    if (q) bone.quaternion.copy(q);
  }

  const unresolved: string[] = [];
  for (const [stdName, euler] of Object.entries(golden.rotations)) {
    const actualName = resolveBoneName(stdName, boneNames);
    const bone = actualName ? bones.get(actualName) : undefined;
    if (!bone) {
      unresolved.push(stdName);
      continue;
    }
    const offset = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(euler[0]),
        THREE.MathUtils.degToRad(euler[1]),
        THREE.MathUtils.degToRad(euler[2]),
        "XYZ"
      )
    );
    bone.quaternion.multiply(offset);
  }
  root.updateMatrixWorld(true);
  return unresolved;
};

/**
 * スコア対象ボーンの world 回転を取り出す。ローカル回転でなく world を使う
 * ことで、親チェーンの誤差配分の違い（例: spine 3 分配のバランス差）に
 * よらず「見た目の向きのズレ」を測る。
 */
export const exportWorldRotations = (root: THREE.Object3D): Record<string, QuatTuple> => {
  const bones = collectBones(root);
  const boneNames = Array.from(bones.keys());
  root.updateMatrixWorld(true);

  const out: Record<string, QuatTuple> = {};
  const q = new THREE.Quaternion();
  for (const stdName of Object.keys(SCORE_BONE_WEIGHTS)) {
    const actualName = resolveBoneName(stdName, boneNames);
    const bone = actualName ? bones.get(actualName) : undefined;
    if (!bone) continue;
    bone.getWorldQuaternion(q);
    out[stdName] = [q.x, q.y, q.z, q.w];
  }
  return out;
};

/** 2 つの回転の測地角度差（度）。q と -q の同値性を考慮する */
export const quaternionAngleDeg = (a: QuatTuple, b: QuatTuple): number => {
  const qa = new THREE.Quaternion(a[0], a[1], a[2], a[3]).normalize();
  const qb = new THREE.Quaternion(b[0], b[1], b[2], b[3]).normalize();
  const dot = Math.min(1, Math.abs(qa.dot(qb)));
  return THREE.MathUtils.radToDeg(2 * Math.acos(dot));
};

/**
 * golden→actual の Hips 相対回転から、world Y 軸まわりのツイスト成分（ヨー）
 * を swing-twist 分解で抽出する（#76）。写真の人物の向きとゴールデンの向き
 * （+Z 正面）の差はポーズ誤差ではないため、採点前に actual 側から取り除く。
 * ピッチ/ロールのグローバル差は重力軸に対する実誤差なので正規化しない。
 */
export const computeYawAlignment = (
  golden: Record<string, QuatTuple>,
  actual: Record<string, QuatTuple>
): THREE.Quaternion => {
  const g = golden.Hips;
  const a = actual.Hips;
  if (!g || !a) return new THREE.Quaternion();
  const qg = new THREE.Quaternion(g[0], g[1], g[2], g[3]).normalize();
  const qa = new THREE.Quaternion(a[0], a[1], a[2], a[3]).normalize();
  const rel = qg.multiply(qa.invert());
  // swing-twist 分解: Y 軸成分だけ残して正規化するとヨー成分になる
  const twist = new THREE.Quaternion(0, rel.y, 0, rel.w);
  if (twist.lengthSq() < 1e-12) return new THREE.Quaternion();
  return twist.normalize();
};

/**
 * パイプライン出力（actual）とゴールデン（golden）の world 回転からスコアを
 * 算出する。actual は Hips 基準のヨー正規化（#76）を掛けてから比較する。
 * 関節スコア = max(0, 1 - 角度差/90°)、総合 = 重み付き平均 × 100。
 */
export const scorePose = (
  golden: Record<string, QuatTuple>,
  actual: Record<string, QuatTuple>
): PoseScore => {
  const joints: Record<string, JointScore> = {};
  const missing: string[] = [];
  let weightedSum = 0;
  let weightTotal = 0;
  const yaw = computeYawAlignment(golden, actual);

  for (const [stdName, weight] of Object.entries(SCORE_BONE_WEIGHTS)) {
    const g = golden[stdName];
    const a = actual[stdName];
    if (!g || !a) {
      missing.push(stdName);
      continue;
    }
    const aligned = yaw
      .clone()
      .multiply(new THREE.Quaternion(a[0], a[1], a[2], a[3]).normalize());
    const angleDeg = quaternionAngleDeg(g, [aligned.x, aligned.y, aligned.z, aligned.w]);
    const score = Math.max(0, 1 - angleDeg / ANGLE_FOR_ZERO_SCORE);
    joints[stdName] = { angleDeg, score, weight };
    weightedSum += score * weight;
    weightTotal += weight;
  }

  return {
    total: weightTotal > 0 ? (weightedSum / weightTotal) * 100 : 0,
    joints,
    missing,
  };
};
