import { romLimitFor } from "./poseValidity";

/**
 * ROM クランプ共有ユーティリティ（#110）。
 *
 * 編集モード（GoldenViewerPage.tsx）のギズモ objectChange と、脱力モード
 * （relax.ts）が同じクランプ関数を使うために抽出した。テーブル未登録の
 * ボーン/軸は ±180 として実質無制限に振る舞う。
 */

export type AxisKey = "x" | "y" | "z";

export type AxisRange = { min: number; max: number };

/** 軸の ROM 範囲を返す（テーブルに無いボーン/軸は ±180 で実質無制限） */
export const romRangeFor = (stdName: string, axis: AxisKey): AxisRange =>
  romLimitFor(stdName)?.[axis] ?? { min: -180, max: 180 };

/** ROM の min/max へクランプした値を返す（度） */
export const clampAxisToRom = (stdName: string, axis: AxisKey, value: number): number => {
  const range = romRangeFor(stdName, axis);
  return Math.min(range.max, Math.max(range.min, value));
};
