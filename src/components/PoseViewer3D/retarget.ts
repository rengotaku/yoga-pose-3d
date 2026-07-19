import * as THREE from "three";
import { LM, type RawLandmark, toVec } from "./muscles";

export const BONE_ALIASES: Record<string, string[]> = {
  Hips: ["pelvis"],
  Spine: ["spine_01"],
  Spine1: ["spine_02"],
  Spine2: ["spine_03"],
  Neck: ["neck_01"],
  Head: ["head"],
  LeftShoulder: ["clavicle_l"],
  RightShoulder: ["clavicle_r"],
  LeftArm: ["upperarm_l"],
  LeftForeArm: ["lowerarm_l"],
  LeftHand: ["hand_l"],
  RightArm: ["upperarm_r"],
  RightForeArm: ["lowerarm_r"],
  RightHand: ["hand_r"],
  LeftUpLeg: ["thigh_l"],
  LeftLeg: ["calf_l"],
  LeftFoot: ["foot_l"],
  LeftToeBase: ["ball_l"],
  RightUpLeg: ["thigh_r"],
  RightLeg: ["calf_r"],
  RightFoot: ["foot_r"],
  RightToeBase: ["ball_r"],
};

/**
 * 実際のボーン名リストから、mixamorig標準名に対応する名前をサフィックス一致で探す。
 * GLTFLoader がコロンを除去・置換した（例: "mixamorigHips"）ケースに対応する。
 * 見つからない場合は別名リスト(BONE_ALIASES)との完全一致で探す。
 * @param mixamoName 探したい標準ボーン名（例: "mixamorig:LeftUpLeg"）
 * @param actualBoneNames ロードされたメッシュが持つ実際のボーン名配列
 */
export const resolveBoneName = (
  mixamoName: string,
  actualBoneNames: string[]
): string | undefined => {
  const parts = mixamoName.split(":");
  const suffix = parts[parts.length - 1];
  if (!suffix) return undefined;

  let found = actualBoneNames.find((name) => name.endsWith(suffix));
  if (found) return found;

  const aliases = BONE_ALIASES[suffix];
  if (aliases) {
    found = actualBoneNames.find((name) => aliases.includes(name));
    if (found) return found;
  }

  return undefined;
};

/**
 * 初期方向ベクトル(initialDir)から目標方向ベクトル(targetDir)への
 * 最短回転（Quaternion）を計算する。
 */
export const computeRotation = (
  initialDir: THREE.Vector3,
  targetDir: THREE.Vector3
): THREE.Quaternion => {
  const q = new THREE.Quaternion();
  const v1 = initialDir.clone().normalize();
  const v2 = targetDir.clone().normalize();
  if (v1.lengthSq() > 0 && v2.lengthSq() > 0) {
    q.setFromUnitVectors(v1, v2);
  }
  return q;
};

/**
 * ランドマーク点p1からp2への方向ベクトルを算出する。
 */
export const computeDirection = (
  p1?: RawLandmark,
  p2?: RawLandmark
): THREE.Vector3 | null => {
  if (!p1 || !p2) return null;
  const dir = toVec(p2).sub(toVec(p1));
  if (dir.lengthSq() === 0) return null;
  return dir.normalize();
};

/**
 * 2つのランドマークの中点（THREE.Vector3）を計算する。
 */
export const computeMidpoint = (
  p1?: RawLandmark,
  p2?: RawLandmark
): THREE.Vector3 | null => {
  if (!p1 || !p2) return null;
  return toVec(p1).add(toVec(p2)).multiplyScalar(0.5);
};

export type JointMapping = {
  parentLm: number;
  childLm: number;
};

/**
 * 四肢のボーンとMediaPipeランドマークインデックス（親→子）の対応表。
 */
export const LIMB_BONE_MAPPINGS: Record<string, JointMapping> = {
  "mixamorig:LeftUpLeg": { parentLm: LM.LEFT_HIP, childLm: LM.LEFT_KNEE },
  "mixamorig:LeftLeg": { parentLm: LM.LEFT_KNEE, childLm: LM.LEFT_ANKLE },
  "mixamorig:LeftFoot": { parentLm: LM.LEFT_ANKLE, childLm: LM.LEFT_FOOT_INDEX },
  "mixamorig:RightUpLeg": { parentLm: LM.RIGHT_HIP, childLm: LM.RIGHT_KNEE },
  "mixamorig:RightLeg": { parentLm: LM.RIGHT_KNEE, childLm: LM.RIGHT_ANKLE },
  "mixamorig:RightFoot": { parentLm: LM.RIGHT_ANKLE, childLm: LM.RIGHT_FOOT_INDEX },
  "mixamorig:LeftArm": { parentLm: LM.LEFT_SHOULDER, childLm: LM.LEFT_ELBOW },
  "mixamorig:LeftForeArm": { parentLm: LM.LEFT_ELBOW, childLm: LM.LEFT_WRIST },
  "mixamorig:RightArm": { parentLm: LM.RIGHT_SHOULDER, childLm: LM.RIGHT_ELBOW },
  "mixamorig:RightForeArm": { parentLm: LM.RIGHT_ELBOW, childLm: LM.RIGHT_WRIST },
};

