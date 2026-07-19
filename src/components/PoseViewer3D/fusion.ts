import { isVisible, type RawLandmark } from "./muscles";

/**
 * 2D/world landmark 融合のしきい値（#61）。
 *
 * MediaPipe の world landmarks はオクルージョンの強い画像で x,y が大きく劣化する
 * （実測: 後ろ向き膝立ち画像で股関節距離が 0.09m まで潰れる）一方、2D landmarks
 * （画像正規化座標）の x,y は同条件でも比較的正確。2D の x,y を similarity 変換
 * （回転なし: 等方スケール + 並進のみ）で world 座標系へ写像し、z のみ world を
 * 使うことでリターゲット入力の精度を上げる。
 *
 * 回転項を入れない理由: 静止画のヨガ写真はカメラほぼ正立で、回転自由度は
 * ノイズを吸収して劣化要因になるため（設計判断・変更禁止）。
 */
export const FUSION = {
  /** similarity fit の anchor に使う最低 visibility */
  minAnchorVisibility: 0.5,
  /** これ未満なら融合せず world をそのまま返す */
  minAnchors: 6,
} as const;

type Point2D = { x: number; y: number };

/**
 * 2D landmark (x∈[0,1], y は下向き正) を中間座標 (u,v) へ変換する。
 * v は y 下向き正のまま（MediaPipe world も y 下向き正で、Three.js への
 * 反転は toVec が担う。ここで反転すると二重反転で上下逆になる）。
 */
const toIntermediate = (lm: RawLandmark, aspect: number): Point2D => ({
  x: (lm.x - 0.5) * aspect,
  y: lm.y - 0.5,
});

type Anchor = { p: Point2D; q: Point2D; w: number };

/**
 * 2D landmarks（画像正規化座標）と world landmarks（メートル）を融合し、
 * x,y は 2D 由来の similarity 変換（回転なし: 等方スケール + 並進）、
 * z は world をそのまま使った landmark 配列を返す。
 *
 * anchor 不足・分散ゼロ等でフィットが不安定な場合は world を**同一参照のまま**
 * 返す（安全側フォールバック）。呼び出し側はこの参照同一性で融合の成立を
 * 判定できる（PoseViewer3D の駆動ゲート緩和判定が依存。壊すと危ない契約）。
 */
export const fuseLandmarks = (
  landmarks2d: RawLandmark[],
  world: RawLandmark[],
  aspect: number
): RawLandmark[] => {
  const anchors: Anchor[] = [];
  for (let i = 0; i < world.length; i++) {
    const lm2d = landmarks2d[i];
    const w = world[i];
    if (!lm2d || !w) continue;
    // MediaPipe の 2D/world visibility は同一値のため 2D 側のみ判定する
    if (!isVisible(lm2d, FUSION.minAnchorVisibility)) continue;
    anchors.push({
      p: toIntermediate(lm2d, aspect),
      q: { x: w.x, y: w.y },
      w: lm2d.visibility ?? 1,
    });
  }

  if (anchors.length < FUSION.minAnchors) return world;

  const totalWeight = anchors.reduce((sum, a) => sum + a.w, 0);
  const pBar: Point2D = {
    x: anchors.reduce((sum, a) => sum + a.w * a.p.x, 0) / totalWeight,
    y: anchors.reduce((sum, a) => sum + a.w * a.p.y, 0) / totalWeight,
  };
  const qBar: Point2D = {
    x: anchors.reduce((sum, a) => sum + a.w * a.q.x, 0) / totalWeight,
    y: anchors.reduce((sum, a) => sum + a.w * a.q.y, 0) / totalWeight,
  };

  let numerator = 0;
  let denominator = 0;
  for (const a of anchors) {
    const dpx = a.p.x - pBar.x;
    const dpy = a.p.y - pBar.y;
    const dqx = a.q.x - qBar.x;
    const dqy = a.q.y - qBar.y;
    numerator += a.w * (dpx * dqx + dpy * dqy);
    denominator += a.w * (dpx * dpx + dpy * dpy);
  }

  if (denominator < 1e-8) return world;

  const s = numerator / denominator;
  if (!Number.isFinite(s) || s <= 0) return world;

  const t: Point2D = {
    x: qBar.x - s * pBar.x,
    y: qBar.y - s * pBar.y,
  };

  return world.map((w, i) => {
    const lm2d = landmarks2d[i];
    if (!lm2d || !w) return w;
    const p = toIntermediate(lm2d, aspect);
    return {
      x: s * p.x + t.x,
      y: s * p.y + t.y,
      z: w.z,
      visibility: w.visibility,
    };
  });
};
