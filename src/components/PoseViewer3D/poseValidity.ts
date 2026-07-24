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
    chest: 0.13,
    abdomen: 0.1,
    pelvis: 0.13,
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

export const CAPSULE_SPECS: CapsuleSpec[] = [
  {
    name: "chest",
    fromBone: "mixamorig:Spine1",
    toBone: "mixamorig:Neck",
    radius: SELF_PENETRATION.radiusM.chest,
  },
  {
    name: "abdomen",
    fromBone: "mixamorig:Spine",
    toBone: "mixamorig:Spine1",
    radius: SELF_PENETRATION.radiusM.abdomen,
  },
  {
    name: "pelvis",
    fromBone: "mixamorig:Hips",
    toBone: "mixamorig:Spine",
    radius: SELF_PENETRATION.radiusM.pelvis,
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
    name: "hand:L",
    fromBone: "mixamorig:LeftHand",
    toBone: "mixamorig:LeftHandMiddle1",
    radius: SELF_PENETRATION.radiusM.hand,
  },
  {
    name: "hand:R",
    fromBone: "mixamorig:RightHand",
    toBone: "mixamorig:RightHandMiddle1",
    radius: SELF_PENETRATION.radiusM.hand,
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
export const EXCLUDED_PAIRS = new Set(
  [
    ["chest", "abdomen"],
    ["abdomen", "pelvis"],
    ["chest", "pelvis"],
    ["chest", "head"],
    ["chest", "upperArm:L"],
    ["chest", "upperArm:R"],
    ["pelvis", "thigh:L"],
    ["pelvis", "thigh:R"],
    ["abdomen", "thigh:L"],
    ["abdomen", "thigh:R"],
    ["upperArm:L", "foreArm:L"],
    ["upperArm:R", "foreArm:R"],
    ["foreArm:L", "hand:L"],
    ["foreArm:R", "hand:R"],
    ["thigh:L", "calf:L"],
    ["thigh:R", "calf:R"],
    ["calf:L", "foot:L"],
    ["calf:R", "foot:R"],
  ].map((p) => p.sort().join("|"))
);

/**
 * ポーズ適用済みスケルトンから体節カプセルを作る。
 * head は Head ボーンの子（HeadTop 等）があれば線分、無ければ点カプセル（hand は toBone を明示指定するため対象外）。
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

/**
 * 接地ゲート（#90）。groundMannequin は最下点 1 点しか床に合わせないため、
 * 「膝が浮く」を検出できない。接地すべき部位について、その部位が支配する
 * スキン頂点の最下点が床にどれだけ近いかを測る（ボーン位置でなく実表面で
 * 判定するので、前に伸びた平手のように関節ボーンが浮いていても手のひらが
 * 床に着いていれば接地と判定できる。指先立ち等「そもそも面が着かない」は
 * 手の向きゲートが別途拾う）。
 *
 * 各接地部位は「支配ボーン名のサフィックス集合」で定義する。
 */
export const CONTACT_PART_BONES: Record<string, string[]> = {
  "hand:L": ["LeftHand", "hand_l"],
  "hand:R": ["RightHand", "hand_r"],
  "knee:L": ["LeftLeg", "calf_l"],
  "knee:R": ["RightLeg", "calf_r"],
  "toe:L": ["LeftToeBase", "LeftFoot", "ball_l", "foot_l"],
  "toe:R": ["RightToeBase", "RightFoot", "ball_r", "foot_r"],
  "ankle:L": ["LeftFoot", "foot_l"],
  "ankle:R": ["RightFoot", "foot_r"],
  hip: ["Hips", "pelvis"],
};

/**
 * 接地とみなす床からの最大高さ（m）。スキン表面基準。マネキンの体型比率
 * （腕>腿）上、複数部位を完全に同一平面へ落とすのは難しく、視覚的に接地
 * している良ポーズでも残差 10cm 程度が出る（実測）。この閾値は「明白な浮き
 * （指先立ちの膝浮き 23cm 等）を弾く粗い網」として校正した値で、sub-cm の
 * 厳密接地を課すものではない（#84 の設計方針・#90 で実測校正）。手のひら
 * 接地の質は手の向きゲート（PALM）が別途担保する。 */
export const CONTACT_MAX_CLEARANCE_M = 0.12;

export type ContactClearance = {
  part: string;
  /** 部位スキン最下点の床からの高さ（m）。接地なら ≈0、浮きなら大きい */
  clearanceM: number;
  grounded: boolean;
};

/** 部位（支配ボーンサフィックス集合）が持つスキン頂点の最下 world Y。無ければ null */
const partLowestY = (root: THREE.Object3D, suffixes: string[]): number | null => {
  let minY = Infinity;
  const v = new THREE.Vector3();
  root.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh) || !child.skeleton) return;
    const geom = child.geometry;
    const skinIndex = geom.getAttribute("skinIndex");
    const skinWeight = geom.getAttribute("skinWeight");
    if (!skinIndex || !skinWeight || !geom.hasAttribute("position")) return;
    const bones = child.skeleton.bones;
    const count = geom.getAttribute("position").count;
    for (let i = 0; i < count; i++) {
      let maxW = 0;
      let dom = 0;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w > maxW) {
          maxW = w;
          dom = skinIndex.getComponent(i, k);
        }
      }
      const name = bones[dom]?.name ?? "";
      if (!suffixes.some((s) => name.endsWith(s) || name === s)) continue;
      child.getVertexPosition(i, v);
      v.applyMatrix4(child.matrixWorld);
      if (v.y < minY) minY = v.y;
    }
  });
  return Number.isFinite(minY) ? minY : null;
};

