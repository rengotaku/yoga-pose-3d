import * as THREE from "three";

/**
 * 筋肉アクティベーション推定モジュール（ヒューリスティック）。
 *
 * 注意: これは EMG の実測ではなく、MediaPipe の 33 landmark（worldLandmarks）から
 * 関節角度・分節ベクトルを使って「その筋群がどの程度使われていそうか」を
 * 幾何学的に推定した近似値である。あくまで目安として色分けに使う。
 */

// MediaPipe Pose landmark インデックス
export const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export type RawLandmark = { x: number; y: number; z: number };

/** MediaPipe 座標 → Three.js 座標（X そのまま, Y 反転, Z 反転） */
export const toVec = (l: RawLandmark): THREE.Vector3 =>
  new THREE.Vector3(l.x, -l.y, -l.z);

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** b を頂点として a-b-c がなす角（ラジアン, 0..PI）。欠損時は PI（=直線扱い） */
export const angleAt = (
  a: RawLandmark | undefined,
  b: RawLandmark | undefined,
  c: RawLandmark | undefined
): number => {
  if (!a || !b || !c) return Math.PI;
  const bv = toVec(b);
  const ba = toVec(a).sub(bv);
  const bc = toVec(c).sub(bv);
  if (ba.lengthSq() === 0 || bc.lengthSq() === 0) return Math.PI;
  return ba.angleTo(bc);
};

/** 屈曲度: 直線(180°)=0, 直角=0.5, 全屈曲(0°)=1 */
export const flexion = (angleRad: number): number =>
  clamp01((Math.PI - angleRad) / Math.PI);

const midpoint = (
  a: RawLandmark | undefined,
  b: RawLandmark | undefined
): THREE.Vector3 | null => {
  if (!a || !b) return null;
  return toVec(a).add(toVec(b)).multiplyScalar(0.5);
};

/** 上腕の外転度: 腕が体幹の下方向からどれだけ開いているか（0..1） */
const abduction = (
  shoulder: RawLandmark | undefined,
  elbow: RawLandmark | undefined,
  hipMid: THREE.Vector3 | null,
  shoulderMid: THREE.Vector3 | null
): number => {
  if (!shoulder || !elbow || !hipMid || !shoulderMid) return 0;
  const torsoDown = hipMid.clone().sub(shoulderMid); // 肩→腰（体幹の下方向）
  const upperArm = toVec(elbow).sub(toVec(shoulder)); // 肩→肘
  if (torsoDown.lengthSq() === 0 || upperArm.lengthSq() === 0) return 0;
  // 腕が下に垂れている(=torsoDown と同方向)とき角度~0 → 外転0
  return clamp01(upperArm.angleTo(torsoDown) / Math.PI);
};

export type MuscleId =
  | "biceps"
  | "forearm"
  | "deltoid"
  | "core"
  | "glutes"
  | "quadriceps"
  | "hamstrings"
  | "calf";

export type Side = "L" | "R";

/** 筋群の表示定義（凡例用ラベル） */
export const MUSCLE_LABELS: Record<MuscleId, string> = {
  biceps: "上腕（二頭/三頭筋）",
  forearm: "前腕",
  deltoid: "三角筋",
  core: "体幹・腹筋",
  glutes: "大臀筋・股関節",
  quadriceps: "大腿四頭筋",
  hamstrings: "ハムストリングス",
  calf: "下腿三頭筋（ふくらはぎ）",
};

/** 表示順（凡例の並び） */
export const MUSCLE_ORDER: MuscleId[] = [
  "deltoid",
  "biceps",
  "forearm",
  "core",
  "glutes",
  "quadriceps",
  "hamstrings",
  "calf",
];

/** 左右別のアクティベーション（0..1） */
export type ActivationMap = Record<string, number>; // key: `${MuscleId}:${Side}` or `${MuscleId}` for中央部位

const key = (id: MuscleId, side?: Side): string => (side ? `${id}:${side}` : id);

/**
 * worldLandmarks から各筋群のアクティベーションを推定する。
 * 返り値は key -> 0..1。左右あるものは `id:L` / `id:R`、体幹は `core` のみ。
 */
