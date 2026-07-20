import { describe, it, expect } from "vitest";
import { splitByTier, averageOf, aggregateTotals, ALLOWED_TIERS } from "./aggregate.mjs";

describe("splitByTier", () => {
  it("treats an unspecified tier as dev", () => {
    const { dev, holdout } = splitByTier([{ pose: "tabletop" }]);
    expect(dev).toEqual([{ pose: "tabletop" }]);
    expect(holdout).toEqual([]);
  });

  it("separates dev and holdout entries", () => {
    const items = [
      { pose: "tabletop", tier: "dev" },
      { pose: "new-pose", tier: "holdout" },
    ];
    const { dev, holdout } = splitByTier(items);
    expect(dev).toEqual([items[0]]);
    expect(holdout).toEqual([items[1]]);
  });

  it("throws on unknown tier values (typo, wrong case, etc.)", () => {
    // "holdot" のような typo が黙って dev 扱いになると過適合検出の
    // 意味が壊れるため、厳格に throw する（ADR 0009）
    expect(() => splitByTier([{ pose: "typo-pose", tier: "holdot" }])).toThrow(
      /unknown tier/
    );
    expect(() => splitByTier([{ tier: "Dev" }])).toThrow(/unknown tier/);
    expect(ALLOWED_TIERS.has("dev")).toBe(true);
    expect(ALLOWED_TIERS.has("holdout")).toBe(true);
  });
});

describe("averageOf", () => {
  it("returns null for an empty array", () => {
    expect(averageOf([], (t) => t.total)).toBeNull();
  });

  it("averages the selected value", () => {
    const items = [{ total: 10 }, { total: 20 }, { total: 30 }];
    expect(averageOf(items, (t) => t.total)).toBeCloseTo(20, 6);
  });
});

describe("aggregateTotals", () => {
  it("dev のみの場合: averageHoldout は null、average は dev と一致する", () => {
    const totals = [
      { pose: "tabletop", tier: "dev", total: 40 },
      { pose: "cross-seat", tier: "dev", total: 50 },
      { pose: "kneel-sidebend", total: 40 }, // tier 未指定 = dev
    ];
    const agg = aggregateTotals(totals);
    expect(agg.dev).toHaveLength(3);
    expect(agg.holdout).toHaveLength(0);
    expect(agg.averageDev).toBeCloseTo((40 + 50 + 40) / 3, 6);
    expect(agg.averageHoldout).toBeNull();
    expect(agg.average).toBeCloseTo(agg.averageDev, 6);
  });

  it("holdout のみの場合: averageDev は null", () => {
    const totals = [
      { pose: "new-pose-a", tier: "holdout", total: 60 },
      { pose: "new-pose-b", tier: "holdout", total: 80 },
    ];
    const agg = aggregateTotals(totals);
    expect(agg.dev).toHaveLength(0);
    expect(agg.holdout).toHaveLength(2);
    expect(agg.averageDev).toBeNull();
    expect(agg.averageHoldout).toBeCloseTo(70, 6);
    expect(agg.average).toBeCloseTo(agg.averageHoldout, 6);
  });

  it("dev/holdout 混在の場合: 各平均が独立し、全体平均は両方を合わせた値になる", () => {
    const totals = [
      { pose: "tabletop", tier: "dev", total: 40 },
      { pose: "cross-seat", tier: "dev", total: 60 },
      { pose: "new-pose", tier: "holdout", total: 20 },
    ];
    const agg = aggregateTotals(totals);
    expect(agg.averageDev).toBeCloseTo(50, 6);
    expect(agg.averageHoldout).toBeCloseTo(20, 6);
    expect(agg.average).toBeCloseTo((40 + 60 + 20) / 3, 6);
    // 過学習検出の実運用シナリオ: dev が holdout より著しく高ければ乖離が見える
    expect(agg.averageDev - agg.averageHoldout).toBeCloseTo(30, 6);
  });

  it("旧 results との後方互換契約: dev → holdout の連結と一致し順序が保存される", () => {
    // pose-score.mjs は schemaVersion 2 で resultsByTier を出しつつ、
    // schemaVersion 1 の consumer 向けに旧 `results` を残す（ADR 0009）。
    // 契約: `results === resultsByTier.dev.concat(resultsByTier.holdout)`
    // を集計側で機械的に維持できることを固定する。
    const totals = [
      { pose: "tabletop", tier: "dev", total: 40 },
      { pose: "new-pose", tier: "holdout", total: 20 },
      { pose: "cross-seat", tier: "dev", total: 60 },
      { pose: "hold-b", tier: "holdout", total: 30 },
    ];
    const agg = aggregateTotals(totals);
    const legacyResults = agg.dev.concat(agg.holdout);
    // dev は入力順で並び、その後 holdout が入力順で続く（過適合分析で
    // 「同じ pose の dev/holdout ペアを追う」ため順序を壊さない）
    expect(agg.dev.map((t) => t.pose)).toEqual(["tabletop", "cross-seat"]);
    expect(agg.holdout.map((t) => t.pose)).toEqual(["new-pose", "hold-b"]);
    expect(legacyResults.map((t) => t.pose)).toEqual([
      "tabletop",
      "cross-seat",
      "new-pose",
      "hold-b",
    ]);
  });
});