/**
 * ポーズ適用・接地済みスケルトンについて、指定接地部位のスキン最下点の床
 * からの高さを測る。解決できない部位はスキップ。root は接地（groundMannequin）
 * 済みで呼ぶこと。
 */
export const computeContactClearances = (
  root: THREE.Object3D,
  parts: string[],
  floorY: number
): ContactClearance[] => {
  root.updateMatrixWorld(true);
  const out: ContactClearance[] = [];
  for (const part of parts) {
    const suffixes = CONTACT_PART_BONES[part];
    if (!suffixes) continue;
    const y = partLowestY(root, suffixes);
    if (y === null) continue;
    const clearanceM = y - floorY;
    out.push({ part, clearanceM, grounded: clearanceM <= CONTACT_MAX_CLEARANCE_M });
  }
  return out;
};

/**
 * 重力安定性チェック（#117）。
 *
 * 「重力を受けてもポーズが崩れないか」を、COM（重心）の水平投影が支持多角形
 * （接地部位の水平座標の凸包）に収まるかで判定する準静的モデル。物理シミュ
 * （rapier/cannon 等）は決定論性を損なうため使わない（親 #116 Decision Log #3）。
 *
 * 座標系: three.js の y-up。重力方向は -Y、水平面は XZ 平面。
 * 支持多角形は既存 contacts フィールド（CONTACT_PART_BONES のキー）を
 * 「期待接地集合」として再利用し、期待 ∩ 実接地の凸包とする（Decision Log #1）。
 * 実接地判定は既存 computeContactClearances / CONTACT_PART_BONES を流用し、
 * 独自の接地判定は作らない。
 */

/**
 * Winter (1990) の人体分節質量比（総体重比）。左右対称の四肢は片側の値
 * （実体重比は左右合算で 2 倍になる）。汎用の粗い網としての経験値であり、
 * 個体差は考慮しない（#84 の設計方針を踏襲）。合計はおよそ 1.0（欠損分節
 * を丸めた誤差を含み 0.98〜1.02 程度に収まる）。
 */
export const BODY_SEGMENT_MASS = {
  trunk: 0.497,
  headNeck: 0.0826,
  "upperArm:L": 0.028,
  "upperArm:R": 0.028,
  "foreArm:L": 0.016,
  "foreArm:R": 0.016,
  "hand:L": 0.006,
  "hand:R": 0.006,
  "thigh:L": 0.1,
  "thigh:R": 0.1,
  "calf:L": 0.045,
  "calf:R": 0.045,
  "foot:L": 0.0145,
  "foot:R": 0.0145,
} as const;

