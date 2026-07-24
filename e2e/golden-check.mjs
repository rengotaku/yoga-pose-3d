#!/usr/bin/env node
/**
 * ゴールデン品質の定量指標（#84）。目視でなく数値でゴールデンの破綻を検出する:
 * - 指標B-1: 関節可動域（ROM）違反の列挙（合格 = 0 件）
 * - 指標B-2: 自己めり込み（カプセル近似）の列挙（合格 = 0 件）
 * - 指標A: ゴールデンレンダーを MediaPipe に掛け直し、実写真の landmark と
 *   セグメント方向を比較（レポートのみ。実写真パスは sources.json / sources.local.json、ADR 0010）
 *
 * #104 で `--json` 出力の各 result に `tier`（"dev" | "holdout"）を追加
 * （schemaVersion 2）。個別ポーズの合否判定なので pose-score のような
 * tier 別集計は行わない。
 *
 * #114 で per-pose waiver 機構を追加:
 * - validateWaivers: 未知ゲート名・理由抜けで throw
 * - applyWaivers: check 結果から免除項目を除外し、waivedCounts / unusedWaivers を算出
 *
 * 前提: dev サーバ起動済み（ポートは PORT 環境変数、既定 5173）。
 * 実行: make golden-check   （POSE=<id> で単一ポーズのみ）
 * exit code: B の違反が 1 件でもあれば 1
 */
import { chromium } from "playwright";
import { readdirSync, readFileSync, existsSync, mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { ALLOWED_TIERS } from "./lib/aggregate.mjs";
import { listPoseIds } from "./lib/goldenPoses.mjs";

export const VALID_GATES = ["rom", "penetration", "contact", "palm", "photoAlignment", "stability"];

/**
 * waivers スキーマを検証。未知ゲート名・理由抜けで Error を throw する。
 */
export function validateWaivers(waivers) {
  if (waivers === undefined || waivers === null) {
    return;
  }
  if (typeof waivers !== "object" || Array.isArray(waivers)) {
    throw new Error("waivers must be an object");
  }
  for (const [gate, value] of Object.entries(waivers)) {
    if (!VALID_GATES.includes(gate)) {
      throw new Error(
        `unknown gate "${gate}". Valid gates are: ${VALID_GATES.join(", ")}`
      );
    }
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (!item || typeof item !== "object") {
        throw new Error(`invalid waiver item for ${gate}`);
      }
      if (!item.reason || typeof item.reason !== "string" || item.reason.trim() === "") {
        throw new Error(`reason is required for ${gate} waiver`);
      }
    }
  }
}

/**
 * check 結果に waivers を適用するヘルパー。
 */
