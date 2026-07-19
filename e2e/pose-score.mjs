#!/usr/bin/env node
/**
 * ゴールデン指標スコアラー（#72）。実写真をパイプラインに通した最終ボーン回転と
 * ゴールデン（手付け正解）の world 回転の角度差から、関節別 + 総合スコア
 * （0〜100%）を算出して表示する。
 *
 * 実写真は著作権配慮でリポジトリにコミットしないため、ローカルパスを
 * e2e/golden/sources.local.json（gitignore 済み）で指定する:
 *   { "tabletop": "/abs/path/to/photo.png", ... }
 *
 * 前提: dev サーバ起動済み（ポートは PORT 環境変数、既定 5173）。
 * 実行: make pose-score   （POSE=<id> で単一ポーズのみ）
 */
import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");
const sourcesPath = join(goldenDir, "sources.local.json");
const port = process.env.PORT ?? "5173";
const baseUrl = `http://localhost:${port}`;

if (!existsSync(sourcesPath)) {
  console.error(
    `sources.local.json not found: ${sourcesPath}\n` +
      "e2e/golden/sources.local.json.example をコピーして実写真のローカルパスを設定してください"
  );
  process.exit(1);
}
const sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
const poseFilter = process.env.POSE ?? process.argv[2];
const entries = Object.entries(sources).filter(
  ([pose]) => !poseFilter || pose === poseFilter
);
if (entries.length === 0) {
  console.error(`no pose entries in ${sourcesPath}` + (poseFilter ? ` (POSE=${poseFilter})` : ""));
  process.exit(1);
}

const res = await fetch(baseUrl).catch(() => null);
if (!res || !res.ok) {
  console.error(`dev server not reachable at ${baseUrl} — run \`make run\` first`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

let failed = false;
const totals = [];
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
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByText("クリックまたはドラッグ＆ドロップ").click();
    const chooser = await chooserPromise;
    await chooser.setFiles(photoPath);
    // 推論 + リターゲット + 描画の完了を待つ（凡例の出現 + 安定待ち）
    await page.getByText("使用筋（推定）").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const score = await page.evaluate((g) => window.__poseDebug.scoreGolden(g), golden);

    console.log(`\n=== ${pose}: 総合 ${score.total.toFixed(1)}% ===`);
    const rows = Object.entries(score.joints).sort(
      (a, b) => a[1].score - b[1].score
    );
    for (const [joint, j] of rows) {
      console.log(
        `  ${joint.padEnd(12)} 角度差 ${j.angleDeg.toFixed(1).padStart(6)}°  ` +
          `score ${(j.score * 100).toFixed(0).padStart(3)}%  (weight ${j.weight})`
      );
    }
    if (score.missing.length > 0) {
      console.log(`  missing: ${score.missing.join(", ")}`);
    }
    totals.push({ pose, total: score.total });
  } catch (e) {
    failed = true;
    console.error(`fail: ${pose}: ${e}`);
  }
}

if (totals.length > 0) {
  console.log("\n=== summary ===");
  for (const t of totals) {
    console.log(`  ${t.pose.padEnd(16)} ${t.total.toFixed(1)}%`);
  }
  const avg = totals.reduce((s, t) => s + t.total, 0) / totals.length;
  console.log(`  ${"average".padEnd(16)} ${avg.toFixed(1)}%`);
}

await browser.close();
process.exit(failed ? 1 : 0);
