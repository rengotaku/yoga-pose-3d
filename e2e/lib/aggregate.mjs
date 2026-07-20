/**
 * pose-score / golden-check の tier 別集計（#104）。
 *
 * pose-score.mjs / golden-check.mjs は playwright に依存し vitest から直接
 * 実行できないため、tier 分離の集計ロジックだけを純粋関数として切り出す。
 * dev（既存 3 ポーズ）と holdout（過適合検出用に別途追加するポーズ）を
 * 分けて平均を出し、過学習の有無を dev/holdout の乖離で確認できるようにする。
 */

/**
 * `tier` フィールド（"dev" | "holdout" | undefined）を持つ配列を
 * dev / holdout に振り分ける。未指定は "dev" 扱い（GoldenPose のデフォルトと同一）。
 * @template {{ tier?: "dev" | "holdout" }} T
 * @param {T[]} items
 * @returns {{ dev: T[], holdout: T[] }}
 */
export const splitByTier = (items) => {
  const dev = [];
  const holdout = [];
  for (const item of items) {
    if (item.tier === "holdout") {
      holdout.push(item);
    } else {
      dev.push(item);
    }
  }
  return { dev, holdout };
};

/**
 * items の selector(item) の単純平均。空配列は null（コンソール表示の
 * "セクション省略" 判定・JSON の null 出力の両方に使う）。
 * @template T
 * @param {T[]} items
 * @param {(item: T) => number} selector
 * @returns {number | null}
 */
export const averageOf = (items, selector) => {
  if (items.length === 0) return null;
  return items.reduce((sum, item) => sum + selector(item), 0) / items.length;
};

/**
 * `{ pose, tier, total }` の配列を dev/holdout に分けて平均を算出する。
 * `average` は dev+holdout 全体（tier 未分離時の旧集計と同義）。
 * @param {Array<{ pose: string, tier?: "dev" | "holdout", total: number }>} totals
 */
export const aggregateTotals = (totals) => {
  const { dev, holdout } = splitByTier(totals);
  return {
    dev,
    holdout,
    averageDev: averageOf(dev, (t) => t.total),
    averageHoldout: averageOf(holdout, (t) => t.total),
    average: averageOf(totals, (t) => t.total),
  };
};
