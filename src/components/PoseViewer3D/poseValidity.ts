import * as THREE from "three";
import { resolveBoneName, computeDirection, computeMidpoint } from "./retarget";
import { LM, type RawLandmark } from "./muscles";
import type { GoldenPose } from "./golden";

/**
 * ポーズ品質の定量指標（#84）。
 *
 * ゴールデン（および将来はパイプライン出力）の品質を AI/人間の目視でなく
 * 数値で判定するためのハーネス:
 * - 指標B-1: 関節可動域（ROM）チェック — golden JSON の bind 相対 Euler が
 *   解剖学的範囲に収まるか
 * - 指標B-2: 自己めり込みチェック — 体幹/頭/四肢のカプセル近似で相互侵入を検出
 * - 指標A: 実写真との landmark 整合 — 2 つの landmark 配列のセグメント方向を
 *   ヨー正規化して比較
 *
 * しきい値・半径はすべて「明白な破綻を検出する粗い網」の経験値で、
 * 各定数オブジェクトに集約してある（過剰精密化しない — #84 の設計方針）。
 */

/** 軸ごとの可動域（度）。golden JSON と同じ bind 相対 Euler XYZ の意味で解釈する */
export type AxisRange = { min: number; max: number };
export type RomLimit = { x?: AxisRange; y?: AxisRange; z?: AxisRange };

/**
 * 左半身基準の ROM テーブル（度・経験値）。右側は Y/Z 軸の範囲をミラー
 * （[min,max] → [-max,-min]）して使う。X 軸（屈曲）は左右で符号が同じ
 * （実データ: 両膝 +X 屈曲、両肩 X=60）。
 * Hips はポーズ全体の向きなので対象外。体幹はセグメント単位の粗い上限。
 */
export const ROM_LIMITS_LEFT: Record<string, RomLimit> = {
  Spine: { x: { min: -45, max: 45 }, y: { min: -40, max: 40 }, z: { min: -40, max: 40 } },
  Spine1: {
    x: { min: -45, max: 45 },
    y: { min: -40, max: 40 },
    z: { min: -40, max: 40 },
  },
  Spine2: {
    x: { min: -45, max: 45 },
    y: { min: -40, max: 40 },
    z: { min: -40, max: 40 },
  },
  Neck: { x: { min: -60, max: 60 }, y: { min: -70, max: 70 }, z: { min: -45, max: 45 } },
  Head: { x: { min: -70, max: 70 }, y: { min: -70, max: 70 }, z: { min: -45, max: 45 } },
  LeftArm: {
    x: { min: -90, max: 170 },
    y: { min: -90, max: 90 },
    z: { min: -135, max: 135 },
  },
  LeftForeArm: {
    x: { min: -5, max: 150 },
    y: { min: -90, max: 90 },
    z: { min: -10, max: 10 },
  },
  LeftHand: {
    x: { min: -80, max: 80 },
    y: { min: -30, max: 30 },
    z: { min: -40, max: 40 },
  },
  LeftUpLeg: {
    x: { min: -135, max: 30 },
    y: { min: -60, max: 60 },
    z: { min: -40, max: 90 },
  },
  LeftLeg: {
    x: { min: -5, max: 155 },
    y: { min: -45, max: 45 },
    z: { min: -20, max: 20 },
  },
  LeftFoot: {
    x: { min: -50, max: 70 },
    y: { min: -35, max: 35 },
    z: { min: -35, max: 35 },
  },
};

const mirrorRange = (r: AxisRange): AxisRange => ({ min: -r.max, max: -r.min });

/** ボーン名（mixamorig 標準名）に対応する ROM を返す。右側は左をミラー */
export const romLimitFor = (stdName: string): RomLimit | null => {
  if (ROM_LIMITS_LEFT[stdName]) return ROM_LIMITS_LEFT[stdName];
  if (stdName.startsWith("Right")) {
    const left = ROM_LIMITS_LEFT[stdName.replace(/^Right/, "Left")];
    if (!left) return null;
    return {
      x: left.x,
      y: left.y ? mirrorRange(left.y) : undefined,
      z: left.z ? mirrorRange(left.z) : undefined,
    };
  }
  return null;
};

export type RomViolation = {
  bone: string;
  axis: "x" | "y" | "z";
  valueDeg: number;
  minDeg: number;
  maxDeg: number;
  /** 範囲からの超過量（度・正値） */
  excessDeg: number;
};

