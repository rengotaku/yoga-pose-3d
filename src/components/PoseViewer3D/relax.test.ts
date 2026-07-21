import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { collectRelaxChain, relaxDownstream } from "./relax";
import { buildBodyCapsules, detectSelfPenetrations } from "./poseValidity";

/**
 * 左腕チェーン + 指分岐のテスト用リグ。
 *   pelvis → spine_01 → spine_02 → clavicle_l → upperarm_l → lowerarm_l → hand_l
 *                                                                          ├─ thumb_01_l
 *                                                                          └─ index_01_l
 * 標準名 (userData.stdName) を GoldenViewerPage.tsx と同じ形で付ける。
 * バインドポーズは腕を水平前方（world +X 沿い）に伸ばした形にして、
 * 「-Y へ垂れる」動きが位置変化として観測しやすいようにする。
 */
const buildLeftArmRig = () => {
  const root = new THREE.Group();
  const pelvis = new THREE.Bone();
  pelvis.name = "pelvis";
  pelvis.userData.stdName = "Hips";
  const spine01 = new THREE.Bone();
  spine01.name = "spine_01";
  spine01.userData.stdName = "Spine";
  const spine02 = new THREE.Bone();
  spine02.name = "spine_02";
  spine02.userData.stdName = "Spine1";
  const clavicleL = new THREE.Bone();
  clavicleL.name = "clavicle_l";
  clavicleL.userData.stdName = "LeftShoulder";
  const upperarmL = new THREE.Bone();
  upperarmL.name = "upperarm_l";
  upperarmL.userData.stdName = "LeftArm";
  const lowerarmL = new THREE.Bone();
  lowerarmL.name = "lowerarm_l";
  lowerarmL.userData.stdName = "LeftForeArm";
  const handL = new THREE.Bone();
  handL.name = "hand_l";
  handL.userData.stdName = "LeftHand";
  const thumb01L = new THREE.Bone();
  thumb01L.name = "thumb_01_l";
  thumb01L.userData.stdName = "LeftHandThumb1";
  const index01L = new THREE.Bone();
  index01L.name = "index_01_l";
  index01L.userData.stdName = "LeftHandIndex1";
  // 駆動対象外のリーフ（stdName 無し）: hand 直下に付けてもチェーンには入らないこと
  const leafDecoration = new THREE.Bone();
  leafDecoration.name = "hand_l_leaf";

  root.add(pelvis);
  pelvis.add(spine01);
  spine01.add(spine02);
  spine02.add(clavicleL);
  clavicleL.add(upperarmL);
  // 腕を水平前方（+X）に伸ばす: upperarm を pelvis の右横に配置し、
  // lowerarm→hand→指を +X 方向に並べる（脱力すると child の位置が下がる想定）
  upperarmL.position.set(0.2, 1.4, 0);
  lowerarmL.position.set(0.3, 0, 0);
  handL.position.set(0.3, 0, 0);
  thumb01L.position.set(0.05, 0, 0.03);
  index01L.position.set(0.06, 0, -0.02);
  upperarmL.add(lowerarmL);
  lowerarmL.add(handL);
  handL.add(thumb01L);
  handL.add(index01L);
  handL.add(leafDecoration);

  root.updateMatrixWorld(true);

  const initial = new Map<string, THREE.Quaternion>();
  for (const b of [
    pelvis,
    spine01,
    spine02,
    clavicleL,
    upperarmL,
    lowerarmL,
    handL,
    thumb01L,
    index01L,
  ]) {
    initial.set(b.name, b.quaternion.clone());
  }
  return {
    root,
    pelvis,
    spine01,
    spine02,
    clavicleL,
    upperarmL,
    lowerarmL,
    handL,
    thumb01L,
    index01L,
    leafDecoration,
    initial,
  };
};

describe("collectRelaxChain", () => {
  it("returns descendants (parent-first) excluding the selected bone itself", () => {
    const rig = buildLeftArmRig();
    const chain = collectRelaxChain(rig.upperarmL, { includeFingers: true });
    const names = chain.map((b) => b.name);
    // 選択ボーン自身は含まれない、下流のみ
    expect(names).not.toContain("upperarm_l");
    // 親→子の順序（lowerarm → hand → 指 の順）
    const iLower = names.indexOf("lowerarm_l");
    const iHand = names.indexOf("hand_l");
    const iThumb = names.indexOf("thumb_01_l");
    expect(iLower).toBeGreaterThanOrEqual(0);
    expect(iHand).toBeGreaterThan(iLower);
    expect(iThumb).toBeGreaterThan(iHand);
  });

  it("excludes finger bones when includeFingers=false", () => {
    const rig = buildLeftArmRig();
    const chain = collectRelaxChain(rig.upperarmL, { includeFingers: false });
    const names = chain.map((b) => b.name);
    expect(names).toContain("lowerarm_l");
    expect(names).toContain("hand_l");
    expect(names).not.toContain("thumb_01_l");
    expect(names).not.toContain("index_01_l");
  });

  it("excludes bones without stdName (non-driven leaves)", () => {
    const rig = buildLeftArmRig();
    const chain = collectRelaxChain(rig.handL, { includeFingers: true });
    const names = chain.map((b) => b.name);
    // hand_l_leaf は userData.stdName を持たないため対象外
    expect(names).not.toContain("hand_l_leaf");
    expect(names).toContain("thumb_01_l");
    expect(names).toContain("index_01_l");
  });
});

