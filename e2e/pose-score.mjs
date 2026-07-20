#!/usr/bin/env node
/**
 * ゴールデン指標スコアラー（#72）。実写真をパイプラインに通した最終ボーン回転と
 * ゴールデン（手付け正解）の world 回転の角度差から、関節別 + 総合スコア
 * （0〜100%）を算出して表示する。
 *
 * #102 で以下を追加:
 *   - 関節ごとの swing/twist スコア表示
 *   - サマリに swingAvg / twistAvg / coverage / p10 / median / min
 *   - --json <path> で機械可読出力（後段の hold-out 集計・分位点比較に使う）
 *
 * #104 で以下を追加（過適合検出の下準備。数値目標や hold-out ポーズの追加は
 * 対象外。詳細は ADR 0009）:
 *   - ゴールデン JSON の tier（"dev" | "holdout"、未指定は "dev"）で集計を分離
 *   - コンソール summary を dev/holdout で分割表示（片方が空ならセクション省略）
 *   - --json 出力を schemaVersion 2 にバンプし、averageDev/averageHoldout/
 *     resultsByTier を追加（旧 results は resultsByTier.dev.concat(holdout)
 *     として後方互換維持）
 *
 * 実写真の参照優先順位（ADR 0010）:
 *   1) e2e/golden/sources.local.json（gitignore 済み。存在時は最優先）
 *   2) e2e/golden/sources.json（committed。in-repo 写真の default パス）
 * 両方に同じ pose キーがあれば sources.local.json が勝つ。相対パスは
 * e2e/golden/ からの相対として解決される。
 *
 * 前提: dev サーバ起動済み（ポートは PORT 環境変数、既定 5173）。
 * 実行: make pose-score                            （全ポーズ）
 *       make pose-score POSE=tabletop              （単一ポーズ）
 *       make pose-score -- --json /tmp/score.json  （JSON も併記出力）
 */
import { chromium } from "playwright";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { ALLOWED_TIERS } from "./lib/aggregate.mjs";

/** golden.tier を厳格に正規化。未指定は "dev"、既知でない値は throw。 */
const normalizeTier = (raw, pose) => {
  if (raw === undefined) return "dev";
  if (ALLOWED_TIERS.has(raw)) return raw;
  throw new Error(
    `unknown tier "${String(raw)}" in ${pose}.json: allowed values are ${[...ALLOWED_TIERS].join(", ")} or undefined`
  );
};
import { aggregateTotals, splitByTier } from "./lib/aggregate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");
const port = process.env.PORT ?? "5173";
const baseUrl = `http://localhost:${port}`;

const cliArgs = process.argv.slice(2);
const jsonFlagIdx = cliArgs.indexOf("--json");
const jsonPath =
  jsonFlagIdx >= 0 && cliArgs[jsonFlagIdx + 1] ? cliArgs[jsonFlagIdx + 1] : null;
const positionals = cliArgs.filter((_, i) => i !== jsonFlagIdx && i !== jsonFlagIdx + 1);

/**
 * sources.json（committed）と sources.local.json（gitignore・ローカル上書き）を
 * マージして pose → 絶対パスの map を返す（ADR 0010）。
 * どちらも無ければ空マップ。相対パスは goldenDir 基準で絶対化する。
 */
const loadSources = () => {
  const merged = {};
  for (const name of ["sources.json", "sources.local.json"]) {
    const p = join(goldenDir, name);
    if (!existsSync(p)) continue;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    for (const [pose, photo] of Object.entries(raw)) {
      if (typeof photo !== "string") continue;
      merged[pose] = isAbsolute(photo) ? photo : join(goldenDir, photo);
    }
  }
  return merged;
};

const sources = loadSources();
if (Object.keys(sources).length === 0) {
  console.error(
    `no photo sources: neither sources.json nor sources.local.json found in ${goldenDir}\n` +
      "e2e/golden/sources.local.json.example を参考に sources.local.json を作るか、\n" +
      "in-repo の e2e/golden/sources.json を追加してください（ADR 0010）"
  );
  process.exit(1);
}
const poseFilter = process.env.POSE ?? positionals[0];
const entries = Object.entries(sources).filter(
  ([pose]) => !poseFilter || pose === poseFilter
);
if (entries.length === 0) {
  console.error(`no pose entries` + (poseFilter ? ` (POSE=${poseFilter})` : ""));
  process.exit(1);
}

