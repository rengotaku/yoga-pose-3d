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
   - **visibility ゲーティング（#53）**: MediaPipe はオクルージョンされた関節にも座標を返すが、低 visibility 点の world 座標はほぼハルシネーションのため、しきい値（`muscles.ts` の `VISIBILITY_GATE`: 描画/ボーン駆動 0.3、接地 IK 候補 0.5）で 2D 描画・リターゲット・接地 IK への入力を遮断します。visibility 未満のボーンはバインドポーズ維持、接地候補ゼロなら IK はスキップされ床スナップのみになります。
   - **2D**: `PoseCanvas` が `landmarks` を購読し、元画像の上にオーバーレイとして骨格を描画します。低 visibility の点・結線（両端判定）は描画しません（#53）。
   - **3D**: `PoseViewer3D` が `worldLandmarks` を購読し、リグ付き人体マネキン（`public/models/mannequin.glb`、UE 系命名スケルトンのスキンメッシュ。原作 [Quaternius](https://quaternius.com/) の human-base、CC0。[Mesh2Motion/mesh2motion-app](https://github.com/Mesh2Motion/mesh2motion-app) の `static/models-variation/human-base.glb` 由来）を Three.js で描画します。ポーズは `retarget.ts` / `skinnedMannequin.ts` の FK ソルバが landmark からボーン回転を解いて適用（回転リターゲット。ADR 0003）。体幹の目標回転は `distributeSpineRotation` が Spine/Spine1/Spine2 の 3 ボーンへ角度分配し（#26）、前屈系で腰が鋭く折れるのを防ぎます。骨盤基底は左右股関節距離が胴体長比 0.35 未満に潰れたら hip line を信頼せず「up × spine の水平ベクトル」を X 軸に使ってロール暴走を抑えます（`HIPS_BASIS`、#55）。chord アラインで失われる肩線の捻れ・傾きは spine 軸まわりのツイスト（±60° クランプ）として 3 ボーンへ追加分配します（`computeSpineTwistRotation`、#55）。頭部は「耳中点→鼻」を顔前方とする直交基底で Head ボーンを絶対回転させ（`computeHeadRotation`、#54。肩→鼻の弦は頭部ピッチに不感なため）、手は wrist→(INDEX+PINKY)/2 方向で Hand ボーンを駆動します（#54）。深い後屈（wheel 等）は腹軸の上向き検知でテンプレートの弓アーチをブレンドします（`computeBackbendArchRotations`、#35）。リターゲット後はスキン頂点最下点を床グリッドへスナップして接地させ（`groundMannequin`、#36）、接地肢（landmark 最下点近傍の足先/手首）は 2-bone IK で末端を床へ届かせます（`ik.ts`、#41。リーチ不足時は胴体を下げて吸収）。膝立ち（腿がほぼ鉛直で膝が床付近）の脚は足首 IK でなく専用処理で膝を床へ下ろし、すねを床平行へ倒します（#43）。胴体はカプセル近似され、めり込んだ腕の手メッシュを胴体前方向へ push-out して自己衝突を解消します（`collision.ts`、#44）。使用筋アクティベーション（`muscles.ts` が関節角度から推定）は頂点カラーでヒートマップ着色され、大腿はバインド空間の前後で四頭筋/ハムストリングスに塗り分けます。ポーズ変化時にはボーン bbox の縦横を視錐台（縦 fov + アスペクト比）にフィットさせてカメラ距離を自動調整（`cameraFit.ts`、#27）し、見切れなく大きく映します。
   - **使用筋の凡例と連動**: `PoseViewer3D` は `aggregateByMuscle` で筋群別アクティベーションを算出し、3Dビューの下に `MuscleLegend` として一覧表示します（EMG 実測ではなく幾何推定）。凡例の筋をクリックすると頂点カラーの再計算で該当部位のみヒート着色（他部位は中立色化）に加え、頂点属性 `emissionIntensity`（`onBeforeCompile` のシェーダ注入で参照）により選択筋のみエミッシブ発光します（#28）。3D 部位のホバーでは交差 face の頂点 skinIndex から筋群を逆引き（`musclesAtFace`）して筋名ツールチップを表示します（ボーン命名は `canonicalizeBoneName` で mixamorig 系へ正準化してから筋群判定）。

5. **回帰検証（手動実行）**
   - `make verify-poses` が `e2e/poses/` の代表ポーズ画像（逆転・深い後屈・アームバランス。出典/ライセンスは `e2e/poses/SOURCES.md`）をアップロードし、3D マネキンのスクショを `e2e/output/` に生成します（playwright。dev サーバ起動が前提、CI には含めません）。判定は目視です。

## ディレクトリ構成と役割 (Directory Structure)

- `src/components/PoseEstimation/`
  - `ImageUploader.tsx`: 画像のドラッグ＆ドロップ、ファイル選択、サイズ上限・形式バリデーションを担当。
  - `PoseCanvas.tsx`: 画像の表示と、MediaPipe による推論トリガー、2D 骨格のオーバーレイ描画を担当。
- `src/components/PoseViewer3D/`
  - `PoseViewer3D.tsx`: Three.js による 3D 空間の構築、カメラコントロール (`OrbitControls`)、ライティング設定を担当。マネキン glb を初回に非同期ロード（ロード中/失敗の状態表示あり）し、`worldLandmarks` 変化時に初期ポーズへリセット→リターゲット→頂点カラー再着色→カメラ自動フィットを行います。凡例クリックの部位ハイライトと Raycaster によるホバーツールチップを制御し、下部に使用筋凡例を表示します。
  - `retarget.ts`: landmark→ボーン回転の純粋関数群。ボーン名のサフィックス一致解決（`resolveBoneName`）、方向→回転（`computeRotation`）、骨盤基底（`computeHipsRotation`。股関節距離の退化時は up × spine 水平フォールバック: `HIPS_BASIS`、#55）、四肢の対応表（`LIMB_BONE_MAPPINGS`）、後屈分類と弓アーチ回転（`computeBackbendAmount` / `computeBackbendArchRotations`、#35）、脊椎ツイスト（`computeSpineTwistRotation` / `SPINE_TWIST`、#55）、頭部基底（`computeHeadRotation`、#54）、手方向（`computeHandDirection`、#54）。
  - `skinnedMannequin.ts`: glb ロード（`loadMannequin`）、vertexColors マテリアル差し替え（`setupMannequinMaterials`）、FK ソルバによるポーズ適用（`applyPoseToSkeleton`）、支配ボーン→筋群対応の頂点カラーヒート（`applyMuscleHeatColors` / `getVertexMuscleId`）、face→筋群逆引き（`musclesAtFace`）、ボーン座標からの bbox 計算（`computeSkeletonBoundingBox`）、スキン頂点最下点の床スナップ（`computeLowestPointY` / `groundMannequin`、#36）。筋 ID は `muscles.ts` の正典 ID に一致させる必要があります（ADR 0003）。
  - `ik.ts`: 接地肢の per-limb 2-bone IK（#41）。landmark 最下点近傍の足先/手首を接地と分類（`detectGroundContacts`）し、解析的 2-bone IK（`solveTwoBoneIK`。曲げ平面保存・到達不能クランプ）で末端関節を床 + 実測クリアランス（`computeLimbLowestY`）へ届かせます（`applyContactIK`。リーチ不足時は胴体全体を降下）。膝立ちの脚（膝が床付近かつ腿がほぼ鉛直。坐位は腿の鉛直降下比で除外）は足首 IK を抑止し、thigh 1 関節の回転で膝を床 + クリアランスへ下ろして calf を床平行へ向けます（#43）。
  - `collision.ts`: 胴体との自己衝突回避（#44）。胴体を Spine→Neck のカプセル（半径は胴体支配頂点の radial 距離 95 分位で実測）で近似し、カプセルに触れた腕の手メッシュ前方向侵入量（`computeLimbMinForward`）だけ手首を胴体前方向（pelvis +Z 由来の belly normal）へ押し出して 2-bone IK で再ソルブします（`applyTorsoPushOut`）。radial でなく前方向へ押すのは胸前クロス腕で肘側が側面に固定され radial では過剰補正になるため。接地手と背面（半径 3 割超）の手は対象外。
  - `muscles.ts`: 関節角度・分節ベクトルから 8 筋群のアクティベーション（0..1）を推定する純粋関数群（`computeActivations` / `aggregateByMuscle`）とヒート色変換（`heatColor`）。`detectSupportLegs` で荷重度を推定し、支持脚側の下肢筋を抗重力で重み付け。重み係数は `LOAD_WEIGHT` 定数に集約。ヒューリスティック（EMG 実測ではない）。
  - `cameraFit.ts`: バウンディングボックスと fov からカメラ位置・注視点を算出する純粋関数 `calculateCameraFit`。
  - `MuscleLegend.tsx`: 使用筋を色付きバーで一覧表示する凡例パネル（3Dビューの外・下に配置）。行クリックで筋を選択トグルし親へ通知します。
- `src/hooks/`
  - `usePoseEstimation.ts`: MediaPipe `PoseLandmarker` の初期化と推論処理をカプセル化。非同期ロードや推論中の競合管理、コンポーネントアンマウント時のリソース解放 (`close()`) を担当。
- `src/store/`
  - `usePoseStore.ts`: Zustand によるグローバルな状態管理。UI 状態（ロード中、エラー等）や推論結果（2D/3D 座標データ）を一元管理します。
- `src/pages/`
  - `HomePage.tsx`: アプリケーションのメイン画面。画像アップロードと 3D ビューアを縦積みで配置します。3D マネキンブロックは初期折りたたみで、ポーズ推定完了時に自動展開してブロックを画面中央へスクロールします（#59。手動トグルは新しい推定結果が来ると失効する導出 state 設計）。

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
