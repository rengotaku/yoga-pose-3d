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
  romLimitFor,
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

/** 編集モード（#93）のボーンマーカー色・サイズ。腕・脚は左右でも色を分ける
 *  （右=濃・左=淡。モデルが正面向きだと左右が鏡映になるため色で判別する） */
const EDIT_MARKER_GROUPS = [
  {
    key: "arm-r",
    label: "右腕",
    color: 0x2563eb,
    pattern: /^Right(Shoulder|ForeArm|Arm|Hand)/,
  },
  {
    key: "arm-l",
    label: "左腕",
    color: 0x7dd3fc,
    pattern: /^Left(Shoulder|ForeArm|Arm|Hand)/,
  },
  {
    key: "leg-r",
    label: "右脚",
    color: 0x16a34a,
    pattern: /^Right(UpLeg|Leg|Foot|Toe)/,
  },
  {
    key: "leg-l",
    label: "左脚",
    color: 0xa3e635,
    pattern: /^Left(UpLeg|Leg|Foot|Toe)/,
  },
  { key: "head", label: "頭・首", color: 0xf472b6, pattern: /Neck|Head/ },
  { key: "torso", label: "胴体系", color: 0xc084fc, pattern: /./ }, // Hips / Spine*
] as const;
/** 標準ボーン名から部位系統色を引く（先頭一致優先。torso が包括デフォルト） */
const markerColorFor = (stdName: string): number =>
  EDIT_MARKER_GROUPS.find((g) => g.pattern.test(stdName))?.color ??
  EDIT_MARKER_GROUPS[EDIT_MARKER_GROUPS.length - 1].color;
const EDIT_MARKER_RADIUS = 0.025;
/** 指ボーンは間隔が狭く 0.025 だと塊になるため小さい半径を使う */
const EDIT_MARKER_FINGER_RADIUS = 0.008;
/** 標準ボーン名が指（Thumb/Index/Middle/Ring/Pinky）かどうか */
const isFingerBoneStdName = (stdName: string): boolean =>
  /Thumb|Index|Middle|Ring|Pinky/.test(stdName);
const EDIT_MARKER_OPACITY = 0.85;
/** 選択中マーカーの点滅（ゆっくり）。完全には消さず 1.0↔0.5 をスムーズに振る */
const EDIT_MARKER_BLINK_PERIOD_MS = 2000;
const EDIT_MARKER_BLINK_MIN_OPACITY = 0.5;
const EDIT_MARKER_BLINK_MAX_OPACITY = 1.0;

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

const EULER_AXES: { index: 0 | 1 | 2; label: string; key: "x" | "y" | "z" }[] = [
  { index: 0, label: "X", key: "x" },
  { index: 1, label: "Y", key: "y" },
  { index: 2, label: "Z", key: "z" },
];

/** 軸の ROM 範囲を返す（テーブルに無いボーン/軸は ±180 で実質無制限） */
const romRangeFor = (
  stdName: string,
  axis: "x" | "y" | "z"
): { min: number; max: number } =>
  romLimitFor(stdName)?.[axis] ?? { min: -180, max: 180 };

