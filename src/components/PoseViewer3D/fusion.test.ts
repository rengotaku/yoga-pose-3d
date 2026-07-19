import { describe, it, expect } from "vitest";
import { LM, type RawLandmark } from "./muscles";
import { fuseLandmarks, FUSION } from "./fusion";

// 未使用の landmark は visibility を低くし、意図せず anchor に混入して
// フィットを歪めないようにする（実運用でも低信頼点は同様に除外される）。
const buildEmpty = (): RawLandmark[] =>
  Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));

/** 中間座標 (u,v) -> 2D landmark (x,y) の逆変換（v は y 下向き正のまま） */
const fromIntermediate = (
  u: number,
  v: number,
  aspect: number,
  visibility = 1
): RawLandmark => ({
  x: u / aspect + 0.5,
  y: v + 0.5,
  z: 0,
  visibility,
});

// 8関節分の十分にばらけた中間座標 (u,v)。anchor 数(>=6)を満たすため使う。
const GOOD_UV: [number, number][] = [
  [0.18, 0.35], // left shoulder
  [-0.18, 0.35], // right shoulder
  [0.2, -0.05], // left elbow
  [-0.2, -0.05], // right elbow
  [0.22, -0.4], // left wrist
  [-0.22, -0.4], // right wrist
  [0.1, 0.55], // left knee (used as extra anchor in some tests)
  [-0.1, 0.55], // right knee
];
const GOOD_INDICES = [
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_ELBOW,
  LM.RIGHT_ELBOW,
  LM.LEFT_WRIST,
  LM.RIGHT_WRIST,
  LM.LEFT_KNEE,
  LM.RIGHT_KNEE,
];

