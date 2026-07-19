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
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

export type RawLandmark = { x: number; y: number; z: number; visibility?: number };

/**
 * landmark visibility ゲーティングのしきい値（#53）。
 *
 * MediaPipe はオクルージョンされた関節にも座標を返すが、visibility が低い点の
 * world 座標はほぼハルシネーションで、全信頼で使うとリターゲット・接地 IK が
 * 破綻する（実測: 後ろ向き膝立ち画像で脚の visibility 0.06〜0.4）。
 *
 * - minDrive: ボーン駆動に使う下限。未満はバインドポーズ維持
 * - minDriveFused: 2D/world 融合（#61）が成立した場合のボーン駆動下限。
 *   fused の x,y は global similarity fit + 2D 検出由来でオクルージョンに頑健
 *   なため、ゲートを外して低 visibility の四肢も駆動する（0 = landmark が
 *   存在すれば駆動）。深度ノイズによる解剖学的破綻はヒンジ関節リミット（#62）
 *   が受ける
 * - minContact: 接地 IK の接地候補に使う下限。IK は全身を動かすため高いバー
 * - minDraw: 2D 棒人間描画の下限。未満の点・結線は描かない
 */
export const VISIBILITY_GATE = {
  minDrive: 0.3,
  minDriveFused: 0,
  minContact: 0.5,
  minDraw: 0.3,
} as const;

/**
 * landmark が visibility しきい値を満たすか。visibility が無い入力
 * （テストフィクスチャ・旧データ）は「情報なし」として可視扱いにする。
 */
export const isVisible = (lm: RawLandmark | undefined, min: number): boolean =>
  lm !== undefined && (lm.visibility === undefined || lm.visibility >= min);

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

/** MediaPipe生座標系(x,z)の中点。y反転しない生の水平位置を扱う用途向け */
const rawMidpointXZ = (
  a: RawLandmark | undefined,
  b: RawLandmark | undefined
): { x: number; z: number } | null => {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
};

/**
 * 支持脚判定・抗重力の重み付け係数（マジックナンバーをここに集約）。
 *
 * 荷重度(0..1)は「足首の接地からの持ち上げ量」と「腰中心からの水平距離」の
 * 積で決まる: どちらかが大きい（浮いている/腰の真下から離れている）と荷重0に近づく。
 *
 * quadriceps/calf は `xxxSwingGain`(遊脚でも屈曲があれば得る係数) と
 * `xxxSupportGain`(荷重に応じて追加される係数) の和が荷重1のとき従来の係数と
 * 一致するよう設計している（荷重情報が無かった旧実装との後方互換）。
 * `xxxAntiGravityGain` は屈曲角に関係なく、荷重そのもの（支持脚として重力に
 * 抗して姿勢を支える等尺性収縮）から加算される分。
 */
export const LOAD_WEIGHT = {
  /** この高さ(m)以上足首が浮いていれば荷重0とみなす */
  liftNormalizationM: 0.4,
  /** 腰中心からこの水平距離(m)以上離れていれば荷重0とみなす */
  stanceNormalizationM: 0.35,
  quadSwingGain: 0.5,
  quadSupportGain: 0.5,
  quadAntiGravityGain: 0.15,
  calfSwingGain: 0.5,
  calfSupportGain: 0.4,
  calfAntiGravityGain: 0.12,
  /** 支持脚側の股関節安定化（中殿筋等）による glutes 加算 */
  glutesAntiGravityGain: 0.3,
  /** 片脚立ちなど左右の荷重差が大きいほど体幹傾斜の影響を増幅する係数 */
  coreImbalanceGain: 0.5,
} as const;

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

/**
 * 支持脚判定: 両足首の高さ（world y, 下向き正）と腰中心からの水平距離から、
 * 各脚がどれだけ荷重を受けているか（0=完全に遊脚, 1=完全に荷重）を推定する。
 * 片脚立ちだけでなく両脚立ち（両方高い荷重度）も表現できる。
 */
export const detectSupportLegs = (landmarks: RawLandmark[]): { L: number; R: number } => {
  const g = (i: number): RawLandmark | undefined => landmarks[i];
  const ankleL = g(LM.LEFT_ANKLE);
  const ankleR = g(LM.RIGHT_ANKLE);
  const hipCenter = rawMidpointXZ(g(LM.LEFT_HIP), g(LM.RIGHT_HIP));
  if (!ankleL || !ankleR || !hipCenter) return { L: 0, R: 0 };

  // y は下向き正: 値が大きいほど接地に近い。より接地している方を地面基準にする。
  const groundY = Math.max(ankleL.y, ankleR.y);
  const heightScore = (ankle: RawLandmark): number =>
    clamp01(1 - (groundY - ankle.y) / LOAD_WEIGHT.liftNormalizationM);
  const stanceScore = (ankle: RawLandmark): number => {
    const dx = ankle.x - hipCenter.x;
    const dz = ankle.z - hipCenter.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    return clamp01(1 - dist / LOAD_WEIGHT.stanceNormalizationM);
  };

  return {
    L: heightScore(ankleL) * stanceScore(ankleL),
    R: heightScore(ankleR) * stanceScore(ankleR),
  };
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
  const support = detectSupportLegs(landmarks);

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
    const loadWeight = support[side];

    // 抗重力: 荷重が乗っているほど膝屈曲の quadriceps 寄与を強め、
    // 荷重そのもの（等尺性の支持）も加算する。遊脚（荷重0）でも屈曲があれば
    // 最低限の寄与(quadSwingGain)は残す。
    const quadFlexGain =
      LOAD_WEIGHT.quadSwingGain + loadWeight * LOAD_WEIGHT.quadSupportGain;
    out[key("quadriceps", side)] = clamp01(
      0.05 + kneeFlex * quadFlexGain + loadWeight * LOAD_WEIGHT.quadAntiGravityGain
    );

    out[key("hamstrings", side)] = clamp01(0.05 + (kneeFlex + hipFlex) * 0.5);
    // 支持脚側は股関節安定化（中殿筋等）が働くため荷重度で加算する
    out[key("glutes", side)] = clamp01(
      0.05 + hipFlex + loadWeight * LOAD_WEIGHT.glutesAntiGravityGain
    );

    // ふくらはぎ: 足趾があれば足関節角、無ければ膝屈曲で近似
    const ankleFlex = landmarks[foot]
      ? flexion(angleAt(g(knee), g(ankle), g(foot)))
      : kneeFlex * 0.5;
    const calfFlexGain =
      LOAD_WEIGHT.calfSwingGain + loadWeight * LOAD_WEIGHT.calfSupportGain;
    out[key("calf", side)] = clamp01(
      0.05 + ankleFlex * calfFlexGain + loadWeight * LOAD_WEIGHT.calfAntiGravityGain
    );
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
    // 片脚立ちなど左右の荷重差が大きいほどバランス保持に体幹が使われるため増幅する
    const loadImbalance = Math.abs(support.L - support.R);
    const coreGain = 1 + loadImbalance * LOAD_WEIGHT.coreImbalanceGain;
    out[key("core")] = clamp01(0.08 + lean * 0.9 * coreGain);
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
