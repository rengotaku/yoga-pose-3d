import * as THREE from "three";
import { buildBodyCapsules, detectSelfPenetrations } from "./poseValidity";

export interface ClampResult {
  accepted: boolean;
  blockedPairs: { a: string; b: string }[];
}

/**
 * 編集時 (gizmo 回転 / IK ドラッグ) の貫通ガード (sub E)。
 * 入力適用後に p.severity === 'fail' の件数が入力前より増える場合、
 * 二分探索で「件数が増えない safe な最大 factor」に clamp する。
 */
export function tryApplyWithClamp(
  mannequin: THREE.Object3D,
  applyDelta: (factor: number) => void
): ClampResult {
  // 1. 入力前 (factor=0) の baseline fail ペアを検出
  applyDelta(0);
  mannequin.updateMatrixWorld(true);
  const baselinePenetrations = detectSelfPenetrations(buildBodyCapsules(mannequin));
  const baselineFailCount = baselinePenetrations.filter(
    (p) => p.severity === "fail"
  ).length;

  // 2. フル適用 (factor=1.0)
  applyDelta(1.0);
  mannequin.updateMatrixWorld(true);
  const fullPenetrations = detectSelfPenetrations(buildBodyCapsules(mannequin));
  const fullFails = fullPenetrations.filter((p) => p.severity === "fail");

  // TODO(enhancement): pair 差分での質的悪化検知
  if (fullFails.length <= baselineFailCount) {
    // fail 件数が増えていないので accept
    return { accepted: true, blockedPairs: [] };
  }

  // 3. fail 件数が増えたので reject -> blockedPairs を集計
  const baselineFailKeys = new Set(
    baselinePenetrations
      .filter((p) => p.severity === "fail")
      .map((p) => [p.a, p.b].sort().join("|"))
  );
  const newFails = fullFails.filter(
    (p) => !baselineFailKeys.has([p.a, p.b].sort().join("|"))
  );
  const blockedFails = newFails.length > 0 ? newFails : fullFails;
  const blockedPairs = blockedFails.map((p) => ({ a: p.a, b: p.b }));

  // 4. 二分探索 (8回反復: 精度 1/256 ≈ 0.4%)
  let low = 0.0;
  let high = 1.0;
  let bestFactor = 0.0;
  const ITERATIONS = 8;
  for (let i = 0; i < ITERATIONS; i++) {
    const mid = (low + high) / 2;
    applyDelta(mid);
    mannequin.updateMatrixWorld(true);
    const midFails = detectSelfPenetrations(buildBodyCapsules(mannequin)).filter(
      (p) => p.severity === "fail"
    );
    if (midFails.length <= baselineFailCount) {
      bestFactor = mid;
      low = mid;
    } else {
      high = mid;
    }
  }

  // 最終的に safe な位置に pose を適用
  applyDelta(bestFactor);
  mannequin.updateMatrixWorld(true);

  return { accepted: false, blockedPairs };
}