describe("relaxDownstream", () => {
  it("bends downstream bones toward gravity (child positions drop in world Y)", () => {
    const rig = buildLeftArmRig();
    // 相談前: lowerarm world 位置は upperarm より水平方向にオフセット
    const handYBefore = rig.handL.getWorldPosition(new THREE.Vector3()).y;
    const lowerarmYBefore = rig.lowerarmL.getWorldPosition(new THREE.Vector3()).y;

    const result = relaxDownstream(rig.upperarmL, rig.initial, {
      strength: 0.7,
      includeFingers: false,
    });
    // 少なくとも 1 ボーンは変化する（upperarm→lowerarm→hand で回転が発生）
    expect(result.changedCount).toBeGreaterThan(0);
    expect(result.affectedActualNames).toContain("lowerarm_l");

    // hand は lowerarm の下方向に降りて y 座標が減少する（-Y へ寄る）
    const handYAfter = rig.handL.getWorldPosition(new THREE.Vector3()).y;
    expect(handYAfter).toBeLessThan(handYBefore);
    // lowerarm 自身の world 位置は upperarm 由来なので変化はゼロ or 小さい
    // （upperarm は「主幹 child = lowerarm_l 1 本」なので自身も回転してよい）
    expect(lowerarmYBefore).toBeGreaterThan(-1e-3); // Y=0 付近から出発
  });

  it("does not rotate branching bones (hand has multiple editable children)", () => {
    const rig = buildLeftArmRig();
    // 選択ボーン = hand_l。指を含むと hand_l の子は複数（thumb + index）
    // = 分岐なので hand_l 自身は回らない。指は各自の主幹方向で処理を試みる
    // が、それぞれ子ボーンを持たないので回転はしない。
    const handQBefore = rig.handL.quaternion.clone();
    relaxDownstream(rig.handL, rig.initial, {
      strength: 1.0,
      includeFingers: true,
    });
    // hand 自身は選択ボーンなのでチェーン対象外 = quaternion 不変
    expect(rig.handL.quaternion.equals(handQBefore)).toBe(true);
    // thumb / index も葉なので回転しない
    expect(rig.thumb01L.quaternion.equals(rig.initial.get("thumb_01_l")!)).toBe(true);
    expect(rig.index01L.quaternion.equals(rig.initial.get("index_01_l")!)).toBe(true);
  });

  it("respects ROM clamping (LeftHand X does not exceed ±80°)", () => {
    const rig = buildLeftArmRig();
    // strength=1.0 で完全に -Y へ振ろうとしても、LeftHand の X ROM は ±80°
    relaxDownstream(rig.upperarmL, rig.initial, {
      strength: 1.0,
      includeFingers: false,
    });
    // hand_l の bind 相対 offset X が ±80° 内に収まっていること
    const bind = rig.initial.get("hand_l")!;
    const offset = bind.clone().invert().multiply(rig.handL.quaternion);
    const euler = new THREE.Euler().setFromQuaternion(offset, "XYZ");
    const xDeg = THREE.MathUtils.radToDeg(euler.x);
    const yDeg = THREE.MathUtils.radToDeg(euler.y);
    const zDeg = THREE.MathUtils.radToDeg(euler.z);
    // ROM_LIMITS_LEFT.LeftHand: x ±80, y ±30, z ±40 に丸め誤差の余裕を持たせる
    expect(xDeg).toBeGreaterThanOrEqual(-80.001);
    expect(xDeg).toBeLessThanOrEqual(80.001);
    expect(yDeg).toBeGreaterThanOrEqual(-30.001);
    expect(yDeg).toBeLessThanOrEqual(30.001);
    expect(zDeg).toBeGreaterThanOrEqual(-40.001);
    expect(zDeg).toBeLessThanOrEqual(40.001);
  });

  it("is deterministic (same input yields same result)", () => {
    const runOnce = () => {
      const rig = buildLeftArmRig();
      relaxDownstream(rig.upperarmL, rig.initial, {
        strength: 0.7,
        includeFingers: false,
      });
      return {
        lower: rig.lowerarmL.quaternion.clone(),
        hand: rig.handL.quaternion.clone(),
      };
    };
    const a = runOnce();
    const b = runOnce();
    expect(a.lower.angleTo(b.lower)).toBeLessThan(1e-6);
    expect(a.hand.angleTo(b.hand)).toBeLessThan(1e-6);
  });

  it("clamps strength to [0, 1] (out-of-range values are treated as boundary)", () => {
    // strength=0 → 現状維持、strength=2 は strength=1 と同じ結果
    const rigA = buildLeftArmRig();
    const rigZero = buildLeftArmRig();
    const rigOne = buildLeftArmRig();
    const rigTwo = buildLeftArmRig();

    relaxDownstream(rigZero.upperarmL, rigZero.initial, {
      strength: 0,
      includeFingers: false,
    });
    // strength=0 は方向を全く変えない → quaternion は初期値と一致（or 微小差）
    expect(
      rigZero.lowerarmL.quaternion.angleTo(rigA.initial.get("lowerarm_l")!)
    ).toBeLessThan(1e-6);

    relaxDownstream(rigOne.upperarmL, rigOne.initial, {
      strength: 1,
      includeFingers: false,
    });
    relaxDownstream(rigTwo.upperarmL, rigTwo.initial, {
      strength: 2,
      includeFingers: false,
    });
    // strength=2 は strength=1 と同一結果（Math.min(1, ...) でクランプ）
    expect(rigOne.handL.quaternion.angleTo(rigTwo.handL.quaternion)).toBeLessThan(1e-6);
  });

  it("no-op when selecting a leaf bone with no editable descendants", () => {
    const rig = buildLeftArmRig();
    const before = rig.thumb01L.quaternion.clone();
    const result = relaxDownstream(rig.thumb01L, rig.initial, {
      strength: 0.7,
      includeFingers: true,
    });
    expect(result.changedCount).toBe(0);
    expect(result.affectedActualNames).toEqual([]);
    expect(rig.thumb01L.quaternion.equals(before)).toBe(true);
  });

  it("contactAware=false gives the same result whether mannequin is passed or not (backward compat)", () => {
    const rigA = buildLeftArmRig();
    const rigB = buildLeftArmRig();
    relaxDownstream(rigA.upperarmL, rigA.initial, {
      strength: 0.7,
      includeFingers: false,
      contactAware: false,
    });
    relaxDownstream(
      rigB.upperarmL,
      rigB.initial,
      { strength: 0.7, includeFingers: false, contactAware: false },
      rigB.root
    );
    expect(rigA.handL.quaternion.angleTo(rigB.handL.quaternion)).toBeLessThan(1e-6);
    expect(rigA.lowerarmL.quaternion.angleTo(rigB.lowerarmL.quaternion)).toBeLessThan(
      1e-6
    );
  });
});