export function applyWaivers(check, waivers) {
  validateWaivers(waivers);

  const waivedCounts = {
    rom: 0,
    penetration: 0,
    contact: 0,
    palm: 0,
    photoAlignment: 0,
    stability: 0,
    total: 0,
  };
  const unusedWaivers = [];
  const reportLines = [];

  const getWaiversList = (gate) => {
    if (!waivers || !waivers[gate]) return [];
    const val = waivers[gate];
    return (Array.isArray(val) ? val : [val]).map((item) => ({ ...item, used: false }));
  };

  const romWaivers = getWaiversList("rom");
  const penWaivers = getWaiversList("penetration");
  const contactWaivers = getWaiversList("contact");
  const palmWaivers = getWaiversList("palm");
  const photoWaivers = getWaiversList("photoAlignment");
  const stabilityWaivers = getWaiversList("stability");

  // 1. ROM
  const remainingRom = [];
  for (const v of check.rom ?? []) {
    const matched = romWaivers.find((w) => w.bone === v.bone || w.bone === `${v.bone}.${v.axis}`);
    if (matched) {
      matched.used = true;
      waivedCounts.rom++;
      waivedCounts.total++;
      reportLines.push(
        `  WAIVED ${waivedCounts.rom}: ${v.bone}.${v.axis} = ${v.valueDeg}° (${matched.reason})`
      );
    } else {
      remainingRom.push(v);
    }
  }

  // 2. Penetration（#128）: fail severity のみを違反対象とし、waiver も fail
  // に対してのみ適用する。warn severity は pass 判定に影響しない情報表示
  // として素通しする（sub A で EXCLUDED_PAIRS を隣接のみに縮小した結果、
  // 新たに検出対象になった「触れ合いは正当だが深く食い込むと NG」なペアを
  // warn 帯として吸収するための区分）。
  const failPenetrations = (check.penetrations ?? []).filter((p) => p.severity === "fail");
  const warnPenetrations = (check.penetrations ?? []).filter((p) => p.severity === "warn");
  const remainingPenetrations = [];
  for (const p of failPenetrations) {
    const pairName = `${p.a} × ${p.b}`;
    const pairNameAlt = `${p.b} × ${p.a}`;
    const matched = penWaivers.find((w) => {
      if (!w.pair) return false;
      const normW = w.pair.replace(/\s+/g, " ").trim().toLowerCase();
      const norm1 = pairName.replace(/\s+/g, " ").trim().toLowerCase();
      const norm2 = pairNameAlt.replace(/\s+/g, " ").trim().toLowerCase();
      return normW === norm1 || normW === norm2;
    });
    if (matched) {
      matched.used = true;
      waivedCounts.penetration++;
      waivedCounts.total++;
      reportLines.push(
        `  WAIVED ${waivedCounts.penetration}: ${p.a} × ${p.b} = ${(p.depthM * 100).toFixed(1)}cm (${matched.reason})`
      );
    } else {
      remainingPenetrations.push(p);
    }
  }

  // 3. Contact
  const remainingContacts = [];
  const checkContacts = check.contacts ?? [];
  for (const c of checkContacts) {
    if (!c.grounded) {
      const matched = contactWaivers.find((w) => w.part === c.part);
      if (matched) {
        matched.used = true;
        waivedCounts.contact++;
        waivedCounts.total++;
        reportLines.push(
          `  WAIVED ${waivedCounts.contact}: ${c.part} = 床から ${(c.clearanceM * 100).toFixed(1)}cm 浮き (${matched.reason})`
        );
      } else {
        remainingContacts.push(c);
      }
    }
  }

  // 4. Palm
  const remainingPalms = [];
  for (const p of check.palms ?? []) {
    if (!p.flat) {
      const matched = palmWaivers.find((w) => w.side === p.side);
      if (matched) {
        matched.used = true;
        waivedCounts.palm++;
        waivedCounts.total++;
        reportLines.push(
          `  WAIVED ${waivedCounts.palm}: ${p.side} = 傾き ${p.tiltDeg.toFixed(0)}° (${matched.reason})`
        );
      } else {
        remainingPalms.push(p);
      }
    }
  }

  // 5. Photo Alignment
  let photoAlignmentWaived = false;
  let photoAlignmentReason = null;
  const photoStatus = check.photoAlignment?.status ?? check.photoMatch?.status;
  const photoFail =
    photoStatus === "fail" ||
    photoStatus === "detect_fail_photo" ||
    photoStatus === "detect_fail_render" ||
    check.photoAlignment?.qualityFail ||
    check.photoAlignment?.coverageFail ||
    check.photoMatch?.qualityFail ||
    check.photoMatch?.coverageFail;

  if (photoFail) {
    const matched = photoWaivers.find((w) => !w.used);
    if (matched) {
      matched.used = true;
      photoAlignmentWaived = true;
      photoAlignmentReason = matched.reason;
      waivedCounts.photoAlignment++;
      waivedCounts.total++;
      reportLines.push(`  WAIVED（${matched.reason}）`);
    }
  }

  // 6. Stability（#118）。checkStability は per-part 配列でなく単一の判定
  // 結果を返すため、他ゲートと違い「配列を残す/消す」ではなく「pass の
  // 上書き」で waive を表現する（意味は他ゲートと同じ: waive されれば
  // 違反として数えない）。
  let stabilityWaived = false;
  let stabilityReason = null;
  const stabilityFail = Boolean(check.stability) && !check.stability.pass;
  if (stabilityFail) {
    const matched = stabilityWaivers.find((w) => !w.used);
    if (matched) {
      matched.used = true;
      stabilityWaived = true;
      stabilityReason = matched.reason;
      waivedCounts.stability++;
      waivedCounts.total++;
      reportLines.push(`  WAIVED（${matched.reason}）`);
    }
  }

  // Record unused waivers
  for (const [gate, wList] of [
    ["rom", romWaivers],
    ["penetration", penWaivers],
    ["contact", contactWaivers],
    ["palm", palmWaivers],
    ["photoAlignment", photoWaivers],
    ["stability", stabilityWaivers],
  ]) {
    for (const w of wList) {
      if (!w.used) {
        const identifier = w.pair || w.part || w.bone || w.side || "";
        const label = identifier ? `${gate} - ${identifier}` : gate;
        unusedWaivers.push({ gate, waiver: w, label });
        reportLines.push(`  WAIVER 未使用: ${label} warning`);
      }
    }
  }

  const violation =
    remainingRom.length > 0 ||
    remainingPenetrations.length > 0 ||
    remainingContacts.length > 0 ||
    remainingPalms.length > 0 ||
    (Boolean(photoFail) && !photoAlignmentWaived) ||
    (stabilityFail && !stabilityWaived);

  return {
    rom: remainingRom,
    penetrations: remainingPenetrations,
    warnPenetrations,
    contacts: remainingContacts,
    palms: remainingPalms,
    photoAlignment: {
      ...(check.photoAlignment ?? check.photoMatch),
      waived: photoAlignmentWaived,
      reason: photoAlignmentReason,
    },
    stability: check.stability
      ? {
          ...check.stability,
          pass: check.stability.pass || stabilityWaived,
          waived: stabilityWaived,
          reason: stabilityReason,
        }
      : null,
    waivedCounts,
    unusedWaivers,
    violation,
    reportLines,
  };
}

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

