#!/usr/bin/env node
/**
 * ゴールデン品質の定量指標（#84）。目視でなく数値でゴールデンの破綻を検出する:
 * - 指標B-1: 関節可動域（ROM）違反の列挙（合格 = 0 件）
 * - 指標B-2: 自己めり込み（カプセル近似）の列挙（合格 = 0 件）
 * - 指標A: ゴールデンレンダーを MediaPipe に掛け直し、実写真の landmark と
 *   セグメント方向を比較（レポートのみ。実写真パスは sources.local.json）
 *
 * #104 で `--json` 出力の各 result に `tier`（"dev" | "holdout"）を追加
 * （schemaVersion 2）。個別ポーズの合否判定なので pose-score のような
 * tier 別集計は行わない。
 *
 * 前提: dev サーバ起動済み（ポートは PORT 環境変数、既定 5173）。
 * 実行: make golden-check   （POSE=<id> で単一ポーズのみ）
 * exit code: B の違反が 1 件でもあれば 1
 */
import { chromium } from "playwright";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { ALLOWED_TIERS } from "./lib/aggregate.mjs";

/** golden.tier を厳格に正規化。未指定は "dev"、既知でない値は throw。 */
const normalizeTier = (raw, pose) => {
  if (raw === undefined) return "dev";
  if (ALLOWED_TIERS.has(raw)) return raw;
  throw new Error(
    `unknown tier "${String(raw)}" in ${pose}.json: allowed values are ${[...ALLOWED_TIERS].join(", ")} or undefined`
  );
};

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");
const port = process.env.PORT ?? "5173";
const baseUrl = `http://localhost:${port}`;

const cliArgs = process.argv.slice(2);
const jsonFlagIdx = cliArgs.indexOf("--json");
const jsonPath =
  jsonFlagIdx >= 0 && cliArgs[jsonFlagIdx + 1] ? cliArgs[jsonFlagIdx + 1] : null;
const positionals = cliArgs.filter((_, i) => i !== jsonFlagIdx && i !== jsonFlagIdx + 1);

const poseArg = process.env.POSE ?? positionals[0];
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

/**
 * 指標A の合否しきい値（度・経験値）。推定器がマネキンレンダーを読む際の
 * ノイズ（体型差・簡素な質感）を考慮して写真同士より緩く設定。根拠と
 * 調整履歴は #88 参照。
 */
const A_MEAN_MAX_DEG = 20;
const A_SEG_MAX_DEG = 35;

/**
 * coverage の合格条件（#102）。従来「比較 1/9」でも合格扱いしていたパスを
 * 塞ぐ。閾値の根拠と実測ふるい分けは ADR 0008 参照。
 *   - 比較セグメント数が MIN_SEGMENTS 未満なら FAIL
 *   - 使用された系統数（体幹・左腕・右腕・左脚・右脚 の 5 系統）が
 *     MIN_SYSTEMS 未満なら FAIL
 */
const A_MIN_SEGMENTS = 4;
const A_MIN_SYSTEMS = 2;