/** golden JSON の全ボーン回転を ROM テーブルと照合し、違反を列挙する */
export const checkGoldenRom = (golden: GoldenPose): RomViolation[] => {
  const out: RomViolation[] = [];
  for (const [bone, euler] of Object.entries(golden.rotations)) {
    const limit = romLimitFor(bone);
    if (!limit) continue;
    const axes: ["x" | "y" | "z", number][] = [
      ["x", euler[0]],
      ["y", euler[1]],
      ["z", euler[2]],
    ];
    for (const [axis, value] of axes) {
      const range = limit[axis];
      if (!range) continue;
      if (value < range.min || value > range.max) {
        out.push({
          bone,
          axis,
          valueDeg: value,
          minDeg: range.min,
          maxDeg: range.max,
          excessDeg: value < range.min ? range.min - value : value - range.max,
        });
      }
    }
  }
  return out;
};

/**
 * 自己めり込み検出のパラメータ。半径はマネキンメッシュの目視実測に基づく
 * 概算値（m）。contactToleranceM はヨガポーズで正当な接触（胸前クロスの腕、
 * 組んだ脚）を違反にしないための許容侵入深さ。
 */
export const SELF_PENETRATION = {
  radiusM: {
    torso: 0.13,
    head: 0.09,
    upperArm: 0.045,
    foreArm: 0.04,
    hand: 0.04,
    thigh: 0.07,
    calf: 0.055,
    foot: 0.04,
  },
  contactToleranceM: 0.03,
} as const;

export type SegmentCapsule = {
  name: string;
  a: THREE.Vector3;
  b: THREE.Vector3;
  radius: number;
};

/** 2 線分間の最短距離（クランプ付き標準アルゴリズム） */
export const segmentDistance = (
  p1: THREE.Vector3,
  q1: THREE.Vector3,
  p2: THREE.Vector3,
  q2: THREE.Vector3
): number => {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s: number;
  let t: number;
  const EPS = 1e-12;
  if (a <= EPS && e <= EPS) {
    return r.length();
  }
  if (a <= EPS) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > EPS ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  const c1 = p1.clone().add(d1.multiplyScalar(s));
  const c2 = p2.clone().add(d2.multiplyScalar(t));
  return c1.distanceTo(c2);
};

/** ボーン名ペア（親→子）から world 座標のカプセルを作る内部ヘルパ */
type CapsuleSpec = {
  name: string;
  fromBone: string;
  toBone: string;
  radius: number;
};

const CAPSULE_SPECS: CapsuleSpec[] = [
  {
    name: "torso",
    fromBone: "mixamorig:Spine",
    toBone: "mixamorig:Neck",
    radius: SELF_PENETRATION.radiusM.torso,
  },
  {
    name: "head",
    fromBone: "mixamorig:Head",
    toBone: "",
    radius: SELF_PENETRATION.radiusM.head,
  },
  {
    name: "upperArm:L",
    fromBone: "mixamorig:LeftArm",
    toBone: "mixamorig:LeftForeArm",
    radius: SELF_PENETRATION.radiusM.upperArm,
  },
  {
    name: "upperArm:R",
    fromBone: "mixamorig:RightArm",
    toBone: "mixamorig:RightForeArm",
    radius: SELF_PENETRATION.radiusM.upperArm,
  },
  {
    name: "foreArm:L",
    fromBone: "mixamorig:LeftForeArm",
    toBone: "mixamorig:LeftHand",
    radius: SELF_PENETRATION.radiusM.foreArm,
  },
  {
    name: "foreArm:R",
    fromBone: "mixamorig:RightForeArm",
    toBone: "mixamorig:RightHand",
    radius: SELF_PENETRATION.radiusM.foreArm,
  },
  {
    name: "thigh:L",
    fromBone: "mixamorig:LeftUpLeg",
    toBone: "mixamorig:LeftLeg",
    radius: SELF_PENETRATION.radiusM.thigh,
  },
  {
    name: "thigh:R",
    fromBone: "mixamorig:RightUpLeg",
    toBone: "mixamorig:RightLeg",
    radius: SELF_PENETRATION.radiusM.thigh,
  },
  {
    name: "calf:L",
    fromBone: "mixamorig:LeftLeg",
    toBone: "mixamorig:LeftFoot",
    radius: SELF_PENETRATION.radiusM.calf,
  },
  {
    name: "calf:R",
    fromBone: "mixamorig:RightLeg",
    toBone: "mixamorig:RightFoot",
    radius: SELF_PENETRATION.radiusM.calf,
  },
  {
    name: "foot:L",
    fromBone: "mixamorig:LeftFoot",
    toBone: "mixamorig:LeftToeBase",
    radius: SELF_PENETRATION.radiusM.foot,
  },
  {
    name: "foot:R",
    fromBone: "mixamorig:RightFoot",
    toBone: "mixamorig:RightToeBase",
    radius: SELF_PENETRATION.radiusM.foot,
  },
];

