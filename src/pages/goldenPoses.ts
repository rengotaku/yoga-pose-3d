import type { GoldenPose } from "../components/PoseViewer3D/golden";

// e2e/golden/*.json をビルド時に取り込む。"_" 始まり（サンプル等）は除外
const goldenModules = import.meta.glob<GoldenPose>("../../e2e/golden/*.json", {
  eager: true,
  import: "default",
});

export const GOLDEN_POSES: GoldenPose[] = Object.values(goldenModules)
  .filter((g): g is GoldenPose => Boolean(g?.pose) && !g.pose.startsWith("_"))
  .sort((a, b) => a.pose.localeCompare(b.pose));