const res = await fetch(baseUrl).catch(() => null);
if (!res || !res.ok) {
  console.error(`dev server not reachable at ${baseUrl} — run \`make run\` first`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const fmtDeg = (v) => (v == null ? "  -  " : v.toFixed(1).padStart(6));
const fmtPct = (v) => (v == null ? " - " : (v * 100).toFixed(0).padStart(3));

let failed = false;
const totals = [];
const jsonResults = [];
for (const [pose, photoPath] of entries) {
  const goldenPath = join(goldenDir, `${pose}.json`);
  if (!existsSync(goldenPath)) {
    console.warn(`skip: ${pose}: golden json がまだ無い (${goldenPath})`);
    continue;
  }
  if (!existsSync(photoPath)) {
    console.warn(`skip: ${pose}: 実写真が見つからない (${photoPath})`);
    continue;
  }
  try {
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    const tier = normalizeTier(golden.tier, pose);
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByText("クリックまたはドラッグ＆ドロップ").click();
    const chooser = await chooserPromise;
    await chooser.setFiles(photoPath);
    // 推論 + リターゲット + 描画の完了を待つ（凡例の出現 + 安定待ち）
    await page.getByText("使用筋（推定）").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const score = await page.evaluate((g) => window.__poseDebug.scoreGolden(g), golden);

    const swingAvgPct = score.summary?.swingAvg == null ? " -  " : (score.summary.swingAvg * 100).toFixed(1).padStart(4);
    const twistAvgPct = score.summary?.twistAvg == null ? " -  " : (score.summary.twistAvg * 100).toFixed(1).padStart(4);
    const swingN = score.summary?.swingScored ?? 0;
    const twistN = score.summary?.twistScored ?? 0;
    const cov = score.summary?.coverage ?? { scored: 0, missing: 0, ratio: 0 };
    console.log(
      `\n=== ${pose} (${tier}): 総合 ${score.total.toFixed(1)}%  ` +
        `swing ${swingAvgPct}% (n=${swingN})  twist ${twistAvgPct}% (n=${twistN})  ` +
        `coverage ${cov.scored}/${cov.scored + cov.missing} ===`
    );
    const rows = Object.entries(score.joints).sort((a, b) => a[1].score - b[1].score);
    for (const [joint, j] of rows) {
      console.log(
        `  ${joint.padEnd(12)} 角度差 ${fmtDeg(j.angleDeg)}°  ` +
          `score ${fmtPct(j.score)}%  ` +
          `swing ${fmtDeg(j.swingDeg)}°/${fmtPct(j.swingScore)}%  ` +
          `twist ${fmtDeg(j.twistDeg)}°/${fmtPct(j.twistScore)}%  ` +
          `(w ${j.weight})`
      );
    }
    if (score.missing.length > 0) {
      console.log(`  missing: ${score.missing.join(", ")}`);
    }
    if (score.stats) {
      console.log(
        `  分位点: p10 ${(score.stats.p10 * 100).toFixed(1)}%  ` +
          `median ${(score.stats.median * 100).toFixed(1)}%  ` +
          `min ${(score.stats.min * 100).toFixed(1)}%`
      );
    }
    totals.push({ pose, tier, total: score.total });
    jsonResults.push({ pose, tier, score });
  } catch (e) {
    failed = true;
    console.error(`fail: ${pose}: ${e}`);
  }
}

const totalsAgg = aggregateTotals(totals);
const printSummarySection = (label, items, avg) => {
  console.log(`\n=== summary (${label}) ===`);
  for (const t of items) {
    console.log(`  ${t.pose.padEnd(16)} ${t.total.toFixed(1)}%`);
  }
  console.log(`  ${"average".padEnd(16)} ${avg.toFixed(1)}%`);
};
if (totalsAgg.dev.length > 0) {
  printSummarySection("dev", totalsAgg.dev, totalsAgg.averageDev);
}
if (totalsAgg.holdout.length > 0) {
  printSummarySection("holdout", totalsAgg.holdout, totalsAgg.averageHoldout);
}

if (jsonPath && jsonResults.length > 0) {
  const resultsByTier = splitByTier(jsonResults);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        average: totalsAgg.average ?? 0,
        averageDev: totalsAgg.averageDev,
        averageHoldout: totalsAgg.averageHoldout,
        resultsByTier,
        // 後方互換（schemaVersion 1）: resultsByTier.dev.concat(holdout) と同一
        results: [...resultsByTier.dev, ...resultsByTier.holdout],
      },
      null,
      2
    )
  );
  console.log(`\nJSON output: ${jsonPath}`);
}

await browser.close();
process.exit(failed ? 1 : 0);
