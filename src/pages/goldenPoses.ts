import type { GoldenPose } from "../components/PoseViewer3D/golden";

// e2e/golden/*.json をビルド時に取り込む。"_" 始まり（サンプル等）は除外
const goldenModules = import.meta.glob<GoldenPose>("../../e2e/golden/*.json", {
  eager: true,
  import: "default",
});

export const GOLDEN_POSES: GoldenPose[] = Object.values(goldenModules)
  .filter((g): g is GoldenPose => Boolean(g?.pose) && !g.pose.startsWith("_"))
  .sort((a, b) => a.pose.localeCompare(b.pose));

/**
 * ゴールデンデータの短い内容ハッシュ（#88）。人間と AI が「同じデータを
 * 見ているか」を突合するために /golden へ表示する。djb2 の 8 桁 hex。
 */
export const goldenDataHash = (golden: GoldenPose): string => {
  const text = JSON.stringify(golden.rotations);
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};