/**
 * 四肢ツイスト制御のパラメータ（#82）。
 *
 * minBendRad: チェーン（親→関節→子）の屈曲がこれ未満（ほぼ直線）のときは
 * ヒンジ軸 u×w がノイズ支配になるためツイスト補正をスキップする。直線に近い
 * 四肢のツイストは chain 幾何からは原理的に決められない（手 landmark 由来の
 * 前腕ロール等は別欠陥のスコープ）。
 *
 * minCorrectionRad: 補正量がこれ未満なら適用しない。landmark ノイズによる
 * ヒンジ軸の誤差は実測でおよそ 10〜25° あり、小さな補正は信号よりノイズが
 * 支配的になる（tabletop で正しかったツイストを 8→25° に悪化させた実測から
 * 導入）。大きくズレたツイスト（cross-seat の 60〜110°）だけを直す。
 *
 * minAimRad: ボーンの目標方向がバインドポーズ方向からこれ未満しか離れて
 * いないときは補正しない。swing-only 駆動のデフォルトツイストはバインド由来
 * なので、バインド近傍では正しいことが多く（tabletop の鉛直大腿: 誤差 8°）、
 * 大きく回った四肢でだけ崩壊する（cross-seat の水平大腿: 誤差 74〜108°）。
 * ノイズ入りのヒンジ軸で「元々正しいツイスト」を上書きしないためのゲート。
 */
export const LIMB_TWIST = {
  minBendRad: (25 * Math.PI) / 180,
  minCorrectionRad: (25 * Math.PI) / 180,
  minAimRad: (45 * Math.PI) / 180,
} as const;

/**
 * 曲がった 2 ボーンチェーンの実測ヒンジ軸を返す（#82）。
 * u（親→関節）から w（関節→子）への回転軸 normalize(u × w)。曲げ角が
 * LIMB_TWIST.minBendRad 未満（|u × w| = sin(曲げ角) が小さい）は null。
 */
export const computeChainHingeAxis = (
  a?: RawLandmark,
  b?: RawLandmark,
  c?: RawLandmark
): THREE.Vector3 | null => {
  const u = computeDirection(a, b);
  const w = computeDirection(b, c);
  if (!u || !w) return null;
  const axis = new THREE.Vector3().crossVectors(u, w);
  if (axis.length() < Math.sin(LIMB_TWIST.minBendRad)) return null;
  return axis.normalize();
};

/**
 * ボーン軸 axis まわりで current を target へ揃える符号付きツイスト角（#82）。
 * 双方を axis 直交平面へ射影して角度を測る。射影退化、または補正量が
 * LIMB_TWIST.minCorrectionRad 未満（ノイズフロア以下）は null。
 */
export const computeTwistCorrection = (
  axis: THREE.Vector3,
  current: THREE.Vector3,
  target: THREE.Vector3
): number | null => {
  const axisN = axis.clone().normalize();
  const pc = current.clone().projectOnPlane(axisN);
  const pt = target.clone().projectOnPlane(axisN);
  if (pc.lengthSq() < 1e-8 || pt.lengthSq() < 1e-8) return null;
  pc.normalize();
  pt.normalize();
  const angle = pc.angleTo(pt);
  if (angle < LIMB_TWIST.minCorrectionRad) return null;
  const sign = new THREE.Vector3().crossVectors(pc, pt).dot(axisN) >= 0 ? 1 : -1;
  return angle * sign;
};

/**
 * 体幹（Spine）の方向ベクトルを計算する。
 * 腰の中点から肩の中点へのベクトル。
 */
export const computeSpineDirection = (landmarks: RawLandmark[]): THREE.Vector3 | null => {
  const hipMid = computeMidpoint(landmarks[LM.LEFT_HIP], landmarks[LM.RIGHT_HIP]);
  const shMid = computeMidpoint(
    landmarks[LM.LEFT_SHOULDER],
    landmarks[LM.RIGHT_SHOULDER]
  );
  if (!hipMid || !shMid) return null;
  const dir = shMid.clone().sub(hipMid);
  if (dir.lengthSq() === 0) return null;
  return dir.normalize();
};

