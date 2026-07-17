# ADR 0001: MVP 技術スタック（MediaPipe + 素の Three.js + 手続きマネキン）

- **Status**: Accepted (2026-07-17)
- **Context**: 親 [#1](https://github.com/rengotaku/yoga-pose-3d/issues/1) Decision Log #1, #2

## 決定

MVP では次の3点を採る:

1. **姿勢推定 = MediaPipe Tasks Vision (`PoseLandmarker`, `heavy` モデル)**、ブラウザ内 WASM 実行。
2. **3D 描画 = 素の Three.js + `OrbitControls`**、`react-three-fiber` は使わない。
3. **マネキン = 33 点 `worldLandmarks` から手続き生成**（関節=球、肢体=シリンダー、頭部=球）。リアル人体メッシュへのリターゲットはしない。

## 理由

- **バックエンド不要でブラウザ完結できる**（バックエンド運用・GPU コスト・ライセンス手続きが不要）
- **依存を最小に保つ**。3D 表示はコンポーネント1つで完結する規模のため、React ラッパー (`@react-three/fiber`) を挟むメリットが小さい
- **関節回転推定を回避できる**。SMPL リグ付きメッシュへの retarget は inverse kinematics または回転推定モデルが必要で、MVP スコープを超える

## 却下した代替案

- **SMPL 系 (HMR2.0 / 4D-Humans)**: ライセンス登録 + GPU 必須、ブラウザ完結できない
- **`react-three-fiber` 導入**: 依存追加のメリットがコンポーネント規模に見合わない
- **筋肉・解剖学レイヤ**: Muscle & Motion の目玉機能だが MVP 超過（改善バックログ）

## 変えてよい前提 / 壊すと危ない前提

- **変えてよい**: マネキンの見た目（色・太さ・関節サイズ）は `PoseViewer3D.tsx` / `mannequin.ts` の該当箇所のみで完結する
- **壊すと危ない**:
  - `usePoseStore.worldLandmarks` の形状（`Landmark[]` 33 点）を変えると `PoseCanvas` と `PoseViewer3D` の両方が壊れる
  - MediaPipe→Three.js の座標変換ルール（`y = -y`, `z = -z`）を破ると 3D の上下・奥行きが逆転する（`mannequin.ts:27,49-50`）
  - MediaPipe の `worldLandmarks` は hip 原点・メートル単位。他モデルに差し替えるならこの前提を再確認する

## 参照

- 親 issue Decision Log: https://github.com/rengotaku/yoga-pose-3d/issues/1
- 実装: `src/components/PoseViewer3D/mannequin.ts`, `src/components/PoseViewer3D/PoseViewer3D.tsx`
- データフロー: `docs/ARCHITECTURE.md`
