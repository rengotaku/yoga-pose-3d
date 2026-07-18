import * as THREE from "three";

export interface CameraFitResult {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/**
 * バウンディングボックスからカメラ位置と注視点（target）を計算する純粋関数
 * @param box 対象オブジェクトのバウンディングボックス
 * @param fov カメラの視野角 (度)
 * @param margin 余白の倍率 (デフォルト: 1.3)
 * @returns CameraFitResult
 */
export const calculateCameraFit = (
  box: THREE.Box3,
  fov: number,
  margin = 1.3
): CameraFitResult => {
  if (box.isEmpty()) {
    return {
      position: new THREE.Vector3(0, 1, 3),
      target: new THREE.Vector3(0, 0, 0),
    };
  }

  const target = new THREE.Vector3();
  box.getCenter(target);

  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);

  const fovRad = (fov * Math.PI) / 180;
  // BoundingSphere が fov 内に収まる距離を計算
  const distance = (sphere.radius * margin) / Math.sin(fovRad / 2);

  const position = new THREE.Vector3(target.x, target.y, target.z + distance);

  return { position, target };
};
