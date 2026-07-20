import { describe, it, expect } from "vitest";
import { listPoseIds, NON_POSE_JSON } from "./goldenPoses.mjs";

describe("listPoseIds", () => {
  it("既存 3 dev ポーズを拾う（現行 e2e/golden/ の実運用ケース）", () => {
    const files = [
      "tabletop.json",
      "cross-seat.json",
      "kneel-sidebend.json",
      "sources.json",
      "sources.local.json.example",
      "_sample.json",
    ];
    expect(listPoseIds(files).sort()).toEqual(
      ["cross-seat", "kneel-sidebend", "tabletop"].sort()
    );
  });

  it("sources.json をポーズとして拾わない（Codex stop-time review 検出の実バグ回帰防止）", () => {
    // #106 で e2e/golden/sources.json（写真パスの対応表）を追加した際、
    // golden-check.mjs の全件モードが "sources" というポーズ名でこれを拾い
    // 壊れる問題があった。以後この回帰を検出する。
    const files = ["tabletop.json", "sources.json"];
    expect(listPoseIds(files)).toEqual(["tabletop"]);
    expect(NON_POSE_JSON.has("sources.json")).toBe(true);
    expect(NON_POSE_JSON.has("sources.local.json")).toBe(true);
  });

  it("_ 始まりのサンプルを除外する", () => {
    const files = ["_sample.json", "_wip.json", "tabletop.json"];
    expect(listPoseIds(files)).toEqual(["tabletop"]);
  });

  it("sources.local.json を除外する（.local. パターン）", () => {
    const files = ["tabletop.json", "sources.local.json"];
    expect(listPoseIds(files)).toEqual(["tabletop"]);
  });

  it(".example ファイルを除外する", () => {
    const files = ["tabletop.json", "sources.local.json.example"];
    expect(listPoseIds(files)).toEqual(["tabletop"]);
  });

  it("非 .json ファイルを除外する", () => {
    const files = ["tabletop.json", "README.md", "photos"];
    expect(listPoseIds(files)).toEqual(["tabletop"]);
  });

  it("入力順を保つ", () => {
    const files = ["b.json", "a.json", "c.json"];
    expect(listPoseIds(files)).toEqual(["b", "a", "c"]);
  });

  it("hold-out golden JSON も普通に拾う（tier で区別はしない）", () => {
    // listPoseIds は tier に関知しない。tier 判定は golden JSON 読み込み後
    // （normalizeTier / splitByTier）で行う
    const files = [
      "tabletop.json",
      "standing-tree.json",
      "supine-twist.json",
    ];
    expect(listPoseIds(files).sort()).toEqual(
      ["standing-tree", "supine-twist", "tabletop"].sort()
    );
  });
});