/**
 * sources.json（committed）と sources.local.json（gitignore・ローカル上書き）を
 * マージして pose → 絶対パスの map を返す（ADR 0010）。相対パスは goldenDir 基準。
 */
const loadSources = () => {
  const merged = {};
  for (const name of ["sources.json", "sources.local.json"]) {
    const p = join(goldenDir, name);
    if (!existsSync(p)) continue;
    const raw = JSON.parse(readFileSync(p, "utf8"));
    for (const [pose, photo] of Object.entries(raw)) {
      if (typeof photo !== "string") continue;
      const absPath = isAbsolute(photo) ? photo : join(goldenDir, photo);
      if (existsSync(absPath)) {
        merged[pose] = absPath;
      }
    }
  }
  return merged;
};

/**
 * 指標A の合否しきい値（度・経験値）。
 */
const A_MEAN_MAX_DEG = 20;
const A_SEG_MAX_DEG = 35;
const A_MIN_SEGMENTS = 4;
const A_MIN_SYSTEMS = 2;

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

async function runCli() {
  const port = process.env.PORT ?? "5173";
  const baseUrl = `http://localhost:${port}`;

  const cliArgs = process.argv.slice(2);
  const jsonFlagIdx = cliArgs.indexOf("--json");
  const jsonPath =
    jsonFlagIdx >= 0 && cliArgs[jsonFlagIdx + 1] ? cliArgs[jsonFlagIdx + 1] : null;
  const positionals = cliArgs.filter((_, i) => i !== jsonFlagIdx && i !== jsonFlagIdx + 1);

  const poseArg = process.env.POSE ?? positionals[0];
  const poses = poseArg ? [poseArg] : listPoseIds(readdirSync(goldenDir));

  const sources = loadSources();

  const res = await fetch(baseUrl).catch(() => null);
  if (!res || !res.ok) {
    console.error(`dev server not reachable at ${baseUrl} — run \`make run\` first`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const shotDir = mkdtempSync(join(tmpdir(), "golden-check-"));

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

  let globalViolation = false;
  const jsonResults = [];
  for (const pose of poses) {
    const goldenPath = join(goldenDir, `${pose}.json`);
    if (!existsSync(goldenPath)) {
      console.warn(`skip: ${pose}: golden json が無い`);
      continue;
    }
    const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
    validateWaivers(golden.waivers);

    const tier = normalizeTier(golden.tier, pose);
    console.log(`\n=== ${pose} (${tier}) ===`);

    // 指標B: ゴールデン適用 → ROM + めり込み + 接地 + 手の向き
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /3Dマネキン/ }).click();
    await page.waitForFunction(() => Boolean(window.__poseDebug), { timeout: 30_000 });
    const check = await page.evaluate((g) => window.__poseDebug.checkGolden(g), golden);

    // 指標A: レンダー再推定 vs 実写真
    let photoMatchResult = {
      status: "skip",
      meanDeg: null,
      over: 0,
      coverage: 0,
      systems: 0,
      coverageFail: false,
      qualityFail: false,
    };

    const photoPath = sources[pose];
    let photoLm = null;
    if (photoPath && existsSync(photoPath)) {
      photoLm = await landmarksForImage(photoPath);
      if (!photoLm) {
        photoMatchResult = {
          status: "detect_fail_photo",
          meanDeg: null,
          over: 0,
          coverage: 0,
          systems: 0,
          coverageFail: true,
          qualityFail: false,
        };
      } else {
        const VIEWS = [
          { name: "front", az: 0, el: 10 },
          { name: "side", az: 90, el: 10 },
          { name: "side2", az: -90, el: 10 },
        ];
        const viewMatches = [];
        for (const view of VIEWS) {
          await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
          await page.getByRole("button", { name: /3Dマネキン/ }).click();
          await page.waitForFunction(() => Boolean(window.__poseDebug), { timeout: 30_000 });
          await page.evaluate((g) => window.__poseDebug.checkGolden(g), golden);
          await page.evaluate(([az, el]) => window.__poseDebug.setView(az, el), [
            view.az,
            view.el,
          ]);
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
          photoMatchResult = {
            status: "detect_fail_render",
            meanDeg: null,
            over: 0,
            coverage: 0,
            systems: 0,
            coverageFail: true,
            qualityFail: false,
          };
        } else {
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
          const systems = new Set(segs.map((s) => SEGMENT_SYSTEM[s.segment] ?? "other"));
          const coverageFail = segs.length < A_MIN_SEGMENTS || systems.size < A_MIN_SYSTEMS;
          const qualityFail = meanDeg > A_MEAN_MAX_DEG || over.length > 0;
          const aFail = coverageFail || qualityFail;
          photoMatchResult = {
            status: aFail ? "fail" : "pass",
            meanDeg,
            over: over.length,
            coverage: segs.length,
            systems: systems.size,
            coverageFail,
            qualityFail,
            segs,
            segSource,
          };
        }
      }
    }

    // waiver を適用
    const rawCheck = {
      rom: check.rom ?? [],
      penetrations: check.penetrations ?? [],
      contacts: check.contacts ?? [],
      palms: check.palms ?? [],
      photoAlignment: photoMatchResult,
      photoMatch: photoMatchResult,
      stability: check.stability ?? null,
    };
    const waivedRes = applyWaivers(rawCheck, golden.waivers);
    if (waivedRes.violation) globalViolation = true;

    // --- レポート出力 ---

    // 1. ROM
    if (check.rom.length === 0) {
      console.log("  ROM:        違反 0");
    } else if (waivedRes.rom.length === 0 && waivedRes.waivedCounts.rom > 0) {
      console.log(`  ROM:        違反 0（WAIVED ${waivedRes.waivedCounts.rom} 件）`);
    } else {
      console.log(
        `  ROM:        違反 ${waivedRes.rom.length} 件${
          waivedRes.waivedCounts.rom > 0 ? `（WAIVED ${waivedRes.waivedCounts.rom} 件）` : ""
        }`
      );
      for (const v of waivedRes.rom) {
        console.log(
          `    ${v.bone}.${v.axis} = ${v.valueDeg}° (可動域 ${v.minDeg}..${v.maxDeg}°, 超過 ${v.excessDeg.toFixed(0)}°)`
        );
      }
    }

    // 2. めり込み（#128: fail が違反、warn は情報表示のみで pass に影響しない）
    const totalFailPenetrations = (check.penetrations ?? []).filter(
      (p) => p.severity === "fail"
    ).length;
    if (totalFailPenetrations === 0) {
      if (waivedRes.waivedCounts.penetration > 0) {
        const details = waivedRes.reportLines.filter((l) => l.includes("WAIVED") && l.includes("×")).join(", ").trim();
        console.log(`  めり込み:   違反 0（${details || `WAIVED ${waivedRes.waivedCounts.penetration} 件`}）`);
      } else {
        console.log("  めり込み:   違反 0");
      }
    } else {
      console.log(
        `  めり込み:   違反 ${waivedRes.penetrations.length} 件${
          waivedRes.waivedCounts.penetration > 0 ? `（WAIVED ${waivedRes.waivedCounts.penetration} 件）` : ""
        }`
      );
      for (const p of waivedRes.penetrations) {
        console.log(`    ${p.a} × ${p.b} 深さ ${(p.depthM * 100).toFixed(1)}cm`);
      }
    }
    if (waivedRes.warnPenetrations.length > 0) {
      console.log(
        `  めり込み(WARN): ${waivedRes.warnPenetrations.length} 件（pass 判定に影響しない）`
      );
      for (const p of waivedRes.warnPenetrations) {
        console.log(`    ${p.a} × ${p.b} 深さ ${(p.depthM * 100).toFixed(1)}cm`);
      }
    }

    // 3. 接地
    const totalContacts = (check.contacts ?? []).length;
    if (totalContacts === 0) {
      console.log("  接地:       指定なし");
    } else if (waivedRes.contacts.length === 0 && waivedRes.waivedCounts.contact === 0) {
      console.log(`  接地:       違反 0（${totalContacts} 部位すべて接地）`);
    } else if (waivedRes.contacts.length === 0 && waivedRes.waivedCounts.contact > 0) {
      const details = waivedRes.reportLines.filter((l) => l.includes("WAIVED") && l.includes("床から")).join(", ").trim();
      console.log(`  接地:       違反 0（${details || `WAIVED ${waivedRes.waivedCounts.contact} 件`}）`);
    } else {
      console.log(
        `  接地:       違反 ${waivedRes.contacts.length} 件${
          waivedRes.waivedCounts.contact > 0 ? `（WAIVED ${waivedRes.waivedCounts.contact} 件）` : ""
        }`
      );
      for (const c of waivedRes.contacts) {
        console.log(`    ${c.part.padEnd(8)} 床から ${(c.clearanceM * 100).toFixed(1)}cm 浮き`);
      }
    }

    // 4. 手の向き
    const totalPalms = (check.palms ?? []).length;
    if (totalPalms === 0) {
      console.log("  手の向き:   指定なし");
    } else if (waivedRes.palms.length === 0 && waivedRes.waivedCounts.palm === 0) {
      console.log(`  手の向き:   違反 0（${totalPalms} 手すべて水平）`);
    } else if (waivedRes.palms.length === 0 && waivedRes.waivedCounts.palm > 0) {
      console.log(`  手の向き:   違反 0（WAIVED ${waivedRes.waivedCounts.palm} 件）`);
    } else {
      console.log(
        `  手の向き:   違反 ${waivedRes.palms.length} 件${
          waivedRes.waivedCounts.palm > 0 ? `（WAIVED ${waivedRes.waivedCounts.palm} 件）` : ""
        }`
      );
      for (const p of waivedRes.palms) {
        console.log(`    ${p.side.padEnd(5)} 傾き ${p.tiltDeg.toFixed(0)}°（指先立ち疑い）`);
      }
    }

    // 5. 写真整合
    if (!photoPath || !existsSync(photoPath)) {
      console.log("  写真整合:   skip（実写真パス未設定）");
    } else if (photoMatchResult.status === "detect_fail_photo") {
      if (waivedRes.photoAlignment.waived) {
        const reasonStr = waivedRes.photoAlignment.reason ?? "構造的限界";
        console.log(`  写真整合:   違反（実写真で推定器が人物検出せず） -> WAIVED（${reasonStr}）`);
      } else {
        console.log("  写真整合:   違反（実写真で推定器が人物検出せず、coverage 0/9 で FAIL）");
      }
    } else if (photoMatchResult.status === "detect_fail_render") {
      if (waivedRes.photoAlignment.waived) {
        const reasonStr = waivedRes.photoAlignment.reason ?? "構造的限界";
        console.log(`  写真整合:   違反（全視点でマネキンレンダー人物検出失敗） -> WAIVED（${reasonStr}）`);
      } else {
        console.log("  写真整合:   違反（全視点でマネキンレンダーの人物検出に失敗、coverage 0/9 で FAIL）");
      }
    } else if (photoMatchResult.meanDeg !== null) {
      const aFail = photoMatchResult.coverageFail || photoMatchResult.qualityFail;
      const failReason = photoMatchResult.coverageFail
        ? photoMatchResult.qualityFail
          ? "coverage+品質"
          : "coverage"
        : photoMatchResult.qualityFail
        ? "品質"
        : "";

      if (aFail && waivedRes.photoAlignment.waived) {
        const reasonStr = waivedRes.photoAlignment.reason ?? failReason;
        console.log(
          `  写真整合:   平均角度差 ${photoMatchResult.meanDeg.toFixed(1)}° -> WAIVED（${reasonStr}）`
        );
      } else if (aFail) {
        console.log(
          `  写真整合:   平均角度差 ${photoMatchResult.meanDeg.toFixed(1)}°（合格: 平均≦${A_MEAN_MAX_DEG}° かつ 各≦${A_SEG_MAX_DEG}°） -> 違反(${failReason})`
        );
      } else {
        console.log(
          `  写真整合:   平均角度差 ${photoMatchResult.meanDeg.toFixed(1)}° -> 合格`
        );
      }

      if (photoMatchResult.segs) {
        for (const s of photoMatchResult.segs.sort((x, y) => y.angleDeg - x.angleDeg)) {
          const dir = process.env.VERBOSE
            ? `  render[${s.dirA.map((v) => v.toFixed(2)).join(",")}] photo[${s.dirB.map((v) => v.toFixed(2)).join(",")}]`
            : "";
          console.log(
            `    ${s.segment.padEnd(11)} ${s.angleDeg.toFixed(1).padStart(6)}° (${photoMatchResult.segSource.get(s.segment)})${dir}`
          );
        }
      }
    }

    // 6. 安定性（#118）
    if (!check.stability) {
      console.log("  安定性:     指定なし（contacts 未設定）");
    } else {
      const distCm = (check.stability.distanceToBoundaryM * 100).toFixed(1);
      const supportStr = check.stability.supportBones.join(",") || "なし";
      if (check.stability.pass) {
        console.log(`  安定性:     合格（境界まで ${distCm}cm、支持 ${supportStr}）`);
      } else if (waivedRes.stability.waived) {
        console.log(
          `  安定性:     違反（境界まで ${distCm}cm、支持 ${supportStr}） -> WAIVED（${waivedRes.stability.reason}）`
        );
      } else {
        console.log(
          `  安定性:     違反（境界まで ${distCm}cm、支持 ${supportStr}）`
        );
      }
    }

    // 7. 過剰宣言 warning
    for (const unused of waivedRes.unusedWaivers) {
      console.warn(`  WAIVER 未使用: ${unused.label} warning`);
    }

    // JSON 用結果オブジェクト構築
    const result = {
      pose,
      tier,
      rom: { violations: waivedRes.rom.length, waived: waivedRes.waivedCounts.rom },
      penetration: {
        violations: waivedRes.penetrations.length,
        warn: waivedRes.warnPenetrations.length,
        waived: waivedRes.waivedCounts.penetration,
      },
      contact: { violations: waivedRes.contacts.length, total: totalContacts, waived: waivedRes.waivedCounts.contact },
      palm: { violations: waivedRes.palms.length, total: totalPalms, waived: waivedRes.waivedCounts.palm },
      photoMatch: {
        status: waivedRes.photoAlignment.waived ? "waived" : photoMatchResult.status,
        meanDeg: photoMatchResult.meanDeg,
        over: photoMatchResult.over,
        coverage: photoMatchResult.coverage,
        systems: photoMatchResult.systems,
        coverageFail: photoMatchResult.coverageFail,
        qualityFail: photoMatchResult.qualityFail,
        waived: waivedRes.photoAlignment.waived ? 1 : 0,
      },
      stability: check.stability
        ? {
            pass: waivedRes.stability.pass,
            distanceToBoundaryM: check.stability.distanceToBoundaryM,
            comXZ: check.stability.comXZ,
            supportBones: check.stability.supportBones,
          }
        : null,
    };
    jsonResults.push(result);
  }

  if (jsonPath && jsonResults.length > 0) {
    writeFileSync(
      jsonPath,
      JSON.stringify(
        { schemaVersion: 2, results: jsonResults, exitCode: globalViolation ? 1 : 0 },
        null,
        2
      )
    );
    console.log(`\nJSON output: ${jsonPath}`);
  }

  await browser.close();
  process.exit(globalViolation ? 1 : 0);
}

const isDirectRun = () => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