/**
 * 首・頭（Neck/Head）の方向ベクトルを計算する。
 * 肩の中点から鼻へのベクトル。
 */
export const computeNeckDirection = (landmarks: RawLandmark[]): THREE.Vector3 | null => {
  const shMid = computeMidpoint(
    landmarks[LM.LEFT_SHOULDER],
    landmarks[LM.RIGHT_SHOULDER]
  );
  const nose = landmarks[LM.NOSE] ? toVec(landmarks[LM.NOSE]) : null;
  if (!shMid || !nose) return null;
  const dir = nose.clone().sub(shMid);
  if (dir.lengthSq() === 0) return null;
  return dir.normalize();
};

/**
 * 頭部の直交基底クォータニオン（world 目標回転）を計算する（#54）。
 *
 * 肩中点→鼻の弦（computeNeckDirection）は直立時も「上+前」を向き頭部ピッチに
 * ほぼ不感なため、頭部の向きは顔の幾何から取る:
 * - Z軸(顔前方): 耳中点 → 鼻（見上げれば上向き、後ろ向きなら -Z になる）
 * - X軸(頭部左): 右耳 → 左耳
 * - Y軸(頭頂): Z × X
 *
 * 顔 landmark の visibility は後頭部向きでも 1.0 になるため、ゲートではなく
 * 幾何の退化（ゼロ長・平行）のみで null を返す。
 */
export const computeHeadRotation = (
  landmarks: RawLandmark[]
): THREE.Quaternion | null => {
  const nose = landmarks[LM.NOSE];
  const earL = landmarks[LM.LEFT_EAR];
  const earR = landmarks[LM.RIGHT_EAR];
  if (!nose || !earL || !earR) return null;

  const earMid = computeMidpoint(earL, earR);
  const xDir = computeDirection(earR, earL);
  if (!earMid || !xDir) return null;

  const zAxis = toVec(nose).sub(earMid);
  if (zAxis.lengthSq() < 1e-10) return null;
  zAxis.normalize();

  const yAxis = new THREE.Vector3().crossVectors(zAxis, xDir);
  if (yAxis.lengthSq() < 1e-10) return null;
  yAxis.normalize();
  const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis).normalize();

  const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  return new THREE.Quaternion().setFromRotationMatrix(m);
};

/**
 * 手（wrist → INDEX/PINKY 中点）の方向ベクトルを計算する（#54）。
 * Hand ボーンの向きに使う。landmark 欠損・ゼロ長は null。
 */
export const computeHandDirection = (
  landmarks: RawLandmark[],
  side: "left" | "right"
): THREE.Vector3 | null => {
  const wrist = landmarks[side === "left" ? LM.LEFT_WRIST : LM.RIGHT_WRIST];
  const index = landmarks[side === "left" ? LM.LEFT_INDEX : LM.RIGHT_INDEX];
  const pinky = landmarks[side === "left" ? LM.LEFT_PINKY : LM.RIGHT_PINKY];
  if (!wrist || !index || !pinky) return null;
  const knuckleMid = computeMidpoint(index, pinky);
  if (!knuckleMid) return null;
  const dir = knuckleMid.sub(toVec(wrist));
  if (dir.lengthSq() < 1e-10) return null;
  return dir.normalize();
};

/**
 * 骨盤基底の退化判定パラメータ（#55）。
 *
 * MediaPipe world の左右股関節距離は、後ろ向き・オクルージョンの強い画像で
 * 実際（成人でおよそ 0.2m 以上）よりはるかに小さく推定されることがある
 * （実測: 後ろ向き膝立ち側屈画像で 0.09m、胴体長比 0.19）。距離が潰れると
 * hip line の向きはノイズ支配になり、骨盤基底が大きくロールして胴体全体が
 * 破綻する。胴体長（腰中点→肩中点）に対する比で信頼可否を判定する。
 */
export const HIPS_BASIS = {
  minHipTorsoRatio: 0.35,
} as const;

/**
 * 左右の腰のランドマークとSpineの方向から、Hipsの直交基底クォータニオンを計算する。
 * X軸(右): RIGHT_HIP -> LEFT_HIP
 * Y軸(上): SpineDirection
 * Z軸(前): X と Y の外積
 *
 * 股関節距離が胴体長比 minHipTorsoRatio 未満のときは hip line の向きを
 * 信頼せず、「spine に直交する水平ベクトル」（up × spine）を X 軸に使う
 * （骨盤ロールの暴走を抑制。#55）。hip line の水平投影ではなく up × spine を
 * 使うのは、spine chord 自体が水平に近いポーズでは直交化で X が再び鉛直へ
 * 引き戻されるため。左右の符号は hip line（弱ければ肩線）の水平成分に合わせる。
 * spine がほぼ鉛直で外積が退化する場合は生の hip line を使う。
 */
