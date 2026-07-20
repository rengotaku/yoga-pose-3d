import * as THREE from "three";
import { BONE_ALIASES, resolveBoneName } from "./retarget";

/**
 * ゴールデンポーズ編集モード（#93）の逆変換・Undo/Redo ロジック。
 * `golden.ts` の applyGoldenRotations（bind * euler(XYZ度) = current）の
 * 逆変換 offset = bind⁻¹ × current を提供し、編集した骨格から
 * golden.rotations 互換の JSON を書き出せるようにする。
 */

const collectBones = (root: THREE.Object3D): Map<string, THREE.Bone> => {
  const bones = new Map<string, THREE.Bone>();
  root.traverse((child) => {
    if ((child as THREE.Bone).isBone) {
      bones.set(child.name, child as THREE.Bone);
    }
  });
  return bones;
};

const ROUND_STEP_DEG = 0.5;

/** 度を 0.5° 単位に丸める。丸め結果の -0 は 0 に正規化する */
const roundToStep = (deg: number): number => {
  const rounded = Math.round(deg / ROUND_STEP_DEG) * ROUND_STEP_DEG;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** [-180, 180] へラップする（XYZ Euler 分解は通常この範囲内だが丸め誤差の保険） */
const wrapDeg180 = (deg: number): number => {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d === 0 ? 0 : d; // -0 対策
};

/**
 * スケルトンの現在ポーズを bind 相対 Euler XYZ 度へ逆変換する。
 * offset = bind⁻¹ × current を `new THREE.Euler().setFromQuaternion(q, "XYZ")`
 * で分解し、0.5° 単位に丸め・[-180,180] に正規化する。
 * 恒等（丸め後に全軸 0）のボーンは baseBones に含まれない限り出力しない。
 * @param root スケルトンのルート
 * @param initialQuaternions バインドポーズのローカル回転（実ボーン名→Quaternion）
 * @param baseBones 現行 golden.rotations のキー（mixamorig 標準名）。恒等でも必ず出力に含める
 */
export const exportGoldenRotations = (
  root: THREE.Object3D,
  initialQuaternions: Map<string, THREE.Quaternion>,
  baseBones: string[]
): Record<string, [number, number, number]> => {
  const bones = collectBones(root);
  const boneNames = Array.from(bones.keys());

  // 既知の標準ボーン名 (BONE_ALIASES) に加え、現行 JSON のキーも候補に含める。
  // これにより baseBones が独自命名でも suffix 一致で解決できる。
  const candidates = new Set<string>([...Object.keys(BONE_ALIASES), ...baseBones]);
  const forcedBones = new Set(baseBones);

  const bindInv = new THREE.Quaternion();
  const offset = new THREE.Quaternion();
  const euler = new THREE.Euler();

  const out: Record<string, [number, number, number]> = {};
  for (const stdName of candidates) {
    const actualName = resolveBoneName(stdName, boneNames);
    const bone = actualName ? bones.get(actualName) : undefined;
    const bind = actualName ? initialQuaternions.get(actualName) : undefined;
    if (!bone || !bind) continue;

    bindInv.copy(bind).invert();
    offset.copy(bindInv).multiply(bone.quaternion);
    euler.setFromQuaternion(offset, "XYZ");

    const x = wrapDeg180(roundToStep(THREE.MathUtils.radToDeg(euler.x)));
    const y = wrapDeg180(roundToStep(THREE.MathUtils.radToDeg(euler.y)));
    const z = wrapDeg180(roundToStep(THREE.MathUtils.radToDeg(euler.z)));

    const isIdentity = x === 0 && y === 0 && z === 0;
    if (isIdentity && !forcedBones.has(stdName)) continue;

    out[stdName] = [x, y, z];
  }

  return out;
};

/** Undo/Redo 用の履歴スタック上限（#93 v1 スコープ） */
export const MAX_HISTORY_STEPS = 50;

/**
 * 編集セッションの Undo/Redo 履歴（pure なスタック）。
 * `current` は呼び出し側が別途保持し、push/undo/redo はスナップショットの
 * 出し入れのみを担う（イミュータブル: 常に新しいオブジェクトを返す）。
 */
export type EditHistory<T> = {
  past: T[];
  future: T[];
};

/** 空の履歴を作る */
export const createEditHistory = <T>(): EditHistory<T> => ({ past: [], future: [] });

/**
 * 直前の状態 `previous` を履歴に積む（新しい編集操作の確定時に呼ぶ）。
 * future は破棄する（分岐した履歴は保持しない一般的な Undo/Redo の仕様）。
 * past は最大 MAX_HISTORY_STEPS 件までとし、超過分は古い方から捨てる。
 */
export const pushHistory = <T>(history: EditHistory<T>, previous: T): EditHistory<T> => {
  const past = [...history.past, previous].slice(-MAX_HISTORY_STEPS);
  return { past, future: [] };
};

/**
 * 1 手戻す。`current` は戻す前の現在値。
 * 戻せる履歴が無ければ null を返す（呼び出し側は何もしない）。
 */
export const undo = <T>(
  history: EditHistory<T>,
  current: T
): { history: EditHistory<T>; current: T } | null => {
  if (history.past.length === 0) return null;
  const previous = history.past[history.past.length - 1];
  const past = history.past.slice(0, -1);
  const future = [current, ...history.future].slice(0, MAX_HISTORY_STEPS);
  return { history: { past, future }, current: previous };
};

/**
 * 1 手やり直す。`current` はやり直す前の現在値。
 * やり直せる履歴が無ければ null を返す（呼び出し側は何もしない）。
 */
export const redo = <T>(
  history: EditHistory<T>,
  current: T
): { history: EditHistory<T>; current: T } | null => {
  if (history.future.length === 0) return null;
  const next = history.future[0];
  const future = history.future.slice(1);
  const past = [...history.past, current].slice(-MAX_HISTORY_STEPS);
  return { history: { past, future }, current: next };
};
