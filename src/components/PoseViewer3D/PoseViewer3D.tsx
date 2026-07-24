import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { usePoseStore } from "../../store/usePoseStore";
import { computeActivations, aggregateByMuscle, VISIBILITY_GATE } from "./muscles";
import type { RawLandmark } from "./muscles";
import {
  buildBodyCapsules,
  checkGoldenRom,
  checkPalmsFlat,
  checkStability,
  compareLandmarkPoses,
  computeContactClearances,
  detectSelfPenetrations,
  isPenetrationPass,
} from "./poseValidity";
import { fuseLandmarks } from "./fusion";
import { clampHingeJoints } from "./jointLimits";
import { MuscleLegend, type MuscleActivation } from "./MuscleLegend";
import { calculateCameraFit } from "./cameraFit";
import { resolveBoneName } from "./retarget";
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
import {
  applyGoldenRotations,
  diagnosePose,
  exportBoneChildDirs,
  exportWorldRotations,
  scorePose,
  type GoldenPose,
} from "./golden";

/** 床グリッドの Y 位置。マネキンの接地面もここに合わせる（#36） */
const FLOOR_Y = -1;

export const PoseViewer3D: React.FC = () => {
  const mountRef = useRef<HTMLDivElement>(null);
  const landmarks = usePoseStore((s) => s.landmarks);
  const worldLandmarks = usePoseStore((s) => s.worldLandmarks);
  const imageSize = usePoseStore((s) => s.imageSize);
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

  // #61: world landmarks はオクルージョンで x,y が劣化するため、2D landmarks の
  // x,y を similarity 変換で world 座標系へ写像した値に差し替える（z は world）。
  // imageSize が無い（未取得・旧データ）場合は world をそのまま使う。
  // fuseLandmarks はフォールバック時に world と同一参照を返すため、
  // 参照比較で融合成立（fusionApplied）を判定できる。
  const { fusedLandmarks, fusionApplied } = useMemo(() => {
    if (
      !worldLandmarks ||
      worldLandmarks.length === 0 ||
      !landmarks ||
      !imageSize ||
      !Number.isFinite(imageSize.width) ||
      !Number.isFinite(imageSize.height) ||
      imageSize.width <= 0 ||
      imageSize.height <= 0
    ) {
      return { fusedLandmarks: worldLandmarks, fusionApplied: false };
    }
    const fused = fuseLandmarks(
      landmarks,
      worldLandmarks,
      imageSize.width / imageSize.height
    );
    return { fusedLandmarks: fused, fusionApplied: fused !== worldLandmarks };
  }, [landmarks, worldLandmarks, imageSize]);

  // #62: retarget/IK/筋推定へ渡す前に、肘・膝をヒンジ関節としてサニタイズする
  // （逆曲がりミラー・過剰屈曲クランプ）。minDrive は駆動ゲートと揃える
  // （fusion 成立時は minDriveFused でクランプも緩めないと、駆動されるのに
  // クランプされない部位が生じる）。
  const retargetLandmarks = useMemo(
    () =>
      fusedLandmarks
        ? clampHingeJoints(
            fusedLandmarks,
            fusionApplied ? VISIBILITY_GATE.minDriveFused : VISIBILITY_GATE.minDrive
          )
        : fusedLandmarks,
    [fusedLandmarks, fusionApplied]
  );

  const muscles: MuscleActivation[] = useMemo(
    () =>
      retargetLandmarks && retargetLandmarks.length > 0
        ? aggregateByMuscle(computeActivations(retargetLandmarks))
        : [],
    [retargetLandmarks]
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
    // 接触影が無いとマネキンが床から浮いて見えるため影を有効化する（#69）
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.set(2048, 2048);
    // マネキン（原点周辺 ±1.5 程度）と足元の影が収まる範囲に絞って解像度を稼ぐ
    directionalLight.shadow.camera.left = -4;
    directionalLight.shadow.camera.right = 4;
    directionalLight.shadow.camera.top = 4;
    directionalLight.shadow.camera.bottom = -4;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 20;
    scene.add(directionalLight);

    // Grid Floor
    const gridHelper = new THREE.GridHelper(10, 20, 0x000000, 0x000000);
    gridHelper.material.opacity = 0.1;
    gridHelper.material.transparent = true;
    gridHelper.position.y = FLOOR_Y;
    scene.add(gridHelper);

    // 影だけを受ける床面（#69）。グリッド線との z-fight を避けるため僅かに下げる
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.ShadowMaterial({ opacity: 0.3 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = FLOOR_Y - 0.001;
    shadowPlane.receiveShadow = true;
    scene.add(shadowPlane);

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
          if (child instanceof THREE.SkinnedMesh) {
            // 床の接触影を落とす（#69）。スキン変形はバインドポーズの bounds を
            // 越えるため、シャドウカメラ/視錐台カリングでの影欠けを防ぐ
            child.castShadow = true;
            child.frustumCulled = false;
          }
        });

        scene.add(mannequin);
        mannequinRef.current = mannequin;

        // 画像未アップロード時の初期表示でもマネキン全体が枠に収まるよう、
        // ロード直後にカメラをマネキンの bbox に合わせる（脚だけ映る問題の解消）。
        // ボーン基準の bbox だと頭部メッシュ分を含まず視覚中心が上にずれるので、
        // SkinnedMesh の bind-pose geometry bbox を使って視覚的な中心を取る。
        // geometry 属性が未整備の環境（テストのモックローダー等）では
        // setFromObject が投げるため fallback として skeleton bbox を使う。
        mannequin.updateMatrixWorld(true);
        if (cameraRef.current && controlsRef.current) {
          let box: THREE.Box3;
          try {
            box = new THREE.Box3().setFromObject(mannequin);
          } catch {
            box = new THREE.Box3();
          }
          if (box.isEmpty()) {
            let skeleton: THREE.Skeleton | undefined;
            mannequin.traverse((child) => {
              if (!skeleton && child instanceof THREE.SkinnedMesh && child.skeleton) {
                skeleton = child.skeleton;
              }
            });
            if (skeleton) box = computeSkeletonBoundingBox(skeleton);
          }
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

        // ゴールデン指標ハーネス（#72）: dev 専用の window フック。
        // e2e/golden-render.mjs（手付けポーズのレンダー）と
        // e2e/pose-score.mjs（パイプライン出力 vs ゴールデンのスコア算出）が使う。
        if (import.meta.env.DEV) {
          const fitCameraToSkeleton = () => {
            let skeleton: THREE.Skeleton | undefined;
            mannequin.traverse((child) => {
              if (!skeleton && child instanceof THREE.SkinnedMesh && child.skeleton) {
                skeleton = child.skeleton;
              }
            });
            if (!skeleton || !cameraRef.current || !controlsRef.current) return;
            const box = computeSkeletonBoundingBox(skeleton);
            if (box.isEmpty()) return;
            const { position, target } = calculateCameraFit(
              box,
              cameraRef.current.fov,
              undefined,
              cameraRef.current.aspect
            );
            cameraRef.current.position.copy(position);
            controlsRef.current.target.copy(target);
            controlsRef.current.update();
          };
          (window as unknown as Record<string, unknown>).__poseDebug = {
            applyGolden: (golden: GoldenPose) => {
              const unresolved = applyGoldenRotations(
                mannequin,
                initialQuaternionsRef.current,
                golden
              );
              groundMannequin(mannequin, FLOOR_Y);
              fitCameraToSkeleton();
              return { unresolved };
            },
            exportRotations: () => exportWorldRotations(mannequin),
            checkGolden: (golden: GoldenPose) => {
              // ゴールデン品質の定量指標（#84）: ROM 違反 + 自己めり込み。
              // 呼び出し後はゴールデンが表示されたままになる。カメラ再フィット
              // しないと接地後のマネキンがフレーム外に残り、指標A のレンダー
              // 再推定が検出不能になる（#88）
              const unresolved = applyGoldenRotations(
                mannequin,
                initialQuaternionsRef.current,
                golden
              );
              groundMannequin(mannequin, FLOOR_Y);
              fitCameraToSkeleton();
              const rom = checkGoldenRom(golden);
              const penetrations = detectSelfPenetrations(buildBodyCapsules(mannequin));
              // pass 判定は fail severity のみに反応する（warn は pass を落とさない、#128）
              const penetrationPass = isPenetrationPass(penetrations);
              const contacts = computeContactClearances(
                mannequin,
                golden.contacts ?? [],
                FLOOR_Y
              );
              const palms = checkPalmsFlat(mannequin, golden.palmsDown ?? []);
              const stability = checkStability(mannequin, golden.contacts ?? [], FLOOR_Y);
              return {
                rom,
                penetrations,
                penetrationPass,
                contacts,
                palms,
                stability,
                unresolved,
              };
            },
            compareLandmarks: (a: RawLandmark[], b: RawLandmark[]) =>
              compareLandmarkPoses(a, b),
            // 現在表示中のスケルトンの、指定 mixamo ボーンの world 位置と
            // 子方向（#90 診断: 接地修正の角度を計算で出すため）
            boneWorld: (mixamoNames: string[]) => {
              const map = new Map<string, THREE.Bone>();
              mannequin.traverse((c) => {
                if ((c as THREE.Bone).isBone) map.set(c.name, c as THREE.Bone);
              });
              const names = Array.from(map.keys());
              mannequin.updateMatrixWorld(true);
              const out: Record<
                string,
                { pos: [number, number, number]; dir: [number, number, number] | null }
              > = {};
              for (const mn of mixamoNames) {
                const rn = resolveBoneName(mn, names);
                const bone = rn ? map.get(rn) : undefined;
                if (!bone) continue;
                const p = bone.getWorldPosition(new THREE.Vector3());
                let dir: [number, number, number] | null = null;
                if (bone.children[0]) {
                  const cp = bone.children[0].getWorldPosition(new THREE.Vector3());
                  const d = cp.sub(p);
                  if (d.lengthSq() > 1e-10) {
                    d.normalize();
                    dir = [d.x, d.y, d.z];
                  }
                }
                out[mn] = { pos: [p.x, p.y, p.z], dir };
              }
              return out;
            },
            scoreGolden: (golden: GoldenPose) => {
              // 現在のポーズ（パイプライン出力）を先に採取してからゴールデンを
              // 適用する。呼び出し後はゴールデンが表示されたままになる。
              // childDirs も渡し、swing/twist/summary/stats を含む PoseScore を返す（#102）
              const actual = exportWorldRotations(mannequin);
              const childDirs = exportBoneChildDirs(mannequin);
              applyGoldenRotations(mannequin, initialQuaternionsRef.current, golden);
              groundMannequin(mannequin, FLOOR_Y);
              const goldenQ = exportWorldRotations(mannequin);
              return scorePose(goldenQ, actual, childDirs);
            },
            diagGolden: (golden: GoldenPose) => {
              // scoreGolden と同じ手順で採取し、角度差を swing/twist に分解して
              // 返す（#82 診断）。呼び出し後はゴールデンが表示されたままになる
              const actual = exportWorldRotations(mannequin);
              const childDirs = exportBoneChildDirs(mannequin);
              applyGoldenRotations(mannequin, initialQuaternionsRef.current, golden);
              groundMannequin(mannequin, FLOOR_Y);
              const goldenQ = exportWorldRotations(mannequin);
              return diagnosePose(goldenQ, actual, childDirs);
            },
            setView: (azimuthDeg: number, elevationDeg: number) => {
              if (!cameraRef.current || !controlsRef.current) return;
              const target = controlsRef.current.target;
              const dist = cameraRef.current.position.distanceTo(target);
              const az = THREE.MathUtils.degToRad(azimuthDeg);
              const el = THREE.MathUtils.degToRad(elevationDeg);
              cameraRef.current.position.set(
                target.x + dist * Math.sin(az) * Math.cos(el),
                target.y + dist * Math.sin(el),
                target.z + dist * Math.cos(az) * Math.cos(el)
              );
              controlsRef.current.update();
            },
          };
        }
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
      if (import.meta.env.DEV) {
        delete (window as unknown as Record<string, unknown>).__poseDebug;
      }
    };
  }, []);

  // Update pose and colors when landmarks or selectedMuscle change
  useEffect(() => {
    const mannequin = mannequinRef.current;
    if (!mannequin || !retargetLandmarks || retargetLandmarks.length === 0) return;

    // 1. Reset to initial pose
    mannequin.traverse((child) => {
      if ((child as THREE.Bone).isBone) {
        const q = initialQuaternionsRef.current.get(child.name);
        if (q) child.quaternion.copy(q);
      }
    });

    // 2. Apply new pose
    // 融合成立時は駆動ゲートを緩和し、低 visibility の四肢も fused x,y で駆動する（#61）
    applyPoseToSkeleton(
      mannequin,
      retargetLandmarks,
      fusionApplied ? VISIBILITY_GATE.minDriveFused : undefined
    );

    // ゴールデン指標ハーネスの診断用に、駆動へ実際に使った landmark 配列を
    // 露出する（#82。dev 専用・読み取り専用の想定）
    if (import.meta.env.DEV) {
      const dbg = (window as unknown as Record<string, unknown>).__poseDebug;
      if (dbg && typeof dbg === "object") {
        (dbg as Record<string, unknown>).landmarks = retargetLandmarks;
      }
    }

    // Ensure world matrices are updated for bounding box computation
    mannequin.updateMatrixWorld(true);

    // 2.5 Ground: スキン頂点の最下点を床グリッドへスナップ（#36）
    groundMannequin(mannequin, FLOOR_Y);

    // 2.6 接地肢の末端を 2-bone IK で床へ届かせ、めり込みを最終接地で吸収（#41）
    applyContactIK(mannequin, retargetLandmarks, FLOOR_Y);

    // 2.7 前腕・手の胴体めり込みを push-out で解消（#44）
    applyTorsoPushOut(mannequin, retargetLandmarks);
    groundMannequin(mannequin, FLOOR_Y);

    // 3. Apply colors
    const acts = computeActivations(retargetLandmarks);
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
  }, [retargetLandmarks, fusionApplied, selectedMuscle, mannequinModel]);

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
