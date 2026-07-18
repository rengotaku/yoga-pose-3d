#!/usr/bin/env node
/**
 * 代表ポーズ画像セットの回帰スクショ取得スクリプト。
 *
 * e2e/poses/ の各画像をアプリにアップロードし、3D マネキンの canvas を
 * e2e/output/<pose>.png に保存する。判定（ポーズ再現・破綻の有無）は目視で行う。
 *
 * 前提: dev サーバが起動済みであること（make run）。ポートは PORT 環境変数（既定 5173）。
 * 実行: make verify-poses
 */
import { chromium } from "playwright";
import { readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename, extname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const posesDir = join(here, "poses");
const outputDir = join(here, "output");
const port = process.env.PORT ?? "5173";
const baseUrl = `http://localhost:${port}`;

const images = readdirSync(posesDir).filter((f) => /\.(jpe?g|png)$/i.test(f));
if (images.length === 0) {
  console.error(`no pose images found in ${posesDir}`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });

const res = await fetch(baseUrl).catch(() => null);
if (!res || !res.ok) {
  console.error(`dev server not reachable at ${baseUrl} — run \`make run\` first`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

let failed = false;
for (const image of images) {
  const name = basename(image, extname(image));
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByText("クリックまたはドラッグ＆ドロップ").click();
    const chooser = await chooserPromise;
    await chooser.setFiles(join(posesDir, image));
    // 推論 + リターゲット + 描画の完了を待つ（凡例の出現 + 安定待ち）
    await page.getByText("使用筋（推定）").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const canvas = page.locator("canvas[data-engine]");
    await canvas.screenshot({ path: join(outputDir, `${name}.png`) });
    console.log(`ok: ${name} -> e2e/output/${name}.png`);
  } catch (e) {
    failed = true;
    console.error(`fail: ${name}: ${e.message.split("\n")[0]}`);
  }
}

await browser.close();

if (errors.length > 0) {
  console.error(`console errors (${errors.length}):`);
  for (const e of errors.slice(0, 10)) console.error(`  ${e}`);
  failed = true;
}

process.exit(failed ? 1 : 0);