describe("fuseLandmarks", () => {
  it("recovers world x,y from a known similarity transform (s=2, t=(0.1,-0.3))", () => {
    const s = 2;
    const t = { x: 0.1, y: -0.3 };
    const aspect = 1.5;

    const lm2d = buildEmpty();
    const world = buildEmpty();
    GOOD_INDICES.forEach((idx, i) => {
      const [u, v] = GOOD_UV[i];
      lm2d[idx] = fromIntermediate(u, v, aspect);
      world[idx] = { x: s * u + t.x, y: s * v + t.y, z: 0.7 + i * 0.01, visibility: 1 };
    });

    const fused = fuseLandmarks(lm2d, world, aspect);

    GOOD_INDICES.forEach((idx) => {
      expect(fused[idx].x).toBeCloseTo(world[idx].x, 5);
      expect(fused[idx].y).toBeCloseTo(world[idx].y, 5);
      // z は world をそのまま使う
      expect(fused[idx].z).toBeCloseTo(world[idx].z, 5);
    });
  });

  it("restores hip distance from 2D ratio when world hips are collapsed by occlusion", () => {
    // 実測（#52）: 後ろ向き膝立ち画像で world 股関節距離が 0.09m まで潰れる一方、
    // 2D は健全。8点の健全な anchor で正確な s,t をフィットし、hip は
    // low-visibility（anchor から除外）だが 2D 位置から復元されることを検証する。
    const s = 1.8;
    const t = { x: 0.05, y: -0.2 };
    const aspect = 1.2;

    const lm2d = buildEmpty();
    const world = buildEmpty();
    GOOD_INDICES.forEach((idx, i) => {
      const [u, v] = GOOD_UV[i];
      lm2d[idx] = fromIntermediate(u, v, aspect);
      world[idx] = { x: s * u + t.x, y: s * v + t.y, z: 0.5, visibility: 1 };
    });

    // hip: 2D は健全な間隔を保つが visibility は低い（anchor から除外される）。
    // world は occlusion で潰れている（左右がほぼ同じ点に収束）。
    const hipU: [number, number] = [0.1, -0.1];
    const hipV = -0.02;
    lm2d[LM.LEFT_HIP] = fromIntermediate(hipU[0], hipV, aspect, 0.3);
    lm2d[LM.RIGHT_HIP] = fromIntermediate(hipU[1], hipV, aspect, 0.3);
    world[LM.LEFT_HIP] = { x: -0.01, y: -0.02, z: 0.5, visibility: 0.3 };
    world[LM.RIGHT_HIP] = { x: 0.015, y: -0.015, z: 0.5, visibility: 0.3 };

    const rawHipDist = Math.hypot(
      world[LM.RIGHT_HIP].x - world[LM.LEFT_HIP].x,
      world[LM.RIGHT_HIP].y - world[LM.LEFT_HIP].y
    );

    const fused = fuseLandmarks(lm2d, world, aspect);

    const expectedLeftHip = { x: s * hipU[0] + t.x, y: s * hipV + t.y };
    const expectedRightHip = { x: s * hipU[1] + t.x, y: s * hipV + t.y };
    const expectedHipDist = Math.hypot(
      expectedRightHip.x - expectedLeftHip.x,
      expectedRightHip.y - expectedLeftHip.y
    );

    const fusedHipDist = Math.hypot(
      fused[LM.RIGHT_HIP].x - fused[LM.LEFT_HIP].x,
      fused[LM.RIGHT_HIP].y - fused[LM.LEFT_HIP].y
    );

    // anchor から除外された low-visibility hip も、fit された s,t で 2D から復元される
    expect(fused[LM.LEFT_HIP].x).toBeCloseTo(expectedLeftHip.x, 4);
    expect(fused[LM.LEFT_HIP].y).toBeCloseTo(expectedLeftHip.y, 4);
    expect(fusedHipDist).toBeCloseTo(expectedHipDist, 4);
    expect(fusedHipDist).toBeGreaterThan(rawHipDist * 5);
  });

  it("returns world as-is when anchors are fewer than minAnchors", () => {
    const aspect = 1.0;
    const lm2d = buildEmpty();
    const world = buildEmpty();
    // minAnchors(6) 未満の 5 点だけを可視にする
    GOOD_INDICES.slice(0, FUSION.minAnchors - 1).forEach((idx, i) => {
      const [u, v] = GOOD_UV[i];
      lm2d[idx] = fromIntermediate(u, v, aspect);
      world[idx] = { x: 2 * u, y: 2 * v, z: 0.3, visibility: 1 };
    });

    const fused = fuseLandmarks(lm2d, world, aspect);
    // フォールバックは world と同一参照を返す契約（呼び出し側の融合成立判定が依存）
    expect(fused).toBe(world);
  });

  it("returns world as-is when 2D anchor points have zero variance", () => {
    const aspect = 1.0;
    const lm2d = buildEmpty();
    const world = buildEmpty();
    GOOD_INDICES.forEach((idx) => {
      // すべて同一点 → 分散ゼロ
      lm2d[idx] = { x: 0.5, y: 0.5, z: 0, visibility: 1 };
      world[idx] = { x: 0.1, y: 0.2, z: 0.3, visibility: 1 };
    });

    const fused = fuseLandmarks(lm2d, world, aspect);
    expect(fused).toBe(world);
  });

  it("reconstructs world exactly only when the passed aspect matches the image aspect used to build 2D", () => {
    // lm2d は aspect=1 の画像を前提に構築（identity similarity: s=1, t=0）。
    // fuseLandmarks に正しい aspect(1) を渡せば world を厳密に復元できるが、
    // 誤った aspect(3) を渡すと x 方向の中間座標が歪み、復元が崩れる
    // （aspect が実際に計算へ反映されていることの検証）。
    const lm2d = buildEmpty();
    const world = buildEmpty();
    GOOD_INDICES.forEach((idx, i) => {
      const [u, v] = GOOD_UV[i];
      lm2d[idx] = fromIntermediate(u, v, 1.0);
      world[idx] = { x: u, y: v, z: 0, visibility: 1 };
    });

    const idx = LM.LEFT_SHOULDER;
    const fusedCorrectAspect = fuseLandmarks(lm2d, world, 1.0);
    expect(fusedCorrectAspect[idx].x).toBeCloseTo(world[idx].x, 5);
    expect(fusedCorrectAspect[idx].y).toBeCloseTo(world[idx].y, 5);

    const fusedWrongAspect = fuseLandmarks(lm2d, world, 3.0);
    expect(Math.abs(fusedWrongAspect[idx].x - world[idx].x)).toBeGreaterThan(0.05);
  });

  it("keeps MediaPipe downward-positive y convention (no double flip)", () => {
    // fusion の出力は MediaPipe 系（y 下向き正）のまま。Three.js への反転は
    // toVec が担うため、ここで反転すると二重反転で上下逆になる（実画像で確認済み）。
    // 画像上部の landmark (y2d < 0.5) は world y < 0（=上）に写像される。
    const aspect = 1.0;
    const lm2d = buildEmpty();
    const world = buildEmpty();
    GOOD_INDICES.forEach((idx, i) => {
      const [u, v] = GOOD_UV[i];
      lm2d[idx] = fromIntermediate(u, v, aspect);
      world[idx] = { x: u, y: v, z: 0, visibility: 1 };
    });

    const fused = fuseLandmarks(lm2d, world, aspect);
    // 画像上部 (y2d < 0.5, v 負) → MediaPipe world では上 = y 負
    const aboveCenterIdx = LM.LEFT_WRIST; // v = -0.4 → y2d = 0.1
    expect(lm2d[aboveCenterIdx].y).toBeLessThan(0.5);
    expect(fused[aboveCenterIdx].y).toBeLessThan(0);
    // 画像下部 (y2d > 0.5, v 正) → 下 = y 正
    const belowCenterIdx = LM.LEFT_SHOULDER; // v = 0.35 → y2d = 0.85
    expect(lm2d[belowCenterIdx].y).toBeGreaterThan(0.5);
    expect(fused[belowCenterIdx].y).toBeGreaterThan(0);
  });

  it("returns world as-is when 2D and world are anti-correlated (s would be negative)", () => {
    // 2D と world の点配置が逆相関 → フィットされる s が負になる退化ケース。
    // 安全側フォールバック（world をそのまま返す）が働くことを検証する。
    const aspect = 1.0;
    const lm2d = buildEmpty();
    const world = buildEmpty();
    GOOD_INDICES.forEach((idx, i) => {
      const [u, v] = GOOD_UV[i];
      lm2d[idx] = fromIntermediate(u, v, aspect);
      // world 側を符号反転して負のスケールに相当させる
      world[idx] = { x: -u, y: -v, z: 0.3, visibility: 1 };
    });

    const fused = fuseLandmarks(lm2d, world, aspect);
    expect(fused).toBe(world);
  });

  it("treats undefined visibility as fully visible with weight 1 (backward compat)", () => {
    // visibility 未定義の 2D landmark は isVisible と同様に可視扱い・重み 1 で
    // anchor に採用され、フィット結果は明示 visibility=1 の場合と一致する。
    const s = 1.5;
    const t = { x: -0.05, y: 0.2 };
    const aspect = 1.0;

    const build = (withVisibility: boolean) => {
      const lm2d = buildEmpty();
      const world = buildEmpty();
      GOOD_INDICES.forEach((idx, i) => {
        const [u, v] = GOOD_UV[i];
        const lm = fromIntermediate(u, v, aspect);
        if (!withVisibility) delete lm.visibility;
        lm2d[idx] = lm;
        world[idx] = { x: s * u + t.x, y: s * v + t.y, z: 0.1, visibility: 1 };
      });
      return fuseLandmarks(lm2d, world, aspect);
    };

    const fusedUndefined = build(false);
    const fusedExplicit = build(true);
    GOOD_INDICES.forEach((idx) => {
      expect(fusedUndefined[idx].x).toBeCloseTo(fusedExplicit[idx].x, 10);
      expect(fusedUndefined[idx].y).toBeCloseTo(fusedExplicit[idx].y, 10);
      // undefined でも融合が成立している（world フォールバックではない）
      expect(fusedUndefined[idx].x).toBeCloseTo(
        s * GOOD_UV[GOOD_INDICES.indexOf(idx)][0] + t.x,
        5
      );
    });
  });

  it("passes through world landmark unchanged when 2D is missing at that index", () => {
    const aspect = 1.0;
    const lm2d = buildEmpty();
    const world = buildEmpty();
    GOOD_INDICES.forEach((idx, i) => {
      const [u, v] = GOOD_UV[i];
      lm2d[idx] = fromIntermediate(u, v, aspect);
      world[idx] = { x: 2 * u, y: 2 * v, z: 0.4, visibility: 1 };
    });

    // 片側だけ欠損させる (2D 未検出だが world は存在する index)
    const missingIdx = LM.NOSE;
    world[missingIdx] = { x: 0.42, y: -0.13, z: 0.05, visibility: 0.9 };
    // lm2d[missingIdx] は buildEmpty() のダミー値のまま存在するため、
    // 明示的に配列から取り除いて「欠損」を表現する
    (lm2d as (RawLandmark | undefined)[])[missingIdx] = undefined;

    const fused = fuseLandmarks(lm2d, world, aspect);
    expect(fused[missingIdx]).toEqual(world[missingIdx]);
  });
});