/**
 * 正当な近接・接続で常時オーバーラップするため検査から除外するペア。
 * 隣接関節（同一チェーン）と、解剖学的に常に近い体幹まわり。
 */
const EXCLUDED_PAIRS = new Set(
  [
    ["torso", "head"],
    ["torso", "upperArm:L"],
    ["torso", "upperArm:R"],
    ["torso", "thigh:L"],
    ["torso", "thigh:R"],
    ["head", "upperArm:L"],
    ["head", "upperArm:R"],
    ["upperArm:L", "foreArm:L"],
    ["upperArm:R", "foreArm:R"],
    ["thigh:L", "thigh:R"],
    ["thigh:L", "calf:L"],
    ["thigh:R", "calf:R"],
    ["calf:L", "foot:L"],
    ["calf:R", "foot:R"],
  ].map((p) => p.sort().join("|"))
);

/**
 * ポーズ適用済みスケルトンから体節カプセルを作る。
 * head は Head ボーンの子（HeadTop 等）があれば線分、無ければ点カプセル。
 * 解決できない体節はスキップする（テスト用の簡易リグ対応）。
 */
export const buildBodyCapsules = (root: THREE.Object3D): SegmentCapsule[] => {
  const boneMap = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) boneMap.set(child.name, child as THREE.Bone);
  });
  const boneNames = Array.from(boneMap.keys());
  root.updateMatrixWorld(true);

  const worldPos = (mixamoName: string): THREE.Vector3 | null => {
    const name = resolveBoneName(mixamoName, boneNames);
    const bone = name ? boneMap.get(name) : undefined;
    return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
  };

  const out: SegmentCapsule[] = [];
  for (const spec of CAPSULE_SPECS) {
    const a = worldPos(spec.fromBone);
    if (!a) continue;
    let b: THREE.Vector3 | null = null;
    if (spec.toBone) {
      b = worldPos(spec.toBone);
    } else {
      // head: Head ボーンの最初の子で線分化（無ければ点）
      const name = resolveBoneName(spec.fromBone, boneNames);
      const bone = name ? boneMap.get(name) : undefined;
      const child = bone?.children[0];
      b = child ? child.getWorldPosition(new THREE.Vector3()) : a.clone();
    }
    if (!b) continue;
    out.push({ name: spec.name, a, b, radius: spec.radius });
  }
  return out;
};

export type Penetration = {
  a: string;
  b: string;
  /** 表面同士の侵入深さ（m。接触許容を差し引く前の生値） */
  depthM: number;
};

/**
 * カプセル同士の相互侵入を検出する。深さが contactToleranceM を超えるペア
 * のみ違反として返す（ヨガの正当な接触を許容するため）。
 */
export const detectSelfPenetrations = (
  capsules: SegmentCapsule[],
  contactToleranceM: number = SELF_PENETRATION.contactToleranceM
): Penetration[] => {
  const out: Penetration[] = [];
  for (let i = 0; i < capsules.length; i++) {
    for (let j = i + 1; j < capsules.length; j++) {
      const ca = capsules[i];
      const cb = capsules[j];
      const key = [ca.name, cb.name].sort().join("|");
      if (EXCLUDED_PAIRS.has(key)) continue;
      const dist = segmentDistance(ca.a, ca.b, cb.a, cb.b);
      const depth = ca.radius + cb.radius - dist;
      if (depth > contactToleranceM) {
        out.push({ a: ca.name, b: cb.name, depthM: depth });
      }
    }
  }
  return out.sort((x, y) => y.depthM - x.depthM);
};

/** landmark 整合比較のパラメータ */
export const LANDMARK_MATCH = {
  /** 両側の endpoint がこの visibility 以上のセグメントのみ比較する */
  minVisibility: 0.5,
} as const;

type SegmentDef = { name: string; from: number; to: number };

