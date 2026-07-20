import * as THREE from "three";
import { BONE_ALIASES } from "./retarget";
import { clampAxisToRom } from "./romClamp";

/**
 * 脱力モード（#110）: 選択ボーン以下の駆動対象ボーンを重力方向へ整列させ、
 * 既存 ROM テーブルで軸クランプする静的ヒューリスティック。物理シミュや
 * IK ソルバを使わず three.js の Bone/Quaternion 操作だけで完結する。
 *
 * アルゴリズム（親→子順に逐次適用）:
 *  1. bone の主幹 child 方向 = 唯一の駆動対象子ボーンの world 位置差
 *     （分岐 or 葉なら bone 自体は回さない = 姿勢維持）
 *  2. その方向を world -Y へ strength だけ lerp → 目標方向
 *  3. `Quaternion.setFromUnitVectors(dir, target)` で最小 swing を計算
 *  4. `swing * currentWorldQuat` を desiredWorld とし、既存ツイストを保持
 *  5. `parentWorldQuat⁻¹ * desiredWorld` で local へ戻す
 *  6. `bind⁻¹ * desiredLocal` を Euler XYZ 分解し軸ごとに ROM クランプ
 *  7. `bone.quaternion = bind * clampedOffset` を書き込み world matrix 更新
 *
 * 落とし穴（codex 診断 + 実装で対処）:
 *  - 親を先に更新しないと子の world 位置が古い → 親→子順の chain 収集
 *  - 分岐ボーン（Hand → 5 指）で child 方向が一意に決まらない → 分岐は回さず
 *    子孫に処理を委譲する（Hand は動かず各指が独立に垂れる）
 *  - 重力方向だけではツイストが決まらない → 最小 swing 左乗算で既存ツイスト維持
 *  - Euler 分解特異点付近のジャンプ → strength 上限（既定 0.7）で緩和
 */

export type RelaxOptions = {
  /** 現在の child 方向から world -Y へ lerp する強度 [0..1]。1.0 で完全に鉛直、既定 0.7 */
  strength: number;
  /** 指ボーン（Thumb/Index/Middle/Ring/Pinky）を対象に含めるか */
  includeFingers: boolean;
};

export type RelaxResult = {
  /** 実際に quaternion が変化したボーン数（変化 = クランプ結果が現在値と異なる） */
  changedCount: number;
  /** 実際に処理対象になった駆動対象ボーンの実ボーン名 */
  affectedActualNames: string[];
};

const GRAVITY_WORLD = new THREE.Vector3(0, -1, 0);
const EDITABLE_STD_NAMES: ReadonlySet<string> = new Set(Object.keys(BONE_ALIASES));

const isFingerStdName = (stdName: string): boolean =>
  /Thumb|Index|Middle|Ring|Pinky/.test(stdName);

/** ボーンの userData.stdName（マウント時に付与）を取り出す。無ければ空文字 */
const stdNameOf = (bone: THREE.Object3D): string =>
  (bone.userData.stdName as string | undefined) ?? "";

/**
 * 選択ボーンから駆動対象の子孫を BFS で親→子順に収集する（選択ボーン自身は含めない）。
 * `BONE_ALIASES` に登録され `bone.userData.stdName` が付いているボーンのみが対象。
 * includeFingers=false のときは指ボーン（stdName 判定）を除外する。
 */
export const collectRelaxChain = (
  selected: THREE.Bone,
  opts: { includeFingers: boolean }
): THREE.Bone[] => {
  const out: THREE.Bone[] = [];
  const queue: THREE.Object3D[] = [selected];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of cur.children) {
      if ((child as THREE.Bone).isBone) {
        const stdName = stdNameOf(child);
        const isEditable = stdName !== "" && EDITABLE_STD_NAMES.has(stdName);
        const skipFinger = !opts.includeFingers && isFingerStdName(stdName);
        if (isEditable && !skipFinger) out.push(child as THREE.Bone);
      }
      queue.push(child);
    }
  }
  return out;
};

/**
 * bone の主幹 child 方向（world）を返す。駆動対象の子が「ちょうど 1 本」ある
 * ときのみ有効。分岐（複数子）や葉（子なし）では null を返す = 回転を保留する。
 * includeFingers=false のときは指ボーンを子候補から除外する（Hand → 手のひら
 * を持つ主幹があれば返し、指しかない Hand は null になる）。
 */
