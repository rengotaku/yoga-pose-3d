#!/usr/bin/env node
/**
 * ゴールデンポーズ（手付けボーン回転 JSON）をマネキンへ直接適用し、
 * 正面・側面のレンダーを e2e/golden/renders/ に保存する（#72）。
 * ハンドオーサリング（#73）の「JSON 編集 → レンダー → 写真と比較」ループに使う。
 *
 * 前提: dev サーバ起動済み（ポートは PORT 環境変数、既定 5173）。
 * 実行: make golden-render POSE=<pose-id>   （POSE 省略時は e2e/golden/*.json 全件）
 */
import { chromium } from "playwright";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");
const rendersDir = join(goldenDir, "renders");
const port = process.env.PORT ?? "5173";
const baseUrl = `http://localhost:${port}`;

const poseArg = process.env.POSE ?? process.argv[2];
const poses = poseArg
  ? [poseArg]
  : readdirSync(goldenDir)
      .filter((f) => f.endsWith(".json") && !f.includes(".local."))
      .map((f) => basename(f, ".json"));

if (poses.length === 0) {
  console.error(`no golden pose json found in ${goldenDir}`);
  process.exit(1);
}

const res = await fetch(baseUrl).catch(() => null);
if (!res || !res.ok) {
  console.error(`dev server not reachable at ${baseUrl} — run \`make run\` first`);
  process.exit(1);
}

mkdirSync(rendersDir, { recursive: true });

// 正面(front)・側面(side)の2アングル。仰角は床の見える程度に浅く付ける
const VIEWS = [
  { name: "front", azimuthDeg: 0, elevationDeg: 15 },
  { name: "side", azimuthDeg: 90, elevationDeg: 15 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

let failed = false;
for (const pose of poses) {
  try {
    const golden = JSON.parse(readFileSync(join(goldenDir, `${pose}.json`), "utf8"));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    // 3D ブロックは初期折りたたみ（#60）で PoseViewer3D がアンマウントのため、
    // トグルを開いてからマネキンロード（= __poseDebug 設置）を待つ
    await page.getByRole("button", { name: /3Dマネキン/ }).click();
    await page.waitForFunction(() => Boolean(window.__poseDebug), {
      timeout: 30_000,
    });
    const { unresolved } = await page.evaluate((g) => {
      return window.__poseDebug.applyGolden(g);
    }, golden);
    if (unresolved.length > 0) {
      console.warn(`warn: ${pose}: unresolved bones: ${unresolved.join(", ")}`);
    }
    // 画像未アップロード時のプレースホルダ文言がマネキンに被るので隠す
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("div, p, span")) {
        if (
          el.childElementCount === 0 &&
          el.textContent?.includes("画像をアップロードすると")
        ) {
          el.style.display = "none";
        }
      }
    });
    for (const view of VIEWS) {
      await page.evaluate(
        ({ azimuthDeg, elevationDeg }) =>
          window.__poseDebug.setView(azimuthDeg, elevationDeg),
        view
      );
      await page.waitForTimeout(300);
      const canvas = page.locator("canvas[data-engine]");
      const path = join(rendersDir, `${pose}-${view.name}.png`);
      await canvas.screenshot({ path });
      console.log(`ok: ${pose} (${view.name}) -> e2e/golden/renders/${pose}-${view.name}.png`);
    }
  } catch (e) {
    failed = true;
    console.error(`fail: ${pose}: ${e}`);
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
