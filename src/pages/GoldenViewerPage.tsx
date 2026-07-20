import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import {
  loadMannequin,
  computeSkeletonBoundingBox,
  groundMannequin,
} from "../components/PoseViewer3D/skinnedMannequin";
import {
  applyGoldenRotations,
  exportWorldRotations,
  type GoldenPose,
} from "../components/PoseViewer3D/golden";
import {
  createEditHistory,
  exportGoldenRotations,
  pushHistory,
  redo,
  undo,
  type EditHistory,
} from "../components/PoseViewer3D/goldenEdit";
import { BONE_ALIASES, resolveBoneName } from "../components/PoseViewer3D/retarget";
import {
  buildBodyCapsules,
  checkGoldenRom,
  checkPalmsFlat,
  computeContactClearances,
  detectSelfPenetrations,
  type ContactClearance,
  type PalmCheck,
  type Penetration,
  type RomViolation,
} from "../components/PoseViewer3D/poseValidity";
import { calculateCameraFit } from "../components/PoseViewer3D/cameraFit";
import { GOLDEN_POSES, goldenDataHash } from "./goldenPoses";

/** ビルド識別子（#88）。vite の define が無い環境（vitest 等）は "dev" */
const BUILD_SHA = typeof __GIT_SHA__ !== "undefined" ? __GIT_SHA__ : "dev";

/** 床グリッドの Y 位置（PoseViewer3D と同値） */
const FLOOR_Y = -1;

/** 編集モード（#93）のボーンマーカー色・サイズ */
const EDIT_MARKER_COLOR = 0x38bdf8;
const EDIT_MARKER_SELECTED_COLOR = 0xf59e0b;
const EDIT_MARKER_RADIUS = 0.025;

/** ゲート再計算の debounce（#93 STEP3） */
const GATE_DEBOUNCE_MS = 300;

type Rotations = Record<string, [number, number, number]>;

type SelectedBone = { actualName: string; stdName: string };

type GateReport = {
  romViolations: RomViolation[];
  penetrations: Penetration[];
  contacts: ContactClearance[];
  palms: PalmCheck[];
};

const cloneRotations = (rotations: Rotations): Rotations =>
  Object.fromEntries(
    Object.entries(rotations).map(([k, v]) => [k, [...v] as [number, number, number]])
  );

/** キーの並び順に依存しない値の一致判定（エクスポート結果は BONE_ALIASES 順、
 *  リセット直後の値は golden JSON のキー順で、並びが異なりうるため） */
const sameRotations = (a: Rotations, b: Rotations): boolean => {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, i) => {
    if (key !== bKeys[i]) return false;
    const av = a[key];
    const bv = b[key];
    return av[0] === bv[0] && av[1] === bv[1] && av[2] === bv[2];
  });
};