export const computeHipsRotation = (
  landmarks: RawLandmark[]
): THREE.Quaternion | null => {
  const hipL = landmarks[LM.LEFT_HIP];
  const hipR = landmarks[LM.RIGHT_HIP];
  const spineDir = computeSpineDirection(landmarks);

  if (!hipL || !hipR || !spineDir) return null;

  let xDir = computeDirection(hipR, hipL);
  if (!xDir) return null;

  const hipDist = toVec(hipL).distanceTo(toVec(hipR));
  const hipMid = computeMidpoint(hipL, hipR);
  const shMid = computeMidpoint(
    landmarks[LM.LEFT_SHOULDER],
    landmarks[LM.RIGHT_SHOULDER]
  );
  const torsoLen = hipMid && shMid ? hipMid.distanceTo(shMid) : 0;
  if (torsoLen > 1e-6 && hipDist / torsoLen < HIPS_BASIS.minHipTorsoRatio) {
    const horizontal = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), spineDir)
      .normalize();
    if (horizontal.lengthSq() > 1e-8) {
      const hipHoriz = new THREE.Vector3(xDir.x, 0, xDir.z);
      const shoulderDir = computeDirection(
        landmarks[LM.RIGHT_SHOULDER],
        landmarks[LM.LEFT_SHOULDER]
      );
      const shoulderHoriz = shoulderDir
        ? new THREE.Vector3(shoulderDir.x, 0, shoulderDir.z)
        : new THREE.Vector3();
      const signRef =
        Math.abs(horizontal.dot(hipHoriz)) >= Math.abs(horizontal.dot(shoulderHoriz))
          ? hipHoriz
          : shoulderHoriz;
      xDir = horizontal.dot(signRef) >= 0 ? horizontal : horizontal.multiplyScalar(-1);
    }
  }

  // 正確な直交基底を作る
  const zDir = new THREE.Vector3().crossVectors(xDir, spineDir).normalize();
  if (zDir.lengthSq() === 0) return null;

  const xAxis = new THREE.Vector3().crossVectors(spineDir, zDir).normalize();
  const m = new THREE.Matrix4().makeBasis(xAxis, spineDir, zDir);
  return new THREE.Quaternion().setFromRotationMatrix(m);
};

/**
 * 脊椎ツイストのパラメータ（#55）。ツイストは spine 3 ボーンへ分配するが、
 * ノイズで首・胸が過回転しないよう合計角に上限を設ける。
 */
export const SPINE_TWIST = {
  maxTwistRad: (60 * Math.PI) / 180,
} as const;

/**
 * 体幹の chord（腰中点→肩中点）アラインでは表現されない「肩線の捻れ・傾き」
 * を、spine 軸まわりのツイスト回転（world delta）として求める（#55）。
 *
 * 骨盤基底の X 軸と実測の肩線（右肩→左肩）をそれぞれ spine 軸に直交する
 * 平面へ射影し、その角度差を spine 軸まわりの回転にする。側屈・捻転で
 * 肩線が骨盤に対して傾く/回るポーズが胴体に反映される。
 * 射影が退化する（肩線や骨盤 X が spine とほぼ平行）場合は null。
 */
export const computeSpineTwistRotation = (
  landmarks: RawLandmark[]
): THREE.Quaternion | null => {
  const spineDir = computeSpineDirection(landmarks);
  const hipsQ = computeHipsRotation(landmarks);
  const shoulderDir = computeDirection(
    landmarks[LM.RIGHT_SHOULDER],
    landmarks[LM.LEFT_SHOULDER]
  );
  if (!spineDir || !hipsQ || !shoulderDir) return null;

  const pelvisX = new THREE.Vector3(1, 0, 0).applyQuaternion(hipsQ);
  const projP = pelvisX.clone().projectOnPlane(spineDir);
  const projS = shoulderDir.clone().projectOnPlane(spineDir);
  if (projP.lengthSq() < 1e-8 || projS.lengthSq() < 1e-8) return null;
  projP.normalize();
  projS.normalize();

  let angle = projP.angleTo(projS);
  const sign = new THREE.Vector3().crossVectors(projP, projS).dot(spineDir) >= 0 ? 1 : -1;
  angle = Math.min(angle, SPINE_TWIST.maxTwistRad) * sign;
  if (Math.abs(angle) < 1e-6) return null;
  return new THREE.Quaternion().setFromAxisAngle(spineDir, angle);
};