/**
 * 安定性判定の閾値集約（#117）。marginM は経験値で開始し、粗い網として運用する。
 *
 * #118 で既存 3 ポーズに対して実測校正した: kneel-sidebend（後屈サイド
 * リーチ）は COM 水平投影が膝・爪先の支持多角形境界からわずかに（実測
 * 約 3.6cm）外側へ出るが、実写真でも成立する現実のポーズであり破綻して
 * いない。COM モデル（Winter 分節質量比・骨ミッドポイント近似）と支持
 * 多角形（接地部位の骨位置のみ・足裏の実接地面積を無視）はどちらも粗い
 * 近似のため、数 cm の誤差は「明白な崩れを検出する粗い網」（#84 方針）の
 * 許容範囲とみなし marginM を負値に校正した。
 */
export const STABILITY = {
  /**
   * 支持多角形境界からの符号付き距離（内側正・外側負）がこれを超えれば
   * 安定と判定する（m）。負値は「境界の少し外側までは実用上安定とみなす」
   * ことを意味する（#118 校正、上記コメント参照）。
   */
  marginM: -0.04,
} as const;

type MassSegmentSpec = {
  key: keyof typeof BODY_SEGMENT_MASS;
  /** 質点を置く区間の始点ボーン（mixamorig 標準名）。toBone 省略時は単独の点として使う */
  fromBone: string;
  toBone?: string;
};

/**
 * 質点を置く区間の定義。buildBodyCapsules の CAPSULE_SPECS と同じ
 * from→to ボーン対で、区間の中点に質量を集約する。
 */
const MASS_SEGMENT_SPECS: MassSegmentSpec[] = [
  { key: "trunk", fromBone: "mixamorig:Spine", toBone: "mixamorig:Neck" },
  { key: "headNeck", fromBone: "mixamorig:Neck", toBone: "mixamorig:Head" },
  { key: "upperArm:L", fromBone: "mixamorig:LeftArm", toBone: "mixamorig:LeftForeArm" },
  { key: "upperArm:R", fromBone: "mixamorig:RightArm", toBone: "mixamorig:RightForeArm" },
  { key: "foreArm:L", fromBone: "mixamorig:LeftForeArm", toBone: "mixamorig:LeftHand" },
  { key: "foreArm:R", fromBone: "mixamorig:RightForeArm", toBone: "mixamorig:RightHand" },
  { key: "hand:L", fromBone: "mixamorig:LeftHand" },
  { key: "hand:R", fromBone: "mixamorig:RightHand" },
  { key: "thigh:L", fromBone: "mixamorig:LeftUpLeg", toBone: "mixamorig:LeftLeg" },
  { key: "thigh:R", fromBone: "mixamorig:RightUpLeg", toBone: "mixamorig:RightLeg" },
  { key: "calf:L", fromBone: "mixamorig:LeftLeg", toBone: "mixamorig:LeftFoot" },
  { key: "calf:R", fromBone: "mixamorig:RightLeg", toBone: "mixamorig:RightFoot" },
  { key: "foot:L", fromBone: "mixamorig:LeftFoot", toBone: "mixamorig:LeftToeBase" },
  { key: "foot:R", fromBone: "mixamorig:RightFoot", toBone: "mixamorig:RightToeBase" },
];

/** root 配下のボーン名 → THREE.Bone の対応表を作る（複数関数で共用する内部ヘルパ） */
const collectBoneMap = (root: THREE.Object3D): Map<string, THREE.Bone> => {
  const boneMap = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) boneMap.set(child.name, child as THREE.Bone);
  });
  return boneMap;
};

export type COMResult = {
  /** COM の world 座標（3D） */
  world: THREE.Vector3;
  /** COM の水平投影（XZ 平面） */
  xz: { x: number; z: number };
};

/**
 * 各体節（骨のミッドポイント）に Winter 質量比の質点を置き、加重平均で
 * 全身の COM（world 座標）を求める。解決できない体節はスキップし、実際に
 * 使えた質量の合計で正規化する（一部ボーンが無いテスト用簡易リグでも破綻しない）。
 */
