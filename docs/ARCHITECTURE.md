# Architecture

## システム構成 (Architecture Overview)

本システムは React, TypeScript, Vite で構成された Single Page Application (SPA) です。状態管理に Zustand を用い、MediaPipe による姿勢推定（2D/3D）と、Three.js による 3D モデルの描画を行っています。バックエンドサーバは持たず、全ての処理はブラウザ上で完結します（WASMとモデルファイルのみCDNから取得）。

## データフロー (Data Flow)

1. **ユーザー入力 (UI)**
   - ユーザーが `ImageUploader` から画像をアップロードします。
2. **状態管理 (Zustand Store)**
   - `usePoseStore` がアップロードされた画像URL (`imageSrc`) を保持します。
3. **姿勢推定 (MediaPipe)**
   - 画像が読み込まれると、`PoseCanvas` が `usePoseEstimation` フックを通じて `PoseLandmarker.detect()` を呼び出し、画像の推論を行います。
   - 推論結果（2D `landmarks`, 3D `worldLandmarks`）は再び `usePoseStore` に格納されます。
4. **結果の描画 (2D / 3D)**
   - **2D**: `PoseCanvas` が `landmarks` を購読し、元画像の上にオーバーレイとして骨格を描画します。
   - **3D**: `PoseViewer3D` が `worldLandmarks` を購読し、リグ付き人体マネキン（`public/models/mannequin.glb`、UE 系命名スケルトンのスキンメッシュ。原作 [Quaternius](https://quaternius.com/) の human-base、CC0。[Mesh2Motion/mesh2motion-app](https://github.com/Mesh2Motion/mesh2motion-app) の `static/models-variation/human-base.glb` 由来）を Three.js で描画します。ポーズは `retarget.ts` / `skinnedMannequin.ts` の FK ソルバが landmark からボーン回転を解いて適用（回転リターゲット。ADR 0003）。使用筋アクティベーション（`muscles.ts` が関節角度から推定）は頂点カラーでヒートマップ着色され、大腿はバインド空間の前後で四頭筋/ハムストリングスに塗り分けます。ポーズ変化時にはボーン座標群のバウンディングボックスからカメラ距離を自動調整（`cameraFit.ts`）し、見切れを防ぎます。
   - **使用筋の凡例と連動**: `PoseViewer3D` は `aggregateByMuscle` で筋群別アクティベーションを算出し、3Dビューの下に `MuscleLegend` として一覧表示します（EMG 実測ではなく幾何推定）。凡例の筋をクリックすると頂点カラーの再計算で該当部位のみヒート着色（他部位は中立色化）、3D 部位のホバーでは交差 face の頂点 skinIndex から筋群を逆引き（`musclesAtFace`）して筋名ツールチップを表示します。

## ディレクトリ構成と役割 (Directory Structure)

- `src/components/PoseEstimation/`
  - `ImageUploader.tsx`: 画像のドラッグ＆ドロップ、ファイル選択、サイズ上限・形式バリデーションを担当。
  - `PoseCanvas.tsx`: 画像の表示と、MediaPipe による推論トリガー、2D 骨格のオーバーレイ描画を担当。
- `src/components/PoseViewer3D/`
  - `PoseViewer3D.tsx`: Three.js による 3D 空間の構築、カメラコントロール (`OrbitControls`)、ライティング設定を担当。マネキン glb を初回に非同期ロード（ロード中/失敗の状態表示あり）し、`worldLandmarks` 変化時に初期ポーズへリセット→リターゲット→頂点カラー再着色→カメラ自動フィットを行います。凡例クリックの部位ハイライトと Raycaster によるホバーツールチップを制御し、下部に使用筋凡例を表示します。
  - `retarget.ts`: landmark→ボーン回転の純粋関数群。ボーン名のサフィックス一致解決（`resolveBoneName`）、方向→回転（`computeRotation`）、骨盤基底（`computeHipsRotation`）、四肢の対応表（`LIMB_BONE_MAPPINGS`）。
  - `skinnedMannequin.ts`: glb ロード（`loadMannequin`）、vertexColors マテリアル差し替え（`setupMannequinMaterials`）、FK ソルバによるポーズ適用（`applyPoseToSkeleton`）、支配ボーン→筋群対応の頂点カラーヒート（`applyMuscleHeatColors` / `getVertexMuscleId`）、face→筋群逆引き（`musclesAtFace`）、ボーン座標からの bbox 計算（`computeSkeletonBoundingBox`）。筋 ID は `muscles.ts` の正典 ID に一致させる必要があります（ADR 0003）。
  - `muscles.ts`: 関節角度・分節ベクトルから 8 筋群のアクティベーション（0..1）を推定する純粋関数群（`computeActivations` / `aggregateByMuscle`）とヒート色変換（`heatColor`）。`detectSupportLegs` で荷重度を推定し、支持脚側の下肢筋を抗重力で重み付け。重み係数は `LOAD_WEIGHT` 定数に集約。ヒューリスティック（EMG 実測ではない）。
  - `cameraFit.ts`: バウンディングボックスと fov からカメラ位置・注視点を算出する純粋関数 `calculateCameraFit`。
  - `MuscleLegend.tsx`: 使用筋を色付きバーで一覧表示する凡例パネル（3Dビューの外・下に配置）。行クリックで筋を選択トグルし親へ通知します。
- `src/hooks/`
  - `usePoseEstimation.ts`: MediaPipe `PoseLandmarker` の初期化と推論処理をカプセル化。非同期ロードや推論中の競合管理、コンポーネントアンマウント時のリソース解放 (`close()`) を担当。
- `src/store/`
  - `usePoseStore.ts`: Zustand によるグローバルな状態管理。UI 状態（ロード中、エラー等）や推論結果（2D/3D 座標データ）を一元管理します。
- `src/pages/`
  - `HomePage.tsx`: アプリケーションのメイン画面。画像のアップロードUIと3Dビューアを2カラムで並べるレイアウトを担当します。

## どこを触れば何が変わるか (Where to modify)

- **マネキンの見た目（モデル・材質・ヒート着色）を変えたい場合**
  - モデル差し替えは `public/models/mannequin.glb`。同梱アセットは Quaternius 原作の human-base（**CC0**。出典: Mesh2Motion/mesh2motion-app の `static/models-variation/human-base.glb`。ライセンス根拠は同リポジトリ README「Licenses」節・`LICENSE-CC0.MD`・`src/lib/RigModelVariations.ts` の `license: 'CC0'` 表記）。ボーン名は `retarget.ts` の `resolveBoneName` がサフィックス一致（mixamorig 系）→ `BONE_ALIASES` 完全一致（UE 系: pelvis / spine_01 / upperarm_l 等）の順で解決するため、mixamorig 互換・UE 系命名のどちらのスケルトンも受け付けます。材質は `skinnedMannequin.ts` の `setupMannequinMaterials`、部位→筋群の対応は同 `getVertexMuscleId`（`canonicalizeBoneName` で命名を正準化）を変更します。
- **ポーズ再現（リターゲット）の挙動を変えたい場合**
  - `src/components/PoseViewer3D/retarget.ts`（対応表・回転算出）と `skinnedMannequin.ts` の `applyPoseToSkeleton`（適用順・アルゴリズム）を変更します。
- **使用筋の推定ロジック・ヒート色を変えたい場合**
  - `src/components/PoseViewer3D/muscles.ts` の `computeActivations`（関節角度→筋群アクティベーション）や `heatColor`（色域）を変更します。筋群の追加は `MuscleId` / `MUSCLE_LABELS` / `MUSCLE_ORDER` に定義を足します。
- **カメラの初期位置やズーム、回転の設定を変えたい場合**
  - `PoseViewer3D.tsx` 内の `PerspectiveCamera` や `OrbitControls` の設定箇所を変更します。ポーズ変化時の自動フィットの寄り具合（マージン等）は `cameraFit.ts` の `calculateCameraFit` を変更します。
- **姿勢推定モデルを変更・更新したい場合**
  - `src/hooks/usePoseEstimation.ts` の `MODEL_URL`（Google Cloud StorageのURL）や `PoseLandmarker.createFromOptions` に渡すオプションを変更します。
- **画像アップロードの制限（ファイルサイズ・形式）を変えたい場合**
  - `src/components/PoseEstimation/ImageUploader.tsx` を修正します。
- **レイアウトを変更したい場合**
  - `src/pages/HomePage.tsx` の Tailwind CSS クラスを変更します。
