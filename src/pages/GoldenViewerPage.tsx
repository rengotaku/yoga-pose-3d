import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  loadMannequin,
  computeSkeletonBoundingBox,
  groundMannequin,
} from "../components/PoseViewer3D/skinnedMannequin";
import {
  applyGoldenRotations,
  exportWorldRotations,
} from "../components/PoseViewer3D/golden";
import { calculateCameraFit } from "../components/PoseViewer3D/cameraFit";
import { GOLDEN_POSES, goldenDataHash } from "./goldenPoses";

/** 床グリッドの Y 位置（PoseViewer3D と同値） */
const FLOOR_Y = -1;

/**
 * ゴールデンポーズ簡易ビューア（#78）。ゴールデン JSON をマネキンへ直接適用し、
 * OrbitControls で 360° 回転・ズームして確認する。静止画レンダーより視認性を
 * 上げるため、暗背景 + 強めのライティング + 接触影で表示する。
 */
export function GoldenViewerPage() {
  const mountRef = useRef<HTMLDivElement>(null);
  const mannequinRef = useRef<THREE.Group | null>(null);
  const initialQuatsRef = useRef<Map<string, THREE.Quaternion>>(new Map());
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const [selected, setSelected] = useState<string>(GOLDEN_POSES[0]?.pose ?? "");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x334155); // slate-700

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100
    );
    camera.position.set(0, 1, 3);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controlsRef.current = controls;

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x475569, 0.9);
    scene.add(hemiLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
    dirLight.position.set(2, 5, 3);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.camera.left = -4;
    dirLight.shadow.camera.right = 4;
    dirLight.shadow.camera.top = 4;
    dirLight.shadow.camera.bottom = -4;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 20;
    scene.add(dirLight);

    const grid = new THREE.GridHelper(10, 20, 0xcbd5e1, 0x94a3b8);
    grid.material.opacity = 0.4;
    grid.material.transparent = true;
    grid.position.y = FLOOR_Y;
    scene.add(grid);

    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.ShadowMaterial({ opacity: 0.45 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = FLOOR_Y - 0.001;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

    let disposed = false;
    loadMannequin("models/mannequin.glb")
      .then((mannequin) => {
        if (disposed) return;
        mannequin.traverse((child) => {
          if ((child as THREE.Bone).isBone) {
            initialQuatsRef.current.set(child.name, child.quaternion.clone());
          }
          if (child instanceof THREE.SkinnedMesh) {
            // 白背景で白飛びしないよう、中間トーンのマット材質に差し替える
            child.material = new THREE.MeshStandardMaterial({
              color: 0xd6bfa8,
              roughness: 0.85,
              metalness: 0,
            });
            child.castShadow = true;
            child.frustumCulled = false;
          }
        });
        scene.add(mannequin);
        mannequinRef.current = mannequin;
        setStatus("ready");
      })
      .catch(() => {
        if (!disposed) setStatus("error");
      });

    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const handleResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(mount);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      cancelAnimationFrame(frameId);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
      cameraRef.current = null;
      controlsRef.current = null;
      mannequinRef.current = null;
    };
  }, []);

  // ポーズ適用（選択変更・ロード完了時）
  useEffect(() => {
    const mannequin = mannequinRef.current;
    const golden = GOLDEN_POSES.find((g) => g.pose === selected);
    if (status !== "ready" || !mannequin || !golden) return;

    applyGoldenRotations(mannequin, initialQuatsRef.current, golden);
    groundMannequin(mannequin, FLOOR_Y);

    // 診断フック（#88 dev 専用）: メインページの適用結果とボーン単位で
    // 突合するため、この画面の world 回転をエクスポートできるようにする
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__goldenDebug = {
        pose: golden.pose,
        exportRotations: () => exportWorldRotations(mannequin),
      };
    }

    let skeleton: THREE.Skeleton | undefined;
    mannequin.traverse((child) => {
      if (!skeleton && child instanceof THREE.SkinnedMesh && child.skeleton) {
        skeleton = child.skeleton;
      }
    });
    if (skeleton && cameraRef.current && controlsRef.current) {
      const box = computeSkeletonBoundingBox(skeleton);
      if (!box.isEmpty()) {
        const { position, target } = calculateCameraFit(
          box,
          cameraRef.current.fov,
          undefined,
          cameraRef.current.aspect
        );
        cameraRef.current.position.copy(position);
        controlsRef.current.target.copy(target);
        controlsRef.current.update();
      }
    }
  }, [selected, status]);

  const current = GOLDEN_POSES.find((g) => g.pose === selected);

  return (
    <div className="relative w-screen h-screen">
      <div ref={mountRef} className="absolute inset-0" />
      <div className="absolute top-4 left-4 flex flex-col gap-2 max-w-xs">
        <h1 className="text-white text-lg font-semibold drop-shadow">
          ゴールデンポーズビューア
        </h1>
        <div className="flex flex-wrap gap-2">
          {GOLDEN_POSES.map((g) => (
            <button
              key={g.pose}
              type="button"
              onClick={() => setSelected(g.pose)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                g.pose === selected
                  ? "bg-blue-500 text-white"
                  : "bg-white/80 text-gray-800 hover:bg-white"
              }`}
            >
              {g.pose}
            </button>
          ))}
        </div>
        {current?.description && (
          <p className="text-white/90 text-sm drop-shadow">{current.description}</p>
        )}
        <p className="text-white/60 text-xs">
          ドラッグで回転 / ホイールでズーム / 右ドラッグで平行移動
        </p>
        <p className="text-white/60 text-xs font-mono">
          build {__GIT_SHA__}
          {current ? ` / ${current.pose} data #${goldenDataHash(current)}` : ""}
        </p>
        {status === "loading" && (
          <p className="text-white/80 text-sm">3Dモデルを読み込み中...</p>
        )}
        {status === "error" && (
          <p className="text-red-300 text-sm">3Dモデルの読み込みに失敗しました</p>
        )}
      </div>
    </div>
  );
}