export const computeCOM = (mannequin: THREE.Object3D): COMResult => {
  mannequin.updateMatrixWorld(true);
  const boneMap = collectBoneMap(mannequin);
  const boneNames = Array.from(boneMap.keys());

  const worldPos = (mixamoName: string): THREE.Vector3 | null => {
    const name = resolveBoneName(mixamoName, boneNames);
    const bone = name ? boneMap.get(name) : undefined;
    return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
  };

  const weighted = new THREE.Vector3();
  let totalWeight = 0;
  for (const spec of MASS_SEGMENT_SPECS) {
    const a = worldPos(spec.fromBone);
    if (!a) continue;
    const b = spec.toBone ? worldPos(spec.toBone) : null;
    const point = b ? a.add(b).multiplyScalar(0.5) : a;
    const weight = BODY_SEGMENT_MASS[spec.key];
    weighted.add(point.multiplyScalar(weight));
    totalWeight += weight;
  }
  if (totalWeight > 0) weighted.multiplyScalar(1 / totalWeight);
  return { world: weighted, xz: { x: weighted.x, z: weighted.z } };
};

export type SupportPolygonResult = {
  /** 凸包の頂点（時計回り）。3点未満は縮退（点 or 線分）で、そのまま返す */
  polygon: Array<{ x: number; z: number }>;
  /** 実際に支持として採用された接地キー（expectedContacts ∩ actualContacts） */
  usedBones: string[];
  /** 期待接地キーの全量（差分の観測用） */
  expectedBones: string[];
};

/**
 * 接地キー（CONTACT_PART_BONES のキー）に対応する別名リストのいずれかに
 * サフィックス一致するボーンを全て集め、その world XZ 座標を返す。
 * CONTACT_PART_BONES は「リグごとの命名ゆれの別名集合」なので、実在する
 * ボーンが複数（例: 足首相当と爪先相当の両方）あれば全て支持点候補にする。
 */
const contactPointsXZ = (
  boneMap: Map<string, THREE.Bone>,
  contactKey: string
): Array<{ x: number; z: number }> => {
  const suffixes = CONTACT_PART_BONES[contactKey];
  if (!suffixes) return [];
  const pts: Array<{ x: number; z: number }> = [];
  for (const [name, bone] of boneMap) {
    if (!suffixes.some((s) => name.endsWith(s) || name === s)) continue;
    const p = bone.getWorldPosition(new THREE.Vector3());
    pts.push({ x: p.x, z: p.z });
  }
  return pts;
};

/** 2D 点の凸包（monotone chain）。3点未満は重複除去のみして返す（縮退ケース） */
const convexHull2D = (
  points: Array<{ x: number; z: number }>
): Array<{ x: number; z: number }> => {
  const uniq: Array<{ x: number; z: number }> = [];
  for (const p of points) {
    if (!uniq.some((q) => Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.z - p.z) < 1e-9)) {
      uniq.push(p);
    }
  }
  if (uniq.length < 3) return uniq;

  const sorted = [...uniq].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.z - b.z));
  const cross = (
    o: { x: number; z: number },
    a: { x: number; z: number },
    b: { x: number; z: number }
  ): number => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  const lower: Array<{ x: number; z: number }> = [];
  for (const p of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<{ x: number; z: number }> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  // lower+upper は反時計回り。仕様（時計回り）に合わせて反転する
  return lower.concat(upper).reverse();
};

/**
 * 支持多角形を求める（Decision Log #1）。期待接地集合（expectedContacts）と
 * 実接地集合（actualContacts）の積集合のみを支持点として採用し、期待して
 * いない偶然の接触（例: 腕が床に触れているだけ）は寄与させない。
 */
export const computeSupportPolygon = (
  mannequin: THREE.Object3D,
  expectedContacts: string[],
  actualContacts: string[]
): SupportPolygonResult => {
  mannequin.updateMatrixWorld(true);
  const boneMap = collectBoneMap(mannequin);
  const usedBones = expectedContacts.filter((c) => actualContacts.includes(c));

  const points: Array<{ x: number; z: number }> = [];
  for (const key of usedBones) {
    points.push(...contactPointsXZ(boneMap, key));
  }

  return {
    polygon: convexHull2D(points),
    usedBones,
    expectedBones: expectedContacts,
  };
};

/** 点から線分への最短距離（2D、クランプ付き） */
const pointToSegmentDistance2D = (
  p: { x: number; z: number },
  a: { x: number; z: number },
  b: { x: number; z: number }
): number => {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lenSq = abx * abx + abz * abz;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.z - a.z);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / lenSq));
  return Math.hypot(p.x - (a.x + t * abx), p.z - (a.z + t * abz));
};