/** リグを可動域内に制限する: ROM の min/max へクランプした値を返す */
const clampAxisToRom = (
  stdName: string,
  axis: "x" | "y" | "z",
  value: number
): number => {
  const range = romRangeFor(stdName, axis);
  return Math.min(range.max, Math.max(range.min, value));
};

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
  /** 点滅対象（選択中マーカー）。animate ループから毎フレーム参照する */
  const selectedMarkerRef = useRef<THREE.Mesh | null>(null);
  /** マウントエフェクト内のイベントハンドラから最新値を読むための ref（クロージャ陳腐化対策） */
  const editModeRef = useRef(false);
  const rotationsStateRef = useRef<Rotations>({});
  /** ギズモ・スライダーのドラッグ開始時点のスナップショット（確定時の履歴 push 用） */
  const dragStartRotationsRef = useRef<Rotations | null>(null);
  /** ギズモドラッグ中フラグ。ドラッグ最中に前回分の debounce タイマーが発火して
   * groundMannequin がモデル位置を動かすのを防ぐ（ゲート再計算のガードに使う） */
  const isDraggingRef = useRef(false);
  /** マーカー共有の SphereGeometry。アンマウント時に dispose するため ref で控える */
  const markerGeometryRef = useRef<THREE.SphereGeometry | null>(null);
  /** 指マーカー共有の SphereGeometry（小径）。こちらも dispose するため ref で控える */
  const fingerMarkerGeometryRef = useRef<THREE.SphereGeometry | null>(null);

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
      isDraggingRef.current = dragging;
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
      // no-op ドラッグでも state を更新して debounce effect を再駆動する
      // （ドラッグ中に前回分の再計算タイマーがスキップされた場合の取りこぼし防止）
      setRotationsState(after);
      if (sameRotations(before, after)) return;
      setHistory((h) => pushHistory(h, before));
    };
    transformControls.addEventListener("dragging-changed", handleDraggingChanged);

    // リグの制限（#93）: ギズモ操作中も ROM の範囲外へは動かせない。
    // objectChange のたびに bind 相対 Euler を分解し、範囲外の軸をクランプして
    // クォータニオンを組み直す（限界に達するとそれ以上回らない挙動になる）
    const handleObjectChange = () => {
      const bone = transformControls.object as THREE.Bone | undefined;
      if (!bone) return;
      const stdName = bone.userData.stdName as string | undefined;
      const bind = initialQuatsRef.current.get(bone.name);
      if (!stdName || !bind || !romLimitFor(stdName)) return;
      const offset = bind.clone().invert().multiply(bone.quaternion);
      const euler = new THREE.Euler().setFromQuaternion(offset, "XYZ");
      const deg = [
        THREE.MathUtils.radToDeg(euler.x),
        THREE.MathUtils.radToDeg(euler.y),
        THREE.MathUtils.radToDeg(euler.z),
      ];
      const clamped = EULER_AXES.map(({ index, key }) =>
        clampAxisToRom(stdName, key, deg[index])
      );
      if (clamped.every((v, i) => Math.abs(v - deg[i]) < 1e-6)) return;
      const clampedQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(clamped[0]),
          THREE.MathUtils.degToRad(clamped[1]),
          THREE.MathUtils.degToRad(clamped[2]),
          "XYZ"
        )
      );
      bone.quaternion.copy(bind).multiply(clampedQuat);
    };
    transformControls.addEventListener("objectChange", handleObjectChange);

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
        markerGeometryRef.current = markerGeometry;
        // 指は関節間隔が狭く、通常サイズだと指先まで球の塊になるため小径の
        // geometry を別に用意する（共有 geometry が2つになるので dispose も両方行う）
        const fingerMarkerGeometry = new THREE.SphereGeometry(
          EDIT_MARKER_FINGER_RADIUS,
          8,
          8
        );
        fingerMarkerGeometryRef.current = fingerMarkerGeometry;
        for (const stdName of Object.keys(BONE_ALIASES)) {
          const actualName = resolveBoneName(stdName, boneNames);
          const bone = actualName ? boneMap.get(actualName) : undefined;
          if (!bone || !actualName) continue;
          const baseColor = markerColorFor(stdName);
          const marker = new THREE.Mesh(
            isFingerBoneStdName(stdName) ? fingerMarkerGeometry : markerGeometry,
            new THREE.MeshBasicMaterial({
              color: baseColor,
              transparent: true,
              opacity: EDIT_MARKER_OPACITY,
              depthTest: false,
            })
          );
          marker.userData.actualName = actualName;
          marker.userData.baseColor = baseColor;
          marker.visible = editModeRef.current;
          // メッシュに埋まる肩・肘・股関節等でも常時見えるよう深度テストを切る。
          // ギズモの renderOrder は Infinity（TransformControlsGizmo 既定）なので
          // 999 のままでギズモより奥・メッシュより手前を保てる
          marker.renderOrder = 999;
          bone.add(marker);
          // ギズモの ROM クランプ（objectChange）で標準名を逆引きするために持たせる
          bone.userData.stdName = stdName;
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
      // 選択中マーカーをゆっくり点滅させる（opacity を正弦波で振る）
      const blinking = selectedMarkerRef.current;
      if (blinking) {
        const phase =
          (performance.now() % EDIT_MARKER_BLINK_PERIOD_MS) / EDIT_MARKER_BLINK_PERIOD_MS;
        const wave = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
        (blinking.material as THREE.MeshBasicMaterial).opacity =
          EDIT_MARKER_BLINK_MIN_OPACITY +
          (EDIT_MARKER_BLINK_MAX_OPACITY - EDIT_MARKER_BLINK_MIN_OPACITY) * wave;
      }
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
      transformControls.removeEventListener("objectChange", handleObjectChange);
      transformControls.dispose();
      // 関節マーカー（指込みで最大 ~50 個）の material と、共有 geometry（通常・指の
      // 2 種類）を dispose する（SPA 再訪のたびに GPU リソースがリークするのを防ぐ）
      for (const marker of markerMeshesRef.current.values()) {
        marker.parent?.remove(marker);
        (marker.material as THREE.Material).dispose();
      }
      markerGeometryRef.current?.dispose();
      markerGeometryRef.current = null;
      fingerMarkerGeometryRef.current?.dispose();
      fingerMarkerGeometryRef.current = null;
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
    for (const marker of markerMeshesRef.current.values()) {
      const material = marker.material as THREE.MeshBasicMaterial;
      // 選択中も部位系統色のまま（選択は点滅のみで示す）。
      // 点滅途中で選択が外れた場合に備え、opacity を通常値へ戻す
      material.color.set(marker.userData.baseColor as number);
      material.opacity = EDIT_MARKER_OPACITY;
    }
    selectedMarkerRef.current = selectedBone
      ? (markerMeshesRef.current.get(selectedBone.actualName) ?? null)
      : null;
  }, [selectedBone]);

  // ゲート再計算（#93 STEP3）: 編集値が確定するたびに 300ms debounce で再計算
  const recomputeGateReport = useCallback(() => {
    // ドラッグ中に前回分の debounce タイマーが発火すると groundMannequin が
    // モデル位置を動かしてしまうため、ドラッグ終了後の再計算まで見送る
    // (dragging-changed(false) 時の履歴 push で rotationsState が更新され、
    // それを deps に持つこの effect が改めて 300ms 後の再計算をスケジュールする)
    if (isDraggingRef.current) return;
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
    // リグの制限（#93）: ROM の範囲外へは動かせない
    const clamped = clampAxisToRom(
      selectedBone.stdName,
      EULER_AXES[axisIndex].key,
      value
    );
    setRotationsState((prev) => {
      const cur = prev[selectedBone.stdName] ?? [0, 0, 0];
      const next: [number, number, number] = [...cur];
      next[axisIndex] = clamped;
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
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-white/70">
              {EDIT_MARKER_GROUPS.map((g) => (
                <span key={g.key} className="flex items-center gap-1">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full"
                    style={{
                      backgroundColor: `#${g.color.toString(16).padStart(6, "0")}`,
                    }}
                  />
                  {g.label}
                </span>
              ))}
            </div>
            {selectedBone && selectedEuler ? (
              <div className="flex flex-col gap-1">
                <p className="font-semibold">選択中: {selectedBone.stdName}</p>
                {EULER_AXES.map(({ index, label, key }) => {
                  // リグの制限（#93）: スライダー範囲自体を ROM に合わせる
                  const range = romRangeFor(selectedBone.stdName, key);
                  return (
                    <label key={label} className="flex items-center gap-2">
                      <span className="w-3">{label}</span>
                      <input
                        type="range"
                        min={range.min}
                        max={range.max}
                        step={0.5}
                        value={selectedEuler[index]}
                        onPointerDown={beginAxisEdit}
                        onPointerUp={commitAxisEdit}
                        onChange={(e) =>
                          updateSelectedAxis(index, Number(e.target.value))
                        }
                        className="flex-1"
                      />
                      <input
                        type="number"
                        min={range.min}
                        max={range.max}
                        step={0.5}
                        value={selectedEuler[index]}
                        onFocus={beginAxisEdit}
                        onBlur={commitAxisEdit}
                        onChange={(e) =>
                          updateSelectedAxis(index, Number(e.target.value))
                        }
                        className="w-16 text-gray-800 rounded px-1"
                      />
                    </label>
                  );
                })}
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