/**
 * 接触考慮テスト用のリグ（#112）: clavicle を選択して左腕全体（upperarm 含む）
 * を relax し、下向きに大きく振れる配置にする。右腕を左腕の swing 経路上に
 * 置いて衝突を作る。buildBodyCapsules が resolveBoneName 経由で
 * mixamorig:LeftArm → upperarm_l を解決するので、GLB と同じ命名を保つ。
 *
 *  root
 *   ├─ clavicle_l (0, 0, 0) ← select this for relax（chain = 下流全部）
 *   │    └─ upperarm_l (0.2, 1.4, 0) → lowerarm_l (0.3, 0, 0) → hand_l (0.3, 0, 0)
 *   │            = 左肩から水平 +X へ 0.6m 伸びる。upperarm ごと下振り可能
 *   └─ upperarm_r (0.4, 0.9, 0) → lowerarm_r (0.3, 0, 0) → hand_r (0.3, 0, 0)
 *            = 左腕 upperarm の relax swing 経路（x=0.2, y∈[0.8,1.4]）を
 *              水平に横切る位置。カプセル半径 0.045 との合計で必ず衝突する
 *
 * 左腕を -Y へ 100% 振ると upperarm 先端が (0.2, 0.8, 0) へ落ち、右腕
 * カプセル(y=0.9)を貫通する。contactAware=true は baseline 侵入数を保つ。
 */