const mainChildWorldDirection = (
  bone: THREE.Bone,
  includeFingers: boolean
): THREE.Vector3 | null => {
  const editableChildren = bone.children.filter((c) => {
    if (!(c as THREE.Bone).isBone) return false;
    const s = stdNameOf(c);
    if (s === "" || !EDITABLE_STD_NAMES.has(s)) return false;
    if (!includeFingers && isFingerStdName(s)) return false;
    return true;
  }) as THREE.Bone[];
  if (editableChildren.length !== 1) return null;

  const boneWorld = bone.getWorldPosition(new THREE.Vector3());
  const childWorld = editableChildren[0].getWorldPosition(new THREE.Vector3());
  const dir = childWorld.sub(boneWorld);
  if (dir.lengthSq() < 1e-12) return null;
  return dir.normalize();
};

/**
 * bind 相対 offset の Euler XYZ を軸ごとにクランプし、bind * clampedOffset を
 * 返す（ローカル quaternion）。goldenEdit.ts の逆変換と同じ座標系。
 */
const clampLocalToRom = (
  stdName: string,
  bind: THREE.Quaternion,
  desiredLocal: THREE.Quaternion
): THREE.Quaternion => {
  const offset = bind.clone().invert().multiply(desiredLocal);
  const euler = new THREE.Euler().setFromQuaternion(offset, "XYZ");
  const cx = clampAxisToRom(stdName, "x", THREE.MathUtils.radToDeg(euler.x));
  const cy = clampAxisToRom(stdName, "y", THREE.MathUtils.radToDeg(euler.y));
  const cz = clampAxisToRom(stdName, "z", THREE.MathUtils.radToDeg(euler.z));
  const clampedOffset = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      THREE.MathUtils.degToRad(cx),
      THREE.MathUtils.degToRad(cy),
      THREE.MathUtils.degToRad(cz),
      "XYZ"
    )
  );
  return bind.clone().multiply(clampedOffset);
};

/**
 * 選択ボーン以下を重力方向へ整列 + ROM 内クランプする。副作用として
 * `bone.quaternion` を書き換え、各ボーン更新後に `updateMatrixWorld(true)` を
 * 呼ぶ。呼び出し側は完了後に `exportGoldenRotations()` で最終 `Rotations` を
 * 生成し、履歴と state へ 1 回だけ反映する（適用中フラグでゲート debounce を
 * 抑止すること）。
 */
export const relaxDownstream = (
  selected: THREE.Bone,
  initialQuaternions: Map<string, THREE.Quaternion>,
  opts: RelaxOptions
): RelaxResult => {
  const strength = Math.max(0, Math.min(1, opts.strength));
  const chain = collectRelaxChain(selected, opts);
  const affectedActualNames: string[] = [];
  let changedCount = 0;

  for (const bone of chain) {
    const stdName = stdNameOf(bone);
    const bind = initialQuaternions.get(bone.name);
    if (!bind || !bone.parent) continue;

    const dir = mainChildWorldDirection(bone, opts.includeFingers);
    if (!dir) continue; // 分岐/葉ボーンは回さず子孫に処理を委譲

    const target = dir.clone().lerp(GRAVITY_WORLD, strength);
    if (target.lengthSq() < 1e-12) continue;
    target.normalize();

    // 現在方向 → 目標方向 の最小 swing を計算し、現在 world quat に左乗算
    // → 既存ツイスト（軸まわり回転）を維持したまま swing だけを追加できる。
    const swing = new THREE.Quaternion().setFromUnitVectors(dir, target);
    const currentWorldQuat = bone.getWorldQuaternion(new THREE.Quaternion());
    const desiredWorld = swing.multiply(currentWorldQuat);
    const parentWorldQuat = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const desiredLocal = parentWorldQuat.invert().multiply(desiredWorld);

    const clampedLocal = clampLocalToRom(stdName, bind, desiredLocal);

    // 変化があった場合のみカウント（no-op でも affectedActualNames には積む）
    if (!clampedLocal.equals(bone.quaternion)) {
      bone.quaternion.copy(clampedLocal);
      bone.updateMatrixWorld(true);
      changedCount++;
    }
    affectedActualNames.push(bone.name);
  }

  return { changedCount, affectedActualNames };
};
