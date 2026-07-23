import * as THREE from "three";
import { STABILITY, type StabilityResult } from "./poseValidity";

/**
 * 重心（COM）マーカー・支持多角形の描画（#119）。/golden 編集画面で
 * `checkStability` の結果を目視確認できるよう可視化する。
 *
 * 判定閾値は `poseValidity.ts` の `STABILITY` を単一ソースとして使い、
 * このファイルでは色・半径などの見た目パラメータのみを持つ（#116 の
 * 「UI 側で閾値を独自定義しない」制約）。
 */

/** 安定度の色帯（緑=余裕あり / 黄=境界近い / 赤=外側・不安定） */
export type StabilityBand = "safe" | "warn" | "danger";

export const STABILITY_VIZ = {
  /** COM マーカーの半径（m）。仕様の「半径 ~2cm」 */
  comRadiusM: 0.02,
  colors: {
    safe: 0x22c55e, // green-500
    warn: 0xeab308, // yellow-500
    danger: 0xef4444, // red-500
  } satisfies Record<StabilityBand, number>,
  polygonColor: 0x38bdf8, // sky-400
} as const;

/**
 * 支持多角形境界からの符号付き距離（m）から色帯を決める。
 * 緑: distance >= marginM（余裕あり） / 黄: 0 <= distance < marginM（境界近い） /
 * 赤: distance < 0（外側・不安定）。
 */
export const stabilityBandFor = (distanceToBoundaryM: number): StabilityBand => {
  if (distanceToBoundaryM < 0) return "danger";
  if (distanceToBoundaryM < STABILITY.marginM) return "warn";
  return "safe";
};

/** 支持多角形の頂点上限。CONTACT_PART_BONES のキー数 × 別名重複を見込んだ余裕値 */
const MAX_POLYGON_VERTICES = 24;

export type StabilityViz = {
  /** COM マーカー・支持多角形ラインを scene に追加する（既に mount 済みなら no-op） */
  mount: (scene: THREE.Scene) => void;
  /**
   * stability 結果を反映して位置・色・頂点を更新する。
   * comWorldY は COM の実際の高さ（`computeCOM` の world.y）、floorY は支持多角形を
   * 描く水平面の高さ（床グリッドと同じ Y）。
   */
  update: (result: StabilityResult, comWorldY: number, floorY: number) => void;
  /** scene から remove し、geometry/material を dispose する */
  unmount: () => void;
  /** mount 済みかどうか（テスト・デバッグ用） */
  isMounted: () => boolean;
};

/**
 * COM マーカー（THREE.Mesh）と支持多角形ライン（THREE.LineLoop）を管理する。
 * `mount`/`unmount` はトグル ON/OFF に対応し、`update` は mount 中の再利用インスタンスへ
 * 位置・色・頂点だけを書き込む（毎フレーム new しない）。
 */
export const createStabilityViz = (): StabilityViz => {
  let scene: THREE.Scene | null = null;
  let marker: THREE.Mesh | null = null;
  let markerGeometry: THREE.SphereGeometry | null = null;
  let markerMaterial: THREE.MeshBasicMaterial | null = null;
  let line: THREE.LineLoop | null = null;
  let lineGeometry: THREE.BufferGeometry | null = null;
  let lineMaterial: THREE.LineBasicMaterial | null = null;

  const mount: StabilityViz["mount"] = (targetScene) => {
    if (marker) return; // 既に mount 済み

    markerGeometry = new THREE.SphereGeometry(STABILITY_VIZ.comRadiusM, 16, 16);
    markerMaterial = new THREE.MeshBasicMaterial({
      color: STABILITY_VIZ.colors.safe,
      depthTest: false,
    });
    marker = new THREE.Mesh(markerGeometry, markerMaterial);
    // 関節マーカー（renderOrder 999）より手前・ギズモ（Infinity）より奥に描く
    marker.renderOrder = 1000;
    targetScene.add(marker);

    lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(MAX_POLYGON_VERTICES * 3), 3)
    );
    lineGeometry.setDrawRange(0, 0);
    lineMaterial = new THREE.LineBasicMaterial({
      color: STABILITY_VIZ.polygonColor,
      depthTest: false,
    });
    line = new THREE.LineLoop(lineGeometry, lineMaterial);
    line.renderOrder = 998;
    line.visible = false;
    targetScene.add(line);

    scene = targetScene;
  };

  const update: StabilityViz["update"] = (result, comWorldY, floorY) => {
    if (!marker || !markerMaterial || !line || !lineGeometry) return;

    const degenerate = result.supportPolygon.length < 3;
    const band: StabilityBand = degenerate
      ? "danger"
      : stabilityBandFor(result.distanceToBoundaryM);

    marker.position.set(result.comXZ.x, comWorldY, result.comXZ.z);
    markerMaterial.color.setHex(STABILITY_VIZ.colors[band]);

    if (degenerate) {
      // 支持点 1〜2 点（凸包不成立）は支持面なし表示にフォールバックする
      line.visible = false;
      lineGeometry.setDrawRange(0, 0);
      return;
    }

    const count = Math.min(result.supportPolygon.length, MAX_POLYGON_VERTICES);
    const position = lineGeometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const p = result.supportPolygon[i];
      position.setXYZ(i, p.x, floorY, p.z);
    }
    position.needsUpdate = true;
    lineGeometry.setDrawRange(0, count);
    line.visible = true;
  };

  const unmount: StabilityViz["unmount"] = () => {
    if (scene) {
      if (marker) scene.remove(marker);
      if (line) scene.remove(line);
    }
    markerMaterial?.dispose();
    markerGeometry?.dispose();
    lineMaterial?.dispose();
    lineGeometry?.dispose();
    marker = null;
    markerGeometry = null;
    markerMaterial = null;
    line = null;
    lineGeometry = null;
    lineMaterial = null;
    scene = null;
  };

  const isMounted: StabilityViz["isMounted"] = () => marker !== null;

  return { mount, update, unmount, isMounted };
};
