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
  /**
   * 床に接地しているべき部位（#90）。接地ゲートが各部位の関節ボーンの
   * 床高さを測定して浮きを検出する。値は poseValidity.ts の CONTACT_BONES
   * のキー（例: "hand:L", "knee:R", "toe:L", "hip"）。
   */
  contacts?: string[];
  /**
   * 手のひらを床向き（-Y）に保つべき手（#90）。接地ゲートと併せて
   * 「指先立ち」でなく「手のひら接地」を保証する。値は "left" / "right"。
   */
  palmsDown?: ("left" | "right")[];
};

export type QuatTuple = [number, number, number, number];

export type JointScore = {
  angleDeg: number;
  score: number;
  weight: number;
  /** ボーン方向（子方向）のズレ角。childDirs 未対応の関節は null（#102） */
  swingDeg: number | null;
  /** swing を除いた残差（≒ボーン軸まわりツイスト）。childDirs 未対応の関節は null（#102） */
  twistDeg: number | null;
  /** swingDeg を ANGLE_FOR_ZERO_SCORE で線形換算したスコア。childDirs 未対応の関節は null（#102） */
  swingScore: number | null;
  /** twistDeg を ANGLE_FOR_ZERO_SCORE で線形換算したスコア。childDirs 未対応の関節は null（#102） */
  twistScore: number | null;
};