export const computeActivations = (landmarks: RawLandmark[]): ActivationMap => {
  const g = (i: number): RawLandmark | undefined => landmarks[i];
  const shoulderMid = midpoint(g(LM.LEFT_SHOULDER), g(LM.RIGHT_SHOULDER));
  const hipMid = midpoint(g(LM.LEFT_HIP), g(LM.RIGHT_HIP));

  const out: ActivationMap = {};

  // --- 上肢（左右） ---
  const arm = (side: Side, sh: number, el: number, wr: number): void => {
    const elbowFlex = flexion(angleAt(g(sh), g(el), g(wr)));
    out[key("biceps", side)] = clamp01(0.05 + elbowFlex);
    out[key("forearm", side)] = clamp01(0.05 + elbowFlex * 0.7);
    out[key("deltoid", side)] = clamp01(
      0.05 + abduction(g(sh), g(el), hipMid, shoulderMid) * 1.1
    );
  };
  arm("L", LM.LEFT_SHOULDER, LM.LEFT_ELBOW, LM.LEFT_WRIST);
  arm("R", LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW, LM.RIGHT_WRIST);

  // --- 下肢（左右） ---
  const leg = (
    side: Side,
    sh: number,
    hip: number,
    knee: number,
    ankle: number,
    foot: number
  ): void => {
    const kneeFlex = flexion(angleAt(g(hip), g(knee), g(ankle)));
    const hipFlex = flexion(angleAt(g(sh), g(hip), g(knee)));
    out[key("quadriceps", side)] = clamp01(0.05 + kneeFlex);
    out[key("hamstrings", side)] = clamp01(0.05 + (kneeFlex + hipFlex) * 0.5);
    out[key("glutes", side)] = clamp01(0.05 + hipFlex);
    // ふくらはぎ: 足趾があれば足関節角、無ければ膝屈曲で近似
    const ankleFlex = landmarks[foot]
      ? flexion(angleAt(g(knee), g(ankle), g(foot)))
      : kneeFlex * 0.5;
    out[key("calf", side)] = clamp01(0.05 + ankleFlex * 0.9);
  };
  leg(
    "L",
    LM.LEFT_SHOULDER,
    LM.LEFT_HIP,
    LM.LEFT_KNEE,
    LM.LEFT_ANKLE,
    LM.LEFT_FOOT_INDEX
  );
  leg(
    "R",
    LM.RIGHT_SHOULDER,
    LM.RIGHT_HIP,
    LM.RIGHT_KNEE,
    LM.RIGHT_ANKLE,
    LM.RIGHT_FOOT_INDEX
  );

  // --- 体幹（中央） ---
  // 脊柱ベクトル（肩中央→腰中央）が重力鉛直からどれだけ傾いているか
  if (shoulderMid && hipMid) {
    const spine = shoulderMid.clone().sub(hipMid); // 腰→肩（上向き）
    const vertical = new THREE.Vector3(0, 1, 0);
    const lean = spine.lengthSq() === 0 ? 0 : spine.angleTo(vertical) / (Math.PI / 2);
    out[key("core")] = clamp01(0.08 + lean * 0.9);
  } else {
    out[key("core")] = 0;
  }

  return out;
};

/** 凡例向けに左右を統合した筋群アクティベーション（max を採用） */
export const aggregateByMuscle = (
  act: ActivationMap
): { id: MuscleId; label: string; value: number }[] =>
  MUSCLE_ORDER.map((id) => {
    const l = act[key(id, "L")];
    const r = act[key(id, "R")];
    const c = act[id];
    const value = Math.max(l ?? 0, r ?? 0, c ?? 0);
    return { id, label: MUSCLE_LABELS[id], value };
  });

/**
 * アクティベーション(0..1)をヒートマップ色に変換する。
 * 低: 筋肉ベージュ → 中: オレンジ → 高: 赤。emissiveIntensity で発光量を返す。
 */
export const heatColor = (
  activation: number
): { color: THREE.Color; emissiveIntensity: number } => {
  const a = clamp01(activation);
  const base = new THREE.Color(0xb98a7a); // 筋肉ベージュ（不活性）
  const mid = new THREE.Color(0xf59e0b); // オレンジ
  const hot = new THREE.Color(0xdc2626); // 赤（強い使用）
  const color = new THREE.Color();
  if (a < 0.5) {
    color.copy(base).lerp(mid, a / 0.5);
  } else {
    color.copy(mid).lerp(hot, (a - 0.5) / 0.5);
  }
  return { color, emissiveIntensity: a * 0.6 };
};