const EULER_AXES: { index: 0 | 1 | 2; label: string }[] = [
  { index: 0, label: "X" },
  { index: 1, label: "Y" },
  { index: 2, label: "Z" },
];

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

  // --- 編集モード（#93） ---
  const transformControlsRef = useRef<TransformControls | null>(null);
  /** 実ボーン名 → { 標準名, ボーン } のマップ。BONE_ALIASES で解決できたボーンのみ */
  const editableBonesRef = useRef<Map<string, { stdName: string; bone: THREE.Bone }>>(
    new Map()
  );
  /** 実ボーン名 → 選択マーカー Mesh */
  const markerMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  /** マウントエフェクト内のイベントハンドラから最新値を読むための ref（クロージャ陳腐化対策） */
  const editModeRef = useRef(false);
  const rotationsStateRef = useRef<Rotations>({});
  /** ギズモ・スライダーのドラッグ開始時点のスナップショット（確定時の履歴 push 用） */
  const dragStartRotationsRef = useRef<Rotations | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [selectedBone, setSelectedBone] = useState<SelectedBone | null>(null);
  const [rotationsState, setRotationsState] = useState<Rotations>({});
  const [history, setHistory] = useState<EditHistory<Rotations>>(() =>
    createEditHistory()
  );
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [gateReport, setGateReport] = useState<GateReport | null>(null);

  useEffect(() => {
    editModeRef.current = editMode;
  }, [editMode]);
  useEffect(() => {
    rotationsStateRef.current = rotationsState;
  }, [rotationsState]);

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

    // 編集モード（#93）: ボーン回転ギズモ。閲覧モードでは attach 対象が無いため無害
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.mode = "rotate";
    transformControls.space = "local";
    transformControls.enabled = editModeRef.current;
    scene.add(transformControls.getHelper());
    transformControlsRef.current = transformControls;

    const handleDraggingChanged = (event: { value: unknown }) => {
      const dragging = Boolean(event.value);
      if (controlsRef.current) controlsRef.current.enabled = !dragging;
      if (dragging) {
        dragStartRotationsRef.current = rotationsStateRef.current;
        return;
      }
      const before = dragStartRotationsRef.current;
      dragStartRotationsRef.current = null;
      const mannequin = mannequinRef.current;
      if (!before || !mannequin) return;
      const after = exportGoldenRotations(
        mannequin,
        initialQuatsRef.current,
        Object.keys(before)
      );
      if (sameRotations(before, after)) return;
      setHistory((h) => pushHistory(h, before));
      setRotationsState(after);
    };
    transformControls.addEventListener("dragging-changed", handleDraggingChanged);

    // 編集モード（#93）: 関節マーカーへのレイキャストでボーン選択。
    // ギズモ回転や OrbitControls のカメラ回転を終えた mouseup でも click は発火する
    // ため、pointerdown からの移動距離が閾値を超える click は「ドラッグの結果」と
    // みなして選択に使わない（ドラッグ後の別マーカー誤選択を防ぐ）
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const CLICK_DRAG_THRESHOLD_PX = 5;
    let pointerDownPos: { x: number; y: number } | null = null;

    const handlePointerDown = (event: PointerEvent) => {
      pointerDownPos = { x: event.clientX, y: event.clientY };
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);

    const handleMarkerClick = (event: MouseEvent) => {
      if (!editModeRef.current || !cameraRef.current) return;
      if (pointerDownPos) {
        const dx = event.clientX - pointerDownPos.x;
        const dy = event.clientY - pointerDownPos.y;
        if (Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD_PX) return;
      }
      const rect = mount.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, cameraRef.current);
      const markers = Array.from(markerMeshesRef.current.values());
      // intersectObjects は距離昇順（レイ上の最近傍が先頭）にソート済み。
      // マーカーの depthTest: false は描画のみに影響し、この幾何判定には無関係
      const hits = raycaster.intersectObjects(markers, false);
      if (hits.length === 0) return;
      const actualName = hits[0].object.userData.actualName as string;
      const info = editableBonesRef.current.get(actualName);
      if (info) setSelectedBone({ actualName, stdName: info.stdName });
    };
    renderer.domElement.addEventListener("click", handleMarkerClick);

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

        // 編集モード（#93）: BONE_ALIASES で解決できる各ボーンに選択マーカーを
        // 子として追加する（bone.add なので回転・階層移動に自動追従する）
        const boneMap = new Map<string, THREE.Bone>();
        mannequin.traverse((child) => {
          if ((child as THREE.Bone).isBone) boneMap.set(child.name, child as THREE.Bone);
        });
        const boneNames = Array.from(boneMap.keys());
        const markerGeometry = new THREE.SphereGeometry(EDIT_MARKER_RADIUS, 12, 12);
        for (const stdName of Object.keys(BONE_ALIASES)) {
          const actualName = resolveBoneName(stdName, boneNames);
          const bone = actualName ? boneMap.get(actualName) : undefined;
          if (!bone || !actualName) continue;
          const marker = new THREE.Mesh(
            markerGeometry,
            new THREE.MeshBasicMaterial({
              color: EDIT_MARKER_COLOR,
              transparent: true,
              opacity: 0.85,
              depthTest: false,
            })
          );
          marker.userData.actualName = actualName;
          marker.visible = editModeRef.current;
          // メッシュに埋まる肩・肘・股関節等でも常時見えるよう深度テストを切る。
          // ギズモの renderOrder は Infinity（TransformControlsGizmo 既定）なので
          // 999 のままでギズモより奥・メッシュより手前を保てる
          marker.renderOrder = 999;
          bone.add(marker);
          editableBonesRef.current.set(actualName, { stdName, bone });
          markerMeshesRef.current.set(actualName, marker);
        }

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
      renderer.domElement.removeEventListener("click", handleMarkerClick);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      transformControls.removeEventListener("dragging-changed", handleDraggingChanged);
      transformControls.dispose();
      mount.removeChild(renderer.domElement);
      renderer.dispose();
      cameraRef.current = null;
      controlsRef.current = null;
      transformControlsRef.current = null;
      mannequinRef.current = null;
      editableBonesRef.current = new Map();
      markerMeshesRef.current = new Map();
    };
  }, []);

  // ポーズ適用（選択変更・ロード完了時）
  useEffect(() => {
    const mannequin = mannequinRef.current;
    const golden = GOLDEN_POSES.find((g) => g.pose === selected);
    if (status !== "ready" || !mannequin || !golden) return;

    applyGoldenRotations(mannequin, initialQuatsRef.current, golden);
    // 編集モード中はドラッグ確定のたびに視点・モデル位置が飛ぶため、
    // 接地とカメラ自動フィットは編集 OFF の時だけ行う（#93）
    if (!editModeRef.current) groundMannequin(mannequin, FLOOR_Y);

    // 診断フック（#88 dev 専用）: メインページの適用結果とボーン単位で
    // 突合するため、この画面の world 回転をエクスポートできるようにする
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__goldenDebug = {
        pose: golden.pose,
        exportRotations: () => exportWorldRotations(mannequin),
      };
    }

    if (editModeRef.current) return;

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

  // 編集モードに入った・編集中にポーズを切り替えた時に編集値を現行 JSON へ
  // リセットする（レンダー中に前回値と比較して調整する公式パターン。
  // useEffect + setState だと cascading render の lint 警告になるため使わない）
  const editSessionKey = editMode && current ? `edit:${current.pose}` : "view";
  const [prevEditSessionKey, setPrevEditSessionKey] = useState(editSessionKey);
  if (editSessionKey !== prevEditSessionKey) {
    setPrevEditSessionKey(editSessionKey);
    setSelectedBone(null);
    if (editMode && current) {
      setRotationsState(cloneRotations(current.rotations));
      setHistory(createEditHistory());
      setGateReport(null);
    }
  }

  // 編集値をマネキンへ反映（ギズモドラッグ中はギズモ自身が bone.quaternion を
  // 直接動かすので、ここは undo/redo/リセット/スライダー確定時のみ再適用される）
  useEffect(() => {
    const mannequin = mannequinRef.current;
    if (!editMode || status !== "ready" || !mannequin || !current) return;
    applyGoldenRotations(mannequin, initialQuatsRef.current, {
      ...current,
      rotations: rotationsState,
    });
  }, [rotationsState, editMode, status, current]);

  // 編集モードのオン/オフでマーカー表示とギズモの有効状態を切り替える
  useEffect(() => {
    for (const marker of markerMeshesRef.current.values()) {
      marker.visible = editMode;
    }
    if (transformControlsRef.current) {
      transformControlsRef.current.enabled = editMode;
      if (!editMode) transformControlsRef.current.detach();
    }
  }, [editMode]);

  // 選択ボーンの変化でギズモの attach 先とマーカー色を更新
  useEffect(() => {
    const controls = transformControlsRef.current;
    if (controls) {
      const info = selectedBone
        ? editableBonesRef.current.get(selectedBone.actualName)
        : null;
      if (info) controls.attach(info.bone);
      else controls.detach();
    }
    for (const [actualName, marker] of markerMeshesRef.current.entries()) {
      const material = marker.material as THREE.MeshBasicMaterial;
      material.color.set(
        actualName === selectedBone?.actualName
          ? EDIT_MARKER_SELECTED_COLOR
          : EDIT_MARKER_COLOR
      );
    }
  }, [selectedBone]);

  // ゲート再計算（#93 STEP3）: 編集値が確定するたびに 300ms debounce で再計算
  const recomputeGateReport = useCallback(() => {
    const mannequin = mannequinRef.current;
    if (!current || !mannequin) return;
    groundMannequin(mannequin, FLOOR_Y);
    const editedGolden: GoldenPose = { ...current, rotations: rotationsState };
    setGateReport({
      romViolations: checkGoldenRom(editedGolden),
      penetrations: detectSelfPenetrations(buildBodyCapsules(mannequin)),
      contacts: computeContactClearances(mannequin, current.contacts ?? [], FLOOR_Y),
      palms: checkPalmsFlat(mannequin, current.palmsDown ?? []),
    });
  }, [current, rotationsState]);

  useEffect(() => {
    if (!editMode || status !== "ready") return;
    const timer = setTimeout(recomputeGateReport, GATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [editMode, status, recomputeGateReport]);

  const handleUndo = () => {
    const result = undo(history, rotationsState);
    if (!result) return;
    setHistory(result.history);
    setRotationsState(result.current);
  };

  const handleRedo = () => {
    const result = redo(history, rotationsState);
    if (!result) return;
    setHistory(result.history);
    setRotationsState(result.current);
  };

  const handleResetToGolden = () => {
    if (!current) return;
    setHistory((h) => pushHistory(h, rotationsState));
    setRotationsState(cloneRotations(current.rotations));
  };

  const beginAxisEdit = () => {
    dragStartRotationsRef.current = rotationsState;
  };

  const commitAxisEdit = () => {
    const before = dragStartRotationsRef.current;
    dragStartRotationsRef.current = null;
    if (!before || sameRotations(before, rotationsStateRef.current)) return;
    setHistory((h) => pushHistory(h, before));
  };

  const updateSelectedAxis = (axisIndex: 0 | 1 | 2, value: number) => {
    if (!selectedBone) return;
    setRotationsState((prev) => {
      const cur = prev[selectedBone.stdName] ?? [0, 0, 0];
      const next: [number, number, number] = [...cur];
      next[axisIndex] = value;
      return { ...prev, [selectedBone.stdName]: next };
    });
  };

  const handleCopyJson = async () => {
    const mannequin = mannequinRef.current;
    if (!current || !mannequin) return;
    const exported: GoldenPose = {
      ...current,
      rotations: exportGoldenRotations(
        mannequin,
        initialQuatsRef.current,
        Object.keys(current.rotations)
      ),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(exported, null, 2));
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
    setTimeout(() => setCopyStatus("idle"), 2000);
  };

  const selectedEuler = selectedBone
    ? (rotationsState[selectedBone.stdName] ?? [0, 0, 0])
    : null;

  return (
    <div className="relative w-screen h-screen">
      <div ref={mountRef} className="absolute inset-0" />
      <div className="absolute top-4 left-4 flex flex-col gap-2 max-w-xs max-h-[92vh] overflow-y-auto pr-1">
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
        <button
          type="button"
          onClick={() => setEditMode((v) => !v)}
          className={`self-start px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            editMode
              ? "bg-amber-500 text-white"
              : "bg-white/80 text-gray-800 hover:bg-white"
          }`}
        >
          編集{editMode ? ": ON" : ": OFF"}
        </button>
        {editMode && (
          <div className="flex flex-col gap-2 bg-black/40 rounded-md p-2 text-white text-xs">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleUndo}
                disabled={history.past.length === 0}
                className="px-2 py-1 rounded bg-white/80 text-gray-800 hover:bg-white disabled:opacity-40"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={handleRedo}
                disabled={history.future.length === 0}
                className="px-2 py-1 rounded bg-white/80 text-gray-800 hover:bg-white disabled:opacity-40"
              >
                Redo
              </button>
              <button
                type="button"
                onClick={handleResetToGolden}
                className="px-2 py-1 rounded bg-white/80 text-gray-800 hover:bg-white"
              >
                リセット
              </button>
              <button
                type="button"
                onClick={handleCopyJson}
                className="px-2 py-1 rounded bg-white/80 text-gray-800 hover:bg-white"
              >
                JSON コピー
              </button>
            </div>
            {copyStatus === "copied" && (
              <p className="text-emerald-300">コピーしました</p>
            )}
            {copyStatus === "error" && (
              <p className="text-red-300">コピーに失敗しました</p>
            )}
            <p className="text-white/70">
              関節マーカーをクリックして選択 → ギズモかスライダーで回転
            </p>
            {selectedBone && selectedEuler ? (
              <div className="flex flex-col gap-1">
                <p className="font-semibold">選択中: {selectedBone.stdName}</p>
                {EULER_AXES.map(({ index, label }) => (
                  <label key={label} className="flex items-center gap-2">
                    <span className="w-3">{label}</span>
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      step={0.5}
                      value={selectedEuler[index]}
                      onPointerDown={beginAxisEdit}
                      onPointerUp={commitAxisEdit}
                      onChange={(e) => updateSelectedAxis(index, Number(e.target.value))}
                      className="flex-1"
                    />
                    <input
                      type="number"
                      min={-180}
                      max={180}
                      step={0.5}
                      value={selectedEuler[index]}
                      onFocus={beginAxisEdit}
                      onBlur={commitAxisEdit}
                      onChange={(e) => updateSelectedAxis(index, Number(e.target.value))}
                      className="w-16 text-gray-800 rounded px-1"
                    />
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-white/50">未選択</p>
            )}
            {gateReport && (
              <div className="flex flex-col gap-1 border-t border-white/20 pt-2">
                <p
                  className={
                    gateReport.romViolations.length === 0
                      ? "text-emerald-300"
                      : "text-red-300"
                  }
                >
                  ROM 違反: {gateReport.romViolations.length} 件
                </p>
                <p
                  className={
                    gateReport.penetrations.length === 0
                      ? "text-emerald-300"
                      : "text-red-300"
                  }
                >
                  めり込み: {gateReport.penetrations.length} 件
                </p>
                {gateReport.contacts.map((c) => (
                  <p
                    key={c.part}
                    className={c.grounded ? "text-emerald-300" : "text-red-300"}
                  >
                    接地 {c.part}: {c.clearanceM.toFixed(3)}m
                  </p>
                ))}
                {gateReport.palms.map((p) => (
                  <p
                    key={p.side}
                    className={p.flat ? "text-emerald-300" : "text-red-300"}
                  >
                    手のひら {p.side}: {p.tiltDeg.toFixed(1)}°
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
        {current?.description && (
          <p className="text-white/90 text-sm drop-shadow">{current.description}</p>
        )}
        <p className="text-white/60 text-xs">
          ドラッグで回転 / ホイールでズーム / 右ドラッグで平行移動
        </p>
        <p className="text-white/60 text-xs font-mono">
          build {BUILD_SHA}
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