export type PoseScore = {
  /** 重み付き平均を 0〜100 に換算した総合スコア */
  total: number;
  joints: Record<string, JointScore>;
  /** golden/actual のどちらかで解決できずスコア対象外になったボーン */
  missing: string[];
  /**
   * サマリ（#102）。swingAvg/twistAvg は childDirs 対応の関節に限定した
   * 重み付き平均スコア（0〜1、1 が満点）。対応関節が 0 件なら null。
   */
  summary: {
    swingAvg: number | null;
    twistAvg: number | null;
    coverage: {
      /** joints に採点として入った関節数 */
      scored: number;
      /** golden/actual どちらかが欠損してスコア対象外になった関節数 */
      missing: number;
      /** scored / (scored + missing) */
      ratio: number;
    };
  };
  /** 関節スコア（0〜1）の分位点。関節数 <2 の場合は total/100 で埋める */
  stats: {
    p10: number;
    median: number;
    min: number;
  };
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

/**
 * スコア対象ボーンの「子方向単位ベクトル（ボーン local）」を取り出す（#82 診断用）。
 * swing/twist 分解の回転軸に使う。子を持たないボーンは含まれない。
 */
export const exportBoneChildDirs = (
  root: THREE.Object3D
): Record<string, [number, number, number]> => {
  const bones = collectBones(root);
  const boneNames = Array.from(bones.keys());

  const out: Record<string, [number, number, number]> = {};
  for (const stdName of Object.keys(SCORE_BONE_WEIGHTS)) {
    const actualName = resolveBoneName(stdName, boneNames);
    const bone = actualName ? bones.get(actualName) : undefined;
    if (!bone || bone.children.length === 0) continue;
    const dir = bone.children[0].position.clone();
    if (dir.lengthSq() < 1e-12) continue;
    dir.normalize();
    out[stdName] = [dir.x, dir.y, dir.z];
  }
  return out;
};

export type JointDiag = {
  angleDeg: number;
  /** ボーン方向（子方向）のズレ角。childDirs に無いボーンは null */
  swingDeg: number | null;
  /** swing を除いた残差（≒ボーン軸まわりツイスト）。childDirs に無いボーンは null */
  twistDeg: number | null;
};

/**
 * golden/actual の角度差を swing（ボーン方向のズレ）と twist（swing 除去後の
 * 残差 ≒ ボーン軸まわり）に分解する診断（#82）。ヨー正規化は scorePose と同一。
 * 「方向は合っているのにスコアが低い」（ツイスト未制御）と「方向自体がズレている」
 * （landmark 入力・深度潰れ）を切り分けるために使う。
 */
export const diagnosePose = (
  golden: Record<string, QuatTuple>,
  actual: Record<string, QuatTuple>,
  childDirs: Record<string, [number, number, number]>
): Record<string, JointDiag> => {
  const yaw = computeYawAlignment(golden, actual);
  const out: Record<string, JointDiag> = {};

  for (const stdName of Object.keys(SCORE_BONE_WEIGHTS)) {
    const g = golden[stdName];
    const a = actual[stdName];
    if (!g || !a) continue;
    const qg = new THREE.Quaternion(g[0], g[1], g[2], g[3]).normalize();
    const qa = yaw
      .clone()
      .multiply(new THREE.Quaternion(a[0], a[1], a[2], a[3]).normalize());
    const angleDeg = quaternionAngleDeg(g, [qa.x, qa.y, qa.z, qa.w]);

    const v = childDirs[stdName];
    if (!v) {
      out[stdName] = { angleDeg, swingDeg: null, twistDeg: null };
      continue;
    }
    const local = new THREE.Vector3(v[0], v[1], v[2]);
    const dg = local.clone().applyQuaternion(qg).normalize();
    const da = local.clone().applyQuaternion(qa).normalize();
    const swingDeg = THREE.MathUtils.radToDeg(da.angleTo(dg));
    const swing = new THREE.Quaternion().setFromUnitVectors(da, dg);
    const rectified = swing.multiply(qa);
    const twistDeg = quaternionAngleDeg(
      [qg.x, qg.y, qg.z, qg.w],
      [rectified.x, rectified.y, rectified.z, rectified.w]
    );
    out[stdName] = { angleDeg, swingDeg, twistDeg };
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
 * 関節スコア（0〜1）の分位点を線形補間で求める（#102）。
 * 関節数が 2 未満の場合は total（0〜100）から換算した値で全項目を埋める。
 */
const computeStats = (
  joints: Record<string, JointScore>,
  total: number
): PoseScore["stats"] => {
  const scores = Object.values(joints)
    .map((j) => j.score)
    .sort((a, b) => a - b);

  if (scores.length < 2) {
    const fallback = total / 100;
    return { p10: fallback, median: fallback, min: fallback };
  }

  const quantile = (p: number): number => {
    const idx = (p / 100) * (scores.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return scores[lower];
    const frac = idx - lower;
    return scores[lower] * (1 - frac) + scores[upper] * frac;
  };

  return { p10: quantile(10), median: quantile(50), min: scores[0] };
};

/**
 * パイプライン出力（actual）とゴールデン（golden）の world 回転からスコアを
 * 算出する。actual は Hips 基準のヨー正規化（#76）を掛けてから比較する。
 * 関節スコア = max(0, 1 - 角度差/90°)、総合 = 重み付き平均 × 100。
 *
 * childDirs（#82 diagnosePose の入力・#102 で任意化）を渡すと、関節ごとの
 * swing/twist 角度・スコアと summary.swingAvg/twistAvg も算出する。未指定の
 * 場合は swing/twist 系はすべて null になる（総合スコア `total` は不変）。
 */
export const scorePose = (
  golden: Record<string, QuatTuple>,
  actual: Record<string, QuatTuple>,
  childDirs?: Record<string, [number, number, number]>
): PoseScore => {
  const joints: Record<string, JointScore> = {};
  const missing: string[] = [];
  let weightedSum = 0;
  let weightTotal = 0;
  let swingWeightedSum = 0;
  let swingWeightTotal = 0;
  let twistWeightedSum = 0;
  let twistWeightTotal = 0;
  const yaw = computeYawAlignment(golden, actual);
  const diag = childDirs ? diagnosePose(golden, actual, childDirs) : undefined;

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

    const d = diag?.[stdName];
    const swingDeg = d?.swingDeg ?? null;
    const twistDeg = d?.twistDeg ?? null;
    const swingScore =
      swingDeg == null ? null : Math.max(0, 1 - swingDeg / ANGLE_FOR_ZERO_SCORE);
    const twistScore =
      twistDeg == null ? null : Math.max(0, 1 - twistDeg / ANGLE_FOR_ZERO_SCORE);

    joints[stdName] = {
      angleDeg,
      score,
      weight,
      swingDeg,
      twistDeg,
      swingScore,
      twistScore,
    };
    weightedSum += score * weight;
    weightTotal += weight;
    if (swingScore != null) {
      swingWeightedSum += swingScore * weight;
      swingWeightTotal += weight;
    }
    if (twistScore != null) {
      twistWeightedSum += twistScore * weight;
      twistWeightTotal += weight;
    }
  }

  const total = weightTotal > 0 ? (weightedSum / weightTotal) * 100 : 0;
  const scoredCount = Object.keys(joints).length;
  const missingCount = missing.length;

  return {
    total,
    joints,
    missing,
    summary: {
      swingAvg: swingWeightTotal > 0 ? swingWeightedSum / swingWeightTotal : null,
      twistAvg: twistWeightTotal > 0 ? twistWeightedSum / twistWeightTotal : null,
      coverage: {
        scored: scoredCount,
        missing: missingCount,
        ratio:
          scoredCount + missingCount > 0 ? scoredCount / (scoredCount + missingCount) : 0,
      },
    },
    stats: computeStats(joints, total),
  };
};