/** 9 セグメントを 5 系統に集約する */
const SEGMENT_SYSTEM = {
  torso: "torso",
  "upperArm:L": "arm:L",
  "foreArm:L": "arm:L",
  "upperArm:R": "arm:R",
  "foreArm:R": "arm:R",
  "thigh:L": "leg:L",
  "calf:L": "leg:L",
  "thigh:R": "leg:R",
  "calf:R": "leg:R",
};

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
const jsonResults = [];
for (const pose of poses) {
  const goldenPath = join(goldenDir, `${pose}.json`);
  if (!existsSync(goldenPath)) {
    console.warn(`skip: ${pose}: golden json が無い`);
    continue;
  }
  const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
  const tier = normalizeTier(golden.tier, pose);
  console.log(`\n=== ${pose} (${tier}) ===`);
  const result = {
    pose,
    tier,
    rom: { violations: 0 },
    penetration: { violations: 0 },
    contact: { violations: 0, total: 0 },
    palm: { violations: 0, total: 0 },
    photoMatch: { status: "skip", meanDeg: null, over: 0, coverage: 0, systems: 0, coverageFail: false },
  };

  // 指標B: ゴールデン適用 → ROM + めり込み
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /3Dマネキン/ }).click();
  await page.waitForFunction(() => Boolean(window.__poseDebug), { timeout: 30_000 });
  const check = await page.evaluate((g) => window.__poseDebug.checkGolden(g), golden);

  result.rom.violations = check.rom.length;
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
  result.penetration.violations = check.penetrations.length;
  if (check.penetrations.length === 0) {
    console.log("  めり込み:   違反 0");
  } else {
    violation = true;
    console.log(`  めり込み:   違反 ${check.penetrations.length} 件`);
    for (const p of check.penetrations) {
      console.log(`    ${p.a} × ${p.b} 深さ ${(p.depthM * 100).toFixed(1)}cm`);
    }
  }

  // 接地ゲート（#90）: 指定部位の関節ボーンが床に着いているか
  const floating = (check.contacts ?? []).filter((c) => !c.grounded);
  result.contact.total = (check.contacts ?? []).length;
  result.contact.violations = floating.length;
  if ((check.contacts ?? []).length === 0) {
    console.log("  接地:       指定なし");
  } else if (floating.length === 0) {
    console.log(`  接地:       違反 0（${check.contacts.length} 部位すべて接地）`);
    if (process.env.VERBOSE)
      for (const c of check.contacts)
        console.log(`    ${c.part.padEnd(8)} ${(c.clearanceM * 100).toFixed(1)}cm`);
  } else {
    violation = true;
    console.log(`  接地:       違反 ${floating.length} 件`);
    for (const c of floating) {
      console.log(`    ${c.part.padEnd(8)} 床から ${(c.clearanceM * 100).toFixed(1)}cm 浮き`);
    }
  }

  // 手の向きゲート（#90）: 接地手の手のひらが水平か（指先立ち検出）
  const tilted = (check.palms ?? []).filter((p) => !p.flat);
  result.palm.total = (check.palms ?? []).length;
  result.palm.violations = tilted.length;
  if ((check.palms ?? []).length === 0) {
    console.log("  手の向き:   指定なし");
  } else if (tilted.length === 0) {
    console.log(`  手の向き:   違反 0（${check.palms.length} 手すべて水平）`);
  } else {
    violation = true;
    console.log(`  手の向き:   違反 ${tilted.length} 件`);
    for (const p of tilted) {
      console.log(`    ${p.side.padEnd(5)} 傾き ${p.tiltDeg.toFixed(0)}°（指先立ち疑い）`);
    }
  }

  // 指標A: レンダー再推定 vs 実写真。
  // 単一視点では自己遮蔽でセグメントが除外されやすいため（四つ這いの正面等）、
  // 複数視点のレンダーを推定し、セグメント単位でマージする（比較数が多い
  // 視点を優先し、そこで除外されたセグメントだけ他視点で補完）
  const photoPath = sources[pose];
  if (!photoPath || !existsSync(photoPath)) {
    console.log("  写真整合:   skip（実写真パス未設定）");
    jsonResults.push(result);
    continue;
  }
  const photoLm = await landmarksForImage(photoPath);
  if (!photoLm) {
    console.log(
      "  写真整合:   違反（実写真で推定器が人物検出せず、coverage 0/9 で FAIL）"
    );
    violation = true;
    result.photoMatch = {
      status: "detect_fail_photo",
      meanDeg: null,
      over: 0,
      coverage: 0,
      systems: 0,
      coverageFail: true,
      qualityFail: false,
    };
    jsonResults.push(result);
    continue;
  }

  const VIEWS = [
    { name: "front", az: 0, el: 10 },
    { name: "side", az: 90, el: 10 },
    { name: "side2", az: -90, el: 10 },
  ];
  const viewMatches = [];
  for (const view of VIEWS) {
    // 適用ポーズがフレーム内に来るよう checkGolden（カメラ再フィット込み）を
    // 再実行してから撮る。landmarksForImage が別ページへ遷移するため毎回必要
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /3Dマネキン/ }).click();
    await page.waitForFunction(() => Boolean(window.__poseDebug), { timeout: 30_000 });
    await page.evaluate((g) => window.__poseDebug.checkGolden(g), golden);
    await page.evaluate(([az, el]) => window.__poseDebug.setView(az, el), [
      view.az,
      view.el,
    ]);
    // 画像未アップロード時のプレースホルダ（半透明ベール）がキャンバスを覆い、
    // ベール越しのスクショでは推定器が人物検出できない（#88 の主因のひとつ）
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("div, p, span")) {
        if (
          el.childElementCount === 0 &&
          el.textContent?.includes("画像をアップロードすると")
        ) {
          el.style.display = "none";
          if (el.parentElement) el.parentElement.style.display = "none";
        }
      }
    });
    await page.waitForTimeout(300);
    const shotPath = join(shotDir, `${pose}-${view.name}.png`);
    await page.locator("canvas[data-engine]").screenshot({ path: shotPath });
    const renderLm = await landmarksForImage(shotPath);
    if (!renderLm) continue;
    const match = await page.evaluate(
      ([a, b]) => window.__poseDebug.compareLandmarks(a, b),
      [renderLm, photoLm]
    );
    viewMatches.push({ view: view.name, match });
  }

  if (viewMatches.length === 0) {
    console.log(
      "  写真整合:   違反（全視点でマネキンレンダーの人物検出に失敗、coverage 0/9 で FAIL）"
    );
    violation = true;
    result.photoMatch = {
      status: "detect_fail_render",
      meanDeg: null,
      over: 0,
      coverage: 0,
      systems: 0,
      coverageFail: true,
      qualityFail: false,
    };
    jsonResults.push(result);
    continue;
  }

  // マージ: 比較セグメント数の多い視点を優先し、足りない分を他視点で補完
  viewMatches.sort((a, b) => b.match.segments.length - a.match.segments.length);
  const merged = new Map();
  const segSource = new Map();
  for (const { view, match } of viewMatches) {
    for (const s of match.segments) {
      if (!merged.has(s.segment)) {
        merged.set(s.segment, s);
        segSource.set(s.segment, view);
      }
    }
  }
  const segs = Array.from(merged.values());
  const meanDeg = segs.reduce((s, m) => s + m.angleDeg, 0) / segs.length;
  const over = segs.filter((s) => s.angleDeg > A_SEG_MAX_DEG);
  // coverage ゲート（#102）: 比較 X/9 と系統数の下限を強制。
  // 従来「比較 1/9」でも「合格」表示されていたパスをここで塞ぐ
  const systems = new Set(segs.map((s) => SEGMENT_SYSTEM[s.segment] ?? "other"));
  const coverageFail =
    segs.length < A_MIN_SEGMENTS || systems.size < A_MIN_SYSTEMS;
  const qualityFail = meanDeg > A_MEAN_MAX_DEG || over.length > 0;
  const aFail = coverageFail || qualityFail;
  if (aFail) violation = true;
  const reason = coverageFail
    ? qualityFail
      ? "coverage+品質"
      : "coverage"
    : qualityFail
    ? "品質"
    : "";
  console.log(
    `  写真整合:   平均角度差 ${meanDeg.toFixed(1)}°（合格: 平均≦${A_MEAN_MAX_DEG}° かつ 各≦${A_SEG_MAX_DEG}°、比較≧${A_MIN_SEGMENTS}/9 かつ 系統≧${A_MIN_SYSTEMS}/5） -> ${aFail ? `違反(${reason})` : "合格"}（比較 ${segs.length}/9、系統 ${systems.size}/5）`
  );
  for (const s of segs.sort((x, y) => y.angleDeg - x.angleDeg)) {
    const dir = process.env.VERBOSE
      ? `  render[${s.dirA.map((v) => v.toFixed(2)).join(",")}] photo[${s.dirB.map((v) => v.toFixed(2)).join(",")}]`
      : "";
    console.log(
      `    ${s.segment.padEnd(11)} ${s.angleDeg.toFixed(1).padStart(6)}° (${segSource.get(s.segment)})${dir}`
    );
  }
  result.photoMatch = {
    status: aFail ? "fail" : "pass",
    meanDeg,
    over: over.length,
    coverage: segs.length,
    systems: systems.size,
    coverageFail,
    qualityFail,
  };
  jsonResults.push(result);
}

if (jsonPath && jsonResults.length > 0) {
  writeFileSync(
    jsonPath,
    // schemaVersion 2（#104）: 各 result に tier を追加。集計は加えない
    // （golden-check は個別合否判定のため pose-score のような tier 別集計は不要）
    JSON.stringify(
      { schemaVersion: 2, results: jsonResults, exitCode: violation ? 1 : 0 },
      null,
      2
    )
  );
  console.log(`\nJSON output: ${jsonPath}`);
}

await browser.close();
process.exit(violation ? 1 : 0);