/**
 * 縮退した支持（点 or 線分、頂点 1〜2 個）に対する、点への最短距離。
 * 凸包が面積を持たないため「内側」は原理的に存在せず、常に非負（≥0）の
 * 距離を返す（呼び出し側で符号を反転し、常に非正のマージンとして扱う）。
 */
const distanceToDegenerateSupport = (
  p: { x: number; z: number },
  pts: Array<{ x: number; z: number }>
): number => {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.z - pts[0].z);
  let min = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    min = Math.min(min, pointToSegmentDistance2D(p, pts[i], pts[i + 1]));
  }
  return min;
};

/**
 * 点から凸多角形境界までの符号付き距離（内側正・外側負、#117 座標系規約）。
 * polygon は convexHull2D の出力（時計回り）で 3 点以上を前提とする。
 *
 * 内側の場合は各辺の間にいるため、各辺の直線までの符号付き距離の min が
 * そのまま境界距離として正しい。外側の場合は「各辺を無限延長した直線までの
 * 距離」では頂点の外側で実際の最近傍点からずれる（codex レビュー指摘 P2 —
 * 例: 単位正方形に対し点 (2,2) は頂点 (1,1) までの √2 が正しいが、辺の延長
 * 直線までの距離は 1 を返してしまう）。したがって外側は各辺（線分）までの
 * 最短距離（pointToSegmentDistance2D）の全辺 min を取る。
 */
export const signedDistanceToPolygon = (
  point: { x: number; z: number },
  polygon: Array<{ x: number; z: number }>
): number => {
  let inside = true;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const edgeX = b.x - a.x;
    const edgeZ = b.z - a.z;
    const edgeLen = Math.hypot(edgeX, edgeZ);
    if (edgeLen < 1e-9) continue;
    // 時計回り多角形の内側は各辺の右側 = cross <= 0
    const cross = edgeX * (point.z - a.z) - edgeZ * (point.x - a.x);
    if (cross > 0) {
      inside = false;
      break;
    }
  }

  if (inside) {
    let minAbsDist = Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const edgeX = b.x - a.x;
      const edgeZ = b.z - a.z;
      const edgeLen = Math.hypot(edgeX, edgeZ);
      if (edgeLen < 1e-9) continue;
      const cross = edgeX * (point.z - a.z) - edgeZ * (point.x - a.x);
      minAbsDist = Math.min(minAbsDist, Math.abs(cross / edgeLen));
    }
    return Number.isFinite(minAbsDist) ? minAbsDist : 0;
  }

  let minDist = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    minDist = Math.min(minDist, pointToSegmentDistance2D(point, a, b));
  }
  return Number.isFinite(minDist) ? -minDist : 0;
};

export type StabilityResult = {
  pass: boolean;
  /** COM の水平投影（XZ） */
  comXZ: { x: number; z: number };
  supportPolygon: Array<{ x: number; z: number }>;
  /** 実際に支持として採用された接地キー */
  supportBones: string[];
  /** 支持多角形境界からの符号付き距離（内側正・外側負・境界=0、m） */
  distanceToBoundaryM: number;
  /** 判定に使った閾値（STABILITY.marginM） */
  marginM: number;
};

/**
 * 重力安定性の準静的判定（#117）。COM の水平投影と支持多角形境界との
 * 符号付き距離が STABILITY.marginM を超えれば安定（pass）と判定する
 * （marginM が負値の場合は「境界の少し外側までは許容する」ことになる。
 * #118 校正、STABILITY のコメント参照）。
 *
 * 実接地は既存 computeContactClearances（#90）を expectedContacts に対して
 * 呼び出し、実際に接地している（grounded）ものだけを支持点候補にする
 * （期待していたが浮いている接地部位は除外され、Decision Log #1 の
 * 「expected ∩ actual」invariant と整合する）。
 *
 * 支持多角形が縮退（頂点 1〜2 個、点 or 線分）の場合は常に fail とし、
 * distanceToBoundaryM は「最も近い支持点までの距離」の符号反転（常に ≤0）
 * を返す。
 */
