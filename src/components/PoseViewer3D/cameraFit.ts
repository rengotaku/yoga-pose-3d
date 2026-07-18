import * as THREE from "three";

export interface CameraFitResult {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * バウンディングボックスからカメラ位置と注視点（target）を計算する純粋関数。
 * bbox の縦横それぞれが視錐台（縦 fov + アスペクト比から導く横 fov）に
 * 収まる距離の大きい方を採用し、bbox 手前側の奥行き半分を加算する。
 * @param box 対象オブジェクトのバウンディングボックス
 * @param fov カメラの縦視野角 (度)
 * @param margin 余白の倍率 (デフォルト: 1.1)
 * @param aspect ビューポートのアスペクト比 width/height (デフォルト: 1)
 * @returns CameraFitResult
 */
export const calculateCameraFit = (
  box: THREE.Box3,
  fov: number,
  margin = 1.1,
  aspect = 1
): CameraFitResult => {
  if (box.isEmpty()) {
    return {
      position: new THREE.Vector3(0, 1, 3),
      target: new THREE.Vector3(0, 0, 0),
    };
  }

  const target = new THREE.Vector3();
  box.getCenter(target);

  const size = new THREE.Vector3();
  box.getSize(size);

  const fovRad = (fov * Math.PI) / 180;
  const tanHalfV = Math.tan(fovRad / 2);
  const tanHalfH = tanHalfV * aspect;

  const distV = (size.y * margin) / 2 / tanHalfV;
  const distH = (size.x * margin) / 2 / tanHalfH;
  // カメラは +Z 正面から注視するため、bbox 手前面までの奥行き半分を加算する
  const distance = Math.max(distV, distH) + size.z / 2;

  const position = new THREE.Vector3(target.x, target.y, target.z + distance);

  return { position, target };
};