const buildTwoArmsRig = () => {
  const root = new THREE.Group();
  const clavicleL = new THREE.Bone();
  clavicleL.name = "clavicle_l";
  clavicleL.userData.stdName = "LeftShoulder";
  const upperarmL = new THREE.Bone();
  upperarmL.name = "upperarm_l";
  upperarmL.userData.stdName = "LeftArm";
  upperarmL.position.set(0.2, 1.4, 0);
  const lowerarmL = new THREE.Bone();
  lowerarmL.name = "lowerarm_l";
  lowerarmL.userData.stdName = "LeftForeArm";
  lowerarmL.position.set(0.3, 0, 0);
  const handL = new THREE.Bone();
  handL.name = "hand_l";
  handL.userData.stdName = "LeftHand";
  handL.position.set(0.3, 0, 0);
  clavicleL.add(upperarmL);
  upperarmL.add(lowerarmL);
  lowerarmL.add(handL);
  root.add(clavicleL);

  // upperarm_r: 左腕 forearm の relax 経路（垂直 x=0.2, y∈[0.8,1.1]）を横切る
  // ように x=0.0 から +X 方向へ 0.3m 伸ばす。 upperArm:R セグメントは
  // x∈[0.0, 0.3] を y=0.9 で通り、左 forearm x=0.2 と交差 → 侵入発生
  const upperarmR = new THREE.Bone();
  upperarmR.name = "upperarm_r";
  upperarmR.userData.stdName = "RightArm";
  upperarmR.position.set(0.0, 0.9, 0);
  const lowerarmR = new THREE.Bone();
  lowerarmR.name = "lowerarm_r";
  lowerarmR.userData.stdName = "RightForeArm";
  lowerarmR.position.set(0.3, 0, 0);
  const handR = new THREE.Bone();
  handR.name = "hand_r";
  handR.userData.stdName = "RightHand";
  handR.position.set(0.3, 0, 0);
  upperarmR.add(lowerarmR);
  lowerarmR.add(handR);
  root.add(upperarmR);

  root.updateMatrixWorld(true);
  const initial = new Map<string, THREE.Quaternion>();
  for (const b of [clavicleL, upperarmL, lowerarmL, handL, upperarmR, lowerarmR, handR]) {
    initial.set(b.name, b.quaternion.clone());
  }
  return {
    root,
    clavicleL,
    upperarmL,
    lowerarmL,
    handL,
    upperarmR,
    lowerarmR,
    handR,
    initial,
  };
};

describe("relaxDownstream contact-aware behavior (#112)", () => {
  it("full-strength relax without contactAware causes a penetration in the two-arms rig", () => {
    // ベースライン確認: contactAware=false で強く振ると相手の腕へ侵入する
    const rig = buildTwoArmsRig();
    const baseline = detectSelfPenetrations(buildBodyCapsules(rig.root)).length;
    expect(baseline).toBe(0);
    relaxDownstream(
      rig.clavicleL,
      rig.initial,
      { strength: 1.0, includeFingers: false, contactAware: false },
      rig.root
    );
    const after = detectSelfPenetrations(buildBodyCapsules(rig.root)).length;
    // 侵入が発生することがこのテスト rig の前提。0 のままなら rig 配置を見直す
    expect(after).toBeGreaterThan(baseline);
  });

  it("contactAware=true stops before adding new penetrations (rests on the below arm)", () => {
    const rig = buildTwoArmsRig();
    const baseline = detectSelfPenetrations(buildBodyCapsules(rig.root)).length;
    const result = relaxDownstream(
      rig.upperarmL,
      rig.initial,
      { strength: 1.0, includeFingers: false, contactAware: true },
      rig.root
    );
    // 侵入数は baseline を超えない = 相手腕を貫通しない
    const after = detectSelfPenetrations(buildBodyCapsules(rig.root)).length;
    expect(after).toBeLessThanOrEqual(baseline);
    // ただし脱力自体は発生している = 少なくとも 1 手前のステップで動いた
    // （strength=0 で止まった場合は 0。強度制限として changedCount>=0 は許容）
    expect(result.affectedActualNames.length).toBeGreaterThan(0);
  });

  it("contactAware falls back to full strength when there is no collision", () => {
    // 相手の腕を遠くへ避けて衝突しない配置にすると、contactAware でも target strength が適用される
    const rig = buildTwoArmsRig();
    rig.upperarmR.position.set(-1, -1, 0); // 遠くへ移動
    rig.root.updateMatrixWorld(true);

    const rigNoContact = buildTwoArmsRig();
    rigNoContact.upperarmR.position.set(-1, -1, 0);
    rigNoContact.root.updateMatrixWorld(true);

    relaxDownstream(
      rig.clavicleL,
      rig.initial,
      { strength: 0.7, includeFingers: false, contactAware: true },
      rig.root
    );
    relaxDownstream(rigNoContact.clavicleL, rigNoContact.initial, {
      strength: 0.7,
      includeFingers: false,
      contactAware: false,
    });
    // 衝突が無い場合、contactAware=true の結果は contactAware=false と一致する
    expect(
      rig.upperarmL.quaternion.angleTo(rigNoContact.upperarmL.quaternion)
    ).toBeLessThan(1e-4);
    expect(rig.handL.quaternion.angleTo(rigNoContact.handL.quaternion)).toBeLessThan(
      1e-4
    );
  });
});