export const checkStability = (
  mannequin: THREE.Object3D,
  expectedContacts: string[],
  floorY: number = 0
): StabilityResult => {
  mannequin.updateMatrixWorld(true);
  const clearances = computeContactClearances(mannequin, expectedContacts, floorY);
  const actualContacts = clearances.filter((c) => c.grounded).map((c) => c.part);

  const { polygon, usedBones } = computeSupportPolygon(
    mannequin,
    expectedContacts,
    actualContacts
  );
  const com = computeCOM(mannequin);

  const isDegenerate = polygon.length < 3;
  const distanceToBoundaryM = isDegenerate
    ? -distanceToDegenerateSupport(com.xz, polygon)
    : signedDistanceToPolygon(com.xz, polygon);

  // 支持多角形が縮退（頂点1〜2個）していれば marginM の値に関わらず常に fail
  // とする（#118 codex レビュー指摘 P2 — 負の marginM だと縮退時も COM が支持点
  // の近くにあれば誤って pass してしまう回帰があった。#117 の invariant「縮退は
  // 常に fail」を維持しつつ、診断用に distanceToBoundaryM 自体は返す）。
  const pass = !isDegenerate && distanceToBoundaryM > STABILITY.marginM;

  return {
    pass,
    comXZ: com.xz,
    supportPolygon: polygon,
    supportBones: usedBones,
    distanceToBoundaryM,
    marginM: STABILITY.marginM,
  };
};

/**
 * 手のひらの向きゲート（#90）。palm normal の world 方向が「床向き（-Y）」か
 * どうかを判定する。palm normal のボーン local 表現は bind ポーズで実測導出
 * する（リグ軸規約に非依存。四肢ツイスト #82 と同じ手法）。
 *
 * bind ポーズ（A ポーズ想定）で手のひらは概ね内側〜後方を向く。ここでは
 * 「Hand ボーンから見た palm 法線 = ForeArm→Hand 方向（手の伸び）と
 * 直交し、かつ world 下方向成分を持つ local 軸」を、bind 時の Hand local
 * 3 軸のうち最も鉛直に寝ている軸として選ぶ。左右で符号が反転する。
 */
export const PALM = {
  /** 手が水平（手のひら/甲が床と平行）とみなす、法線と鉛直軸の許容角（度） */
  maxTiltDeg: 35,
} as const;

/** 対称 3x3 行列の最小固有値に対応する固有ベクトル（Jacobi 回転）。
 * 平面フィットの法線（点群が最も薄い方向）を取るのに使う。決定的。 */
const smallestEigenvector = (m: number[][]): THREE.Vector3 => {
  const a = m.map((row) => row.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iter = 0; iter < 50; iter++) {
    // 最大の非対角要素を探す
    let p = 0;
    let q = 1;
    let max = Math.abs(a[0][1]);
    const pairs: [number, number][] = [
      [0, 1],
      [0, 2],
      [1, 2],
    ];
    for (const [i, j] of pairs) {
      if (Math.abs(a[i][j]) >= max) {
        max = Math.abs(a[i][j]);
        p = i;
        q = j;
      }
    }
    if (max < 1e-12) break;
    const app = a[p][p];
    const aqq = a[q][q];
    const apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k < 3; k++) {
      const akp = a[k][p];
      const akq = a[k][q];
      a[k][p] = c * akp - s * akq;
      a[k][q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p][k];
      const aqk = a[q][k];
      a[p][k] = c * apk - s * aqk;
      a[q][k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  const eig = [a[0][0], a[1][1], a[2][2]];
  let idx = 0;
  if (eig[1] < eig[idx]) idx = 1;
  if (eig[2] < eig[idx]) idx = 2;
  return new THREE.Vector3(v[0][idx], v[1][idx], v[2][idx]).normalize();
};

/** 指定 Hand ボーンが支配する頂点群（スキニング適用後 world 座標）を集める */
const collectHandVertices = (
  root: THREE.Object3D,
  side: "left" | "right"
): THREE.Vector3[] => {
  const suffix = side === "left" ? "LeftHand" : "RightHand";
  const alias = side === "left" ? "hand_l" : "hand_r";
  const pts: THREE.Vector3[] = [];
  const v = new THREE.Vector3();
  root.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh) || !child.skeleton) return;
    const geom = child.geometry;
    const skinIndex = geom.getAttribute("skinIndex");
    const skinWeight = geom.getAttribute("skinWeight");
    if (
      !skinIndex ||
      !skinWeight ||
      !geom.hasAttribute("position") ||
      !geom.hasAttribute("skinWeight")
    )
      return;
    const bones = child.skeleton.bones;
    const count = geom.getAttribute("position").count;
    for (let i = 0; i < count; i++) {
      let maxW = 0;
      let dom = 0;
      for (let k = 0; k < 4; k++) {
        const w = skinWeight.getComponent(i, k);
        if (w > maxW) {
          maxW = w;
          dom = skinIndex.getComponent(i, k);
        }
      }
      const name = bones[dom]?.name ?? "";
      if (!(name.endsWith(suffix) || name === alias)) continue;
      child.getVertexPosition(i, v);
      v.applyMatrix4(child.matrixWorld);
      pts.push(v.clone());
    }
  });
  return pts;
};

