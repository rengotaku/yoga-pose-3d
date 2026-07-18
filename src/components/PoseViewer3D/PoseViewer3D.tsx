import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { usePoseStore } from "../../store/usePoseStore";
import { computeActivations, aggregateByMuscle } from "./muscles";
import { MuscleLegend, type MuscleActivation } from "./MuscleLegend";
import { calculateCameraFit } from "./cameraFit";
import {
  loadMannequin,
  setupMannequinMaterials,
  applyPoseToSkeleton,
  applyMuscleHeatColors,
  musclesAtFace,
  computeSkeletonBoundingBox,
  groundMannequin,
} from "./skinnedMannequin";
import { applyContactIK } from "./ik";
import { applyTorsoPushOut } from "./collision";

/** 床グリッドの Y 位置。マネキンの接地面もここに合わせる（#36） */
const FLOOR_Y = -1;

export const PoseViewer3D: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const worldLandmarks = usePoseStore((s) => s.worldLandmarks);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const mannequinRef = useRef<THREE.Group | null>(null);
  const initialQuaternionsRef = useRef<Map<string, THREE.Quaternion>>(new Map());

  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [mannequinModel, setMannequinModel] = useState<THREE.Group | null>(null);
  const [selectedMuscle, setSelectedMuscle] = useState<string | null>(null);
  const [hoveredMuscles, setHoveredMuscles] = useState<{
    ids: string[];
    x: number;
    y: number;
  } | null>(null);

  const muscles: MuscleActivation[] = useMemo(
    () =>
      worldLandmarks && worldLandmarks.length > 0
        ? aggregateByMuscle(computeActivations(worldLandmarks))
        : [],
    [worldLandmarks]
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f4f6); // gray-100
    sceneRef.current = scene;

    // Camera
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(0, 1, 3);
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(2, 5, 3);
    scene.add(directionalLight);

    // Grid Floor
    const gridHelper = new THREE.GridHelper(10, 20, 0x000000, 0x000000);
    gridHelper.material.opacity = 0.1;
    gridHelper.material.transparent = true;
    gridHelper.position.y = FLOOR_Y;
    scene.add(gridHelper);

    // Load Mannequin
    setIsLoading(true);
    setLoadError(null);
    // アンマウント済みマウントのロード結果を破棄するフラグ。これが無いと
    // StrictMode の二重マウントで旧マウントのロードが後から resolve した場合、
    // mannequinRef が破棄済み scene のマネキンを指し、ポーズ・カメラフィットが
    // 画面に映らないマネキンへ適用される（#47 のフレーミング崩れの正体）
    let disposed = false;
    loadMannequin("models/mannequin.glb")
      .then((mannequin) => {
        if (disposed) return;
        mannequin.name = "mannequin";
        setupMannequinMaterials(mannequin);

        mannequin.traverse((child) => {
          if ((child as THREE.Bone).isBone) {
            initialQuaternionsRef.current.set(child.name, child.quaternion.clone());
          }
        });

        scene.add(mannequin);
        mannequinRef.current = mannequin;

        // 画像未アップロード時の初期表示でもマネキン全体が枠に収まるよう、
        // ロード直後にカメラをマネキンの bbox に合わせる（脚だけ映る問題の解消）
        mannequin.updateMatrixWorld(true);
        let initialSkeleton: THREE.Skeleton | undefined;
        mannequin.traverse((child) => {
          if (!initialSkeleton && child instanceof THREE.SkinnedMesh && child.skeleton) {
            initialSkeleton = child.skeleton;
          }
        });
        if (initialSkeleton && cameraRef.current && controlsRef.current) {
          const box = computeSkeletonBoundingBox(initialSkeleton);
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

        setMannequinModel(mannequin);
        setIsLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load mannequin:", err);
        setLoadError(err);
        setIsLoading(false);
      });

    // Animation Loop
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // Handle Resize
    // 親コンテナ（flex-grow）は viewport 変更以外にも layout 確定・親要素の
    // min-h 反映などで後追いで拡大するため、window resize だけでは
    // 初期表示のキャンバスが古い寸法（layout 前）のまま残ってしまう。
    // ResizeObserver で mount 自体のサイズを監視して canvas を追従させる。
    const handleResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(mount);

    return () => {
      disposed = true;
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      cancelAnimationFrame(animationFrameId);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      mannequinRef.current = null;
    };
  }, []);

  // Update pose and colors when landmarks or selectedMuscle change
  useEffect(() => {
    const mannequin = mannequinRef.current;
    if (!mannequin || !worldLandmarks || worldLandmarks.length === 0) return;

    // 1. Reset to initial pose
    mannequin.traverse((child) => {
      if ((child as THREE.Bone).isBone) {
        const q = initialQuaternionsRef.current.get(child.name);
        if (q) child.quaternion.copy(q);
      }
    });

    // 2. Apply new pose
    applyPoseToSkeleton(mannequin, worldLandmarks);

    // Ensure world matrices are updated for bounding box computation
    mannequin.updateMatrixWorld(true);

    // 2.5 Ground: スキン頂点の最下点を床グリッドへスナップ（#36）
    groundMannequin(mannequin, FLOOR_Y);

    // 2.6 接地肢の末端を 2-bone IK で床へ届かせ、めり込みを最終接地で吸収（#41）
    applyContactIK(mannequin, worldLandmarks, FLOOR_Y);

    // 2.7 前腕・手の胴体めり込みを push-out で解消（#44）
    applyTorsoPushOut(mannequin, worldLandmarks);
    groundMannequin(mannequin, FLOOR_Y);

    // 3. Apply colors
    const acts = computeActivations(worldLandmarks);
    let skeleton: THREE.Skeleton | undefined;

    mannequin.traverse((child) => {
      if (child instanceof THREE.SkinnedMesh) {
        applyMuscleHeatColors(child, acts, selectedMuscle ?? undefined);
        if (!skeleton && child.skeleton) {
          skeleton = child.skeleton;
        }
      }
    });

    // 4. Update camera to fit the skeleton
    if (skeleton && cameraRef.current && controlsRef.current) {
      const box = computeSkeletonBoundingBox(skeleton);
      // fallback in case box is empty
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
  }, [worldLandmarks, selectedMuscle, mannequinModel]);

  // Raycaster for hover
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const handlePointerMove = (e: PointerEvent) => {
      if (!cameraRef.current || !sceneRef.current || !mannequinRef.current) return;

      const rect = mount.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, cameraRef.current);

      const intersects = raycaster.intersectObject(mannequinRef.current, true);
      let found = false;
      for (const hit of intersects) {
        if (
          hit.object instanceof THREE.SkinnedMesh &&
          hit.faceIndex !== undefined &&
          hit.faceIndex !== null
        ) {
          const ids = musclesAtFace(hit.object, hit.faceIndex);
          if (ids && ids.length > 0) {
            setHoveredMuscles({ ids, x: e.clientX - rect.left, y: e.clientY - rect.top });
            found = true;
            break;
          }
        }
      }
      if (!found) {
        setHoveredMuscles(null);
      }
    };

    const handlePointerLeave = () => {
      setHoveredMuscles(null);
    };

    mount.addEventListener("pointermove", handlePointerMove);
    mount.addEventListener("pointerleave", handlePointerLeave);

    return () => {
      mount.removeEventListener("pointermove", handlePointerMove);
      mount.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, []);

  return (
    <div className="absolute inset-0 flex flex-col gap-3">
      <div className="w-full flex-grow min-h-[400px] rounded-lg overflow-hidden border border-gray-200 relative">
        <div ref={mountRef} className="absolute inset-0" />

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 pointer-events-none">
            <p className="text-gray-500 font-medium">3Dモデルを読み込み中...</p>
          </div>
        )}

        {loadError && !isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 pointer-events-none">
            <p className="text-red-500 font-medium">モデルの読み込みに失敗しました</p>
          </div>
        )}

        {!isLoading && !loadError && !worldLandmarks && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50/80 pointer-events-none">
            <p className="text-gray-500 font-medium">
              画像をアップロードすると3Dモデルが表示されます
            </p>
          </div>
        )}

        {hoveredMuscles && (
          <div
            className="absolute pointer-events-none bg-gray-900/90 text-white text-xs p-2 rounded shadow-lg transform -translate-x-1/2 -translate-y-full mt-[-10px] whitespace-nowrap z-10"
            style={{ left: hoveredMuscles.x, top: hoveredMuscles.y }}
          >
            {hoveredMuscles.ids.map((id) => {
              const m = muscles.find((m) => m.id === id);
              return m ? (
                <div key={id} className="flex justify-between gap-4">
                  <span>{m.label}</span>
                  <span className="font-mono text-gray-300">
                    {Math.round(m.value * 100)}
                  </span>
                </div>
              ) : null;
            })}
          </div>
        )}
      </div>
      {muscles.length > 0 && (
        <MuscleLegend
          activations={muscles}
          selectedMuscle={selectedMuscle}
          onSelectMuscle={setSelectedMuscle}
        />
      )}
    </div>
  );
};
