import { describe, it, expect } from "vitest";
import { validateWaivers, applyWaivers } from "./golden-check.mjs";

const createMockCheck = (overrides = {}) => ({
  rom: [],
  penetrations: [],
  contacts: [],
  palms: [],
  photoAlignment: { status: "pass", meanDeg: 10, over: 0, coverage: 9, systems: 5, coverageFail: false, qualityFail: false },
  ...overrides,
});

describe("waiver schema and validation (Case 1 ~ Case 8)", () => {
  // Case 1: waiver 無し = 従来通り
  it("Case 1: waiver 無し = 従来通り", () => {
    const check = createMockCheck({
      penetrations: [{ a: "thigh:L", b: "calf:R", depthM: 0.03 }],
      contacts: [{ part: "hip", grounded: false, clearanceM: 0.1 }],
    });
    const result = applyWaivers(check, undefined);
    expect(result.violation).toBe(true);
    expect(result.waivedCounts.total).toBe(0);
    const reportText = (result.reportLines || []).join("\n");
    expect(reportText).not.toContain("WAIVED");
  });

  // Case 2: 該当ペアの penetration を waive
  it("Case 2: 該当ペアの penetration を waive", () => {
    const check = createMockCheck({
      penetrations: [{ a: "thigh:L", b: "calf:R", depthM: 0.031 }],
    });
    const waivers = {
      penetration: { pair: "thigh:L × calf:R", reason: "交差脛の構造的帰結" },
    };
    const result = applyWaivers(check, waivers);
    expect(result.violation).toBe(false);
    expect(result.waivedCounts.penetration).toBe(1);
    const reportText = (result.reportLines || []).join("\n");
    expect(reportText).toMatch(/WAIVED 1: thigh:L × calf:R = 3.1cm/);
  });

  // Case 3: waive で消えないペアが残っている場合は FAIL
  it("Case 3: waive で消えないペアが残っている場合は FAIL", () => {
    const check = createMockCheck({
      penetrations: [
        { a: "thigh:L", b: "calf:R", depthM: 0.03 },
        { a: "foot:L", b: "foot:R", depthM: 0.02 },
      ],
    });
    const waivers = {
      penetration: { pair: "thigh:L × calf:R", reason: "一部のみ waive" },
    };
    const result = applyWaivers(check, waivers);
    expect(result.violation).toBe(true);
    expect(result.waivedCounts.penetration).toBe(1);
    expect(result.penetrations.length).toBe(1);
  });

  // Case 4: contact 部位単位で waive
  it("Case 4: contact 部位単位で waive", () => {
    const check = createMockCheck({
      contacts: [{ part: "hip", grounded: false, clearanceM: 0.228 }],
    });
    const waivers = {
      contact: { part: "hip", reason: "root fixed" },
    };
    const result = applyWaivers(check, waivers);
    expect(result.violation).toBe(false);
    expect(result.waivedCounts.contact).toBe(1);
  });

  // Case 5: photoAlignment のポーズ全体 waive
  it("Case 5: photoAlignment のポーズ全体 waive", () => {
    const check = createMockCheck({
      photoAlignment: {
        status: "fail",
        meanDeg: 38.9,
        over: 2,
        coverage: 9,
        systems: 5,
        coverageFail: false,
        qualityFail: true,
      },
    });
    const waivers = {
      photoAlignment: { reason: "2D 深度潰れ" },
    };
    const result = applyWaivers(check, waivers);
    expect(result.violation).toBe(false);
    const reportText = (result.reportLines || []).join("\n");
    expect(reportText).toContain("WAIVED（2D 深度潰れ）");
  });

  // Case 6: waivers に理由が無いと validation error
  it("Case 6: waivers に理由が無いと validation error", () => {
    const waivers = { contact: { part: "hip" } };
    expect(() => validateWaivers(waivers)).toThrow(/reason is required/i);
  });

  // Case 7: waivers に未知のゲート名で validation error
  it("Case 7: waivers に未知のゲート名で validation error", () => {
    const waivers = { unknownGate: { reason: "test" } };
    expect(() => validateWaivers(waivers)).toThrow(/unknown gate/i);
    try {
      validateWaivers(waivers);
    } catch (e) {
      expect(e.message).toMatch(/rom/);
      expect(e.message).toMatch(/penetration/);
      expect(e.message).toMatch(/contact/);
      expect(e.message).toMatch(/palm/);
      expect(e.message).toMatch(/photoAlignment/);
    }
  });

  // Case 8: 過剰宣言 warning（宣言したが該当違反なし）
  it("Case 8: 過剰宣言 warning（宣言したが該当違反なし）", () => {
    const check = createMockCheck({
      contacts: [{ part: "knee", grounded: true, clearanceM: 0 }],
    });
    const waivers = {
      contact: { part: "knee", reason: "誤った宣言" },
    };
    const result = applyWaivers(check, waivers);
    expect(result.violation).toBe(false);
    expect(result.waivedCounts.total).toBe(0);
    const reportText = (result.reportLines || []).join("\n");
    expect(reportText).toContain("WAIVER 未使用: contact - knee");
  });

  // 追加テスト: Case 9: JSON 出力用 waived カウントの各ゲート集計 (result.<gate>.waived)
  it("Case 9: 各ゲートの waived カウントが正しく計算されること", () => {
    const check = createMockCheck({
      rom: [{ bone: "LeftUpLeg", axis: "x", valueDeg: 145, minDeg: -90, maxDeg: 90, excessDeg: 55 }],
      penetrations: [{ a: "thigh:L", b: "calf:R", depthM: 0.03 }],
      contacts: [{ part: "hip", grounded: false, clearanceM: 0.2 }],
      palms: [{ side: "L", flat: false, tiltDeg: 15 }],
      photoAlignment: { status: "fail", meanDeg: 38.9, over: 1, coverage: 9, systems: 5, coverageFail: false, qualityFail: true },
    });
    const waivers = {
      rom: { bone: "LeftUpLeg", reason: "可動域限界" },
      penetration: { pair: "thigh:L × calf:R", reason: "構造的帰結" },
      contact: { part: "hip", reason: "root fixed" },
      palm: { side: "L", reason: "傾き許容" },
      photoAlignment: { reason: "2D 深度潰れ" },
    };
    const result = applyWaivers(check, waivers);
    expect(result.violation).toBe(false);
    expect(result.waivedCounts.rom).toBe(1);
    expect(result.waivedCounts.penetration).toBe(1);
    expect(result.waivedCounts.contact).toBe(1);
    expect(result.waivedCounts.palm).toBe(1);
    expect(result.waivedCounts.photoAlignment).toBe(1);
    expect(result.waivedCounts.total).toBe(5);
  });

  // 追加テスト: Case 10: photoMatch オブジェクトが check 結果から渡された場合の互換性
  it("Case 10: photoMatch として設定された結果に photoAlignment waiver が適用されること", () => {
    const check = {
      rom: [],
      penetrations: [],
      contacts: [],
      palms: [],
      photoMatch: { status: "fail", meanDeg: 40, over: 2, coverage: 9, systems: 5, coverageFail: false, qualityFail: true },
    };
    const waivers = {
      photoAlignment: { reason: "写真整合例外" },
    };
    const result = applyWaivers(check, waivers);
    expect(result.violation).toBe(false);
    expect(result.waivedCounts.photoAlignment).toBe(1);
  });

  // 追加テスト: Case 11: photoAlignment 配列形式 waiver の理由が report/waivedRes 側に正しく反映される
  it("Case 11: photoAlignment 配列形式 waiver の理由が report/waivedRes 側に正しく反映される", () => {
    const check = createMockCheck({
      photoAlignment: {
        status: "fail",
        meanDeg: 38.9,
        over: 2,
        coverage: 9,
        systems: 5,
        coverageFail: false,
        qualityFail: true,
      },
    });
    const waivers = {
      photoAlignment: [{ reason: "配列形式での免除理由" }],
    };
    const result = applyWaivers(check, waivers);
    expect(result.violation).toBe(false);
    expect(result.waivedCounts.photoAlignment).toBe(1);
    expect(result.photoAlignment.reason).toBe("配列形式での免除理由");
    const reportText = (result.reportLines || []).join("\n");
    expect(reportText).toContain("WAIVED（配列形式での免除理由）");
  });
});