/**
 * 手の平面フィット法線（world）を頂点群から求める（#90）。手メッシュは
 * palm 法線方向に薄いため、点群の最小分散軸 = palm 法線。符号は曖昧なので
 * 「鉛直との傾き」判定にのみ使う（palm up/down は区別しない v1）。
 * 頂点が取れない（テストのモックリグ等）場合は null。
 */
export const computeHandSlabNormal = (
  root: THREE.Object3D,
  side: "left" | "right"
): THREE.Vector3 | null => {
  const pts = collectHandVertices(root, side);
  if (pts.length < 12) return null;
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / pts.length);
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d = p.clone().sub(c);
    const e = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += e[i] * e[j];
  }
  return smallestEigenvector(cov);
};

export type PalmCheck = {
  side: "left" | "right";
  /** palm 法線と鉛直軸の鋭角（度）。手が水平なら小さい */
  tiltDeg: number;
  flat: boolean;
};

/**
 * palmsDown で指定した手が「水平（手のひら/甲が床と平行）」かを判定する（#90）。
 * 指先立ちだと手スラブが立って法線が水平寄りになり tilt が大きくなる。
 * 法線が取れない手はスキップ。
 */
export const checkPalmsFlat = (
  root: THREE.Object3D,
  sides: ("left" | "right")[]
): PalmCheck[] => {
  const out: PalmCheck[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const side of sides) {
    const n = computeHandSlabNormal(root, side);
    if (!n) continue;
    const raw = THREE.MathUtils.radToDeg(n.angleTo(up));
    const tiltDeg = Math.min(raw, 180 - raw);
    out.push({ side, tiltDeg, flat: tiltDeg <= PALM.maxTiltDeg });
  }
  return out;
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
  /** a 側（例: レンダー推定）のセグメント方向（three 空間・正規化済み） */
  dirA: [number, number, number];
  /** b 側（例: 実写真推定）のヨー整合後方向。修正の向きの手掛かりに使う */
  dirB: [number, number, number];
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

const compareWithYaw = (
  a: RawLandmark[],
  b: RawLandmark[],
  yawDelta: number
): LandmarkMatchResult => {
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
      dirA: [da.x, da.y, da.z],
      dirB: [dbAligned.x, dbAligned.y, dbAligned.z],
    });
  }
  const meanDeg =
    segments.length > 0
      ? segments.reduce((s, m) => s + m.angleDeg, 0) / segments.length
      : null;
  return { segments, meanDeg, skipped };
};

/**
 * 2 つの landmark 配列（例: ゴールデンレンダーの推定結果 vs 実写真の推定結果）
 * のセグメント方向を比較する（指標A）。b 側を hip line のヨー差で a に揃えて
 * から 3D 角度差を取る。visibility が低いセグメントは除外して skipped に載せる。
 *
 * hip line は後ろ向き・強遮蔽の写真で向きを 180° 取り違えることがある
 * （左右腰の混同）。ヨー整合を ψ と ψ+180° の両方で試し、平均角度差が
 * 小さい方を採用して 2 値曖昧性を解消する（#88）。
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
  const r1 = compareWithYaw(a, b, yawDelta);
  const r2 = compareWithYaw(a, b, yawDelta + Math.PI);
  if (r1.meanDeg === null) return r2;
  if (r2.meanDeg === null) return r1;
  return r2.meanDeg < r1.meanDeg ? r2 : r1;
};