/**
 * 後屈アーチ補正のパラメータ（#35）。
 *
 * MediaPipe landmarks は hip/shoulder の中点しか与えず、脊椎の「アーチ形状
 * （chord ではなく arc）」は原理的に復元できない。そこで「腹が天井を向いている
 * ＝後屈」をポーズ分類の手がかりにし、テンプレートの弓なりカーブをブレンドする。
 *
 * - bellyUpThreshold: hips 基底の belly-forward 軸(+Z)の world Y 成分がこの値を
 *   超えたら後屈とみなす。直立・前屈・逆転(downdog/headstand)では belly 軸は
 *   水平〜下向きになるため発火しない。仰向け寝（savasana 等）は誤発火しうるが、
 *   静的画像のヨガポーズ推定では後屈系（wheel/bridge/fish）が支配的なので許容する。
 * - maxArchRad: 後屈度が最大(1.0)のときの弓の曲げ角。chord アライン後の伸展を
 *   一方向に積むと胸端が実測の肩位置から離れて丸まってしまうため、
 *   [+A, -A, -A] の「弓」deltas で両端位置を保ったまま中間を腹側へ膨らませる。
 *   値は e2e/poses/wheel.jpg の視覚検証で調整した。
 */
export const BACKBEND_ARCH = {
  bellyUpThreshold: 0.25,
  maxArchRad: (50 * Math.PI) / 180,
} as const;

/**
 * 後屈度（0..1）を推定する。hips 直交基底の belly-forward 軸が world 上方を
 * 向くほど大きい。しきい値以下は 0。sqrt で中域を持ち上げ、浅い検知値でも
 * 視覚的に分かるアーチが出るようにしている。
 */
export const computeBackbendAmount = (landmarks: RawLandmark[]): number => {
  const hipsQ = computeHipsRotation(landmarks);
  if (!hipsQ) return 0;
  const bellyY = new THREE.Vector3(0, 0, 1).applyQuaternion(hipsQ).y;
  const t = BACKBEND_ARCH.bellyUpThreshold;
  if (bellyY <= t) return 0;
  return Math.sqrt(Math.min(1, (bellyY - t) / (1 - t)));
};

/**
 * 後屈アーチ（弓）補正の world 回転 delta を Spine/Spine1/Spine2 の3ボーン分
 * 計算する。後屈でなければ null。
 *
 * delta は [+A, -A, -A]（回転軸 = hips 基底の左右軸 +X、正角 = 腹側）。
 * world delta は子孫にも波及するため、セグメントの chord に対する傾きは
 * [+A, 0, -A] となり、両端の位置を保ったまま中間ノードが腹側へ L·sinA だけ
 * 膨らむ対称な弓になる。末端（胸）セグメントは -A の伸展向きになり、
 * 胸が開く後屈の見た目が出る。
 */
export const computeBackbendArchRotations = (
  landmarks: RawLandmark[]
): [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion] | null => {
  const amount = computeBackbendAmount(landmarks);
  if (amount === 0) return null;
  const hipsQ = computeHipsRotation(landmarks);
  if (!hipsQ) return null;
  const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(hipsQ).normalize();
  const A = amount * BACKBEND_ARCH.maxArchRad;
  return [
    new THREE.Quaternion().setFromAxisAngle(xAxis, A),
    new THREE.Quaternion().setFromAxisAngle(xAxis, -A),
    new THREE.Quaternion().setFromAxisAngle(xAxis, -A),
  ];
};

/**
 * 体幹の目標回転（Quaternion）を Spine/Spine1/Spine2 の 3 ボーンに角度分配する。
 * 合成後の回転が元の targetRotation と一致するように、slerp で重み分割を行う。
 *
 * @param targetRotation Spine 全体に適用したい目標の回転
 * @param weights Spine, Spine1, Spine2 への分配重み。合計が 1 になること（デフォルト: [1/3, 1/3, 1/3]）
 * @returns [Spine用, Spine1用, Spine2用] の Quaternion 配列
 */
export const distributeSpineRotation = (
  targetRotation: THREE.Quaternion,
  weights: [number, number, number] = [1 / 3, 1 / 3, 1 / 3]
): [THREE.Quaternion, THREE.Quaternion, THREE.Quaternion] => {
  const q0 = new THREE.Quaternion().slerp(targetRotation, weights[0]);
  const q1 = new THREE.Quaternion().slerp(targetRotation, weights[1]);
  const q2 = new THREE.Quaternion().slerp(targetRotation, weights[2]);
  return [q0, q1, q2];
};