const MATCH_SEGMENTS: SegmentDef[] = [
  { name: "torso", from: -1, to: -2 }, // 特殊: hip 中点 → shoulder 中点
  { name: "upperArm:L", from: LM.LEFT_SHOULDER, to: LM.LEFT_ELBOW },
  { name: "upperArm:R", from: LM.RIGHT_SHOULDER, to: LM.RIGHT_ELBOW },
  { name: "foreArm:L", from: LM.LEFT_ELBOW, to: LM.LEFT_WRIST },
  { name: "foreArm:R", from: LM.RIGHT_ELBOW, to: LM.RIGHT_WRIST },
  { name: "thigh:L", from: LM.LEFT_HIP, to: LM.LEFT_KNEE },
  { name: "thigh:R", from: LM.RIGHT_HIP, to: LM.RIGHT_KNEE },
  { name: "calf:L", from: LM.LEFT_KNEE, to: LM.LEFT_ANKLE },
  { name: "calf:R", from: LM.RIGHT_KNEE, to: LM.RIGHT_ANKLE },
];

/** hip line（右→左）の水平方位角。ヨー正規化に使う */
const hipYaw = (lm: RawLandmark[]): number | null => {
  const dir = computeDirection(lm[LM.RIGHT_HIP], lm[LM.LEFT_HIP]);
  if (!dir) return null;
  const horiz = new THREE.Vector3(dir.x, 0, dir.z);
  if (horiz.lengthSq() < 1e-8) return null;
  return Math.atan2(horiz.z, horiz.x);
};

export type SegmentMatch = {
  segment: string;
  angleDeg: number;
};

export type LandmarkMatchResult = {
  segments: SegmentMatch[];
  /** 比較できたセグメントの平均角度差（°）。1 つも無ければ null */
  meanDeg: number | null;
  /** visibility 不足等で比較から除外したセグメント名 */
  skipped: string[];
};

const segmentDir = (lm: RawLandmark[], def: SegmentDef): THREE.Vector3 | null => {
  if (def.name === "torso") {
    const hipMid = computeMidpoint(lm[LM.LEFT_HIP], lm[LM.RIGHT_HIP]);
    const shMid = computeMidpoint(lm[LM.LEFT_SHOULDER], lm[LM.RIGHT_SHOULDER]);
    if (!hipMid || !shMid) return null;
    const d = shMid.sub(hipMid);
    return d.lengthSq() > 0 ? d.normalize() : null;
  }
  return computeDirection(lm[def.from], lm[def.to]);
};

const segmentVisible = (lm: RawLandmark[], def: SegmentDef, min: number): boolean => {
  const idxs =
    def.name === "torso"
      ? [LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER]
      : [def.from, def.to];
  return idxs.every((i) => {
    const v = lm[i]?.visibility;
    return v === undefined || v >= min;
  });
};

/**
 * 2 つの landmark 配列（例: ゴールデンレンダーの推定結果 vs 実写真の推定結果）
 * のセグメント方向を比較する（指標A）。b 側を hip line のヨー差で a に揃えて
 * から 3D 角度差を取る。visibility が低いセグメントは除外して skipped に載せる。
 */
export const compareLandmarkPoses = (
  a: RawLandmark[],
  b: RawLandmark[]
): LandmarkMatchResult => {
  const yawA = hipYaw(a);
  const yawB = hipYaw(b);
  // setFromAxisAngle(Y, ψ) は atan2(z,x) 基準の方位角を ψ だけ減らすため、
  // b の方位角を a に揃える回転は ψ = yawB - yawA
  const yawDelta = yawA !== null && yawB !== null ? yawB - yawA : 0;
  const yawQ = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    yawDelta
  );

  const segments: SegmentMatch[] = [];
  const skipped: string[] = [];
  for (const def of MATCH_SEGMENTS) {
    if (
      !segmentVisible(a, def, LANDMARK_MATCH.minVisibility) ||
      !segmentVisible(b, def, LANDMARK_MATCH.minVisibility)
    ) {
      skipped.push(def.name);
      continue;
    }
    const da = segmentDir(a, def);
    const db = segmentDir(b, def);
    if (!da || !db) {
      skipped.push(def.name);
      continue;
    }
    const dbAligned = db.clone().applyQuaternion(yawQ);
    segments.push({
      segment: def.name,
      angleDeg: THREE.MathUtils.radToDeg(da.angleTo(dbAligned)),
    });
  }
  const meanDeg =
    segments.length > 0
      ? segments.reduce((s, m) => s + m.angleDeg, 0) / segments.length
      : null;
  return { segments, meanDeg, skipped };
};
