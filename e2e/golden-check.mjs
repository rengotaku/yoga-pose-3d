#!/usr/bin/env node
/**
 * ゴールデン品質の定量指標（#84）。目視でなく数値でゴールデンの破綻を検出する:
 * - 指標B-1: 関節可動域（ROM）違反の列挙（合格 = 0 件）
 * - 指標B-2: 自己めり込み（カプセル近似）の列挙（合格 = 0 件）
 * - 指標A: ゴールデンレンダーを MediaPipe に掛け直し、実写真の landmark と
 *   セグメント方向を比較（レポートのみ。実写真パスは sources.local.json）
 *
 * 前提: dev サーバ起動済み（ポートは PORT 環境変数、既定 5173）。
 * 実行: make golden-check   （POSE=<id> で単一ポーズのみ）
 * exit code: B の違反が 1 件でもあれば 1
 */
import { chromium } from "playwright";
import { readdirSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");
const port = process.env.PORT ?? "5173";
const baseUrl = `http://localhost:${port}`;

const poseArg = process.env.POSE ?? process.argv[2];
const poses = poseArg
  ? [poseArg]
  : readdirSync(goldenDir)
      // "_" 始まりはサンプル（goldenPoses.ts の除外規則と同じ）
      .filter((f) => f.endsWith(".json") && !f.includes(".local.") && !f.startsWith("_"))
      .map((f) => basename(f, ".json"));

const sourcesPath = join(goldenDir, "sources.local.json");
const sources = existsSync(sourcesPath)
  ? JSON.parse(readFileSync(sourcesPath, "utf8"))
  : {};

const res = await fetch(baseUrl).catch(() => null);
if (!res || !res.ok) {
  console.error(`dev server not reachable at ${baseUrl} — run \`make run\` first`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const shotDir = mkdtempSync(join(tmpdir(), "golden-check-"));

/** 画像をアップロードして駆動 landmark 配列を取得する。検出不能なら null */
const landmarksForImage = async (imagePath) => {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByText("クリックまたはドラッグ＆ドロップ").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(imagePath);
  try {
    await page.getByText("使用筋（推定）").waitFor({ timeout: 30_000 });
  } catch {
    return null;
  }
  await page.waitForTimeout(1_000);
  return page.evaluate(() => window.__poseDebug.landmarks ?? null);
};

let violation = false;
for (const pose of poses) {
  const goldenPath = join(goldenDir, `${pose}.json`);
  if (!existsSync(goldenPath)) {
    console.warn(`skip: ${pose}: golden json が無い`);
    continue;
  }
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  console.log(`\n=== ${pose} ===`);

  // 指標B: ゴールデン適用 → ROM + めり込み
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /3Dマネキン/ }).click();
  await page.waitForFunction(() => Boolean(window.__poseDebug), { timeout: 30_000 });
  const check = await page.evaluate((g) => window.__poseDebug.checkGolden(g), golden);

  if (check.rom.length === 0) {
    console.log("  ROM:        違反 0");
  } else {
    violation = true;
    console.log(`  ROM:        違反 ${check.rom.length} 件`);
    for (const v of check.rom) {
      console.log(
        `    ${v.bone}.${v.axis} = ${v.valueDeg}° (可動域 ${v.minDeg}..${v.maxDeg}°, 超過 ${v.excessDeg.toFixed(0)}°)`
      );
    }
  }
  if (check.penetrations.length === 0) {
    console.log("  めり込み:   違反 0");
  } else {
    violation = true;
    console.log(`  めり込み:   違反 ${check.penetrations.length} 件`);
    for (const p of check.penetrations) {
      console.log(`    ${p.a} × ${p.b} 深さ ${(p.depthM * 100).toFixed(1)}cm`);
    }
  }

  // 指標A: レンダー再推定 vs 実写真（レポートのみ）
  const photoPath = sources[pose];
  if (!photoPath || !existsSync(photoPath)) {
    console.log("  写真整合:   skip（実写真パス未設定）");
    continue;
  }
  const shotPath = join(shotDir, `${pose}.png`);
  await page.evaluate(() => window.__poseDebug.setView(0, 10));
  await page.waitForTimeout(300);
  await page.locator("canvas[data-engine]").screenshot({ path: shotPath });

  const renderLm = await landmarksForImage(shotPath);
  if (!renderLm) {
    console.log("  写真整合:   検出不能（マネキンレンダーで推定器が人物検出せず）");
    continue;
  }
  const photoLm = await landmarksForImage(photoPath);
  if (!photoLm) {
    console.log("  写真整合:   検出不能（実写真で推定器が人物検出せず）");
    continue;
  }
  const match = await page.evaluate(
    ([a, b]) => window.__poseDebug.compareLandmarks(a, b),
    [renderLm, photoLm]
  );
  const mean = match.meanDeg === null ? "n/a" : `${match.meanDeg.toFixed(1)}°`;
  console.log(`  写真整合:   平均角度差 ${mean}（比較 ${match.segments.length} / 除外 ${match.skipped.length}: ${match.skipped.join(",") || "なし"}）`);
  for (const s of match.segments.sort((x, y) => y.angleDeg - x.angleDeg)) {
    console.log(`    ${s.segment.padEnd(11)} ${s.angleDeg.toFixed(1)}°`);
  }
}

await browser.close();
process.exit(violation ? 1 : 0);
