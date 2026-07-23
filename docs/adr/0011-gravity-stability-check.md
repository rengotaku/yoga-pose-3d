# ADR 0011: 重力安定性判定 (stability ゲート) の導入

## ステータス

採用（#116 / #117 / #118 / #119）

## 背景

ゴールデンポーズ（`e2e/golden/<pose>.json`）が「重力を受けたときに実際に保てるか」を数値判定する仕組みが無かった。既存の `golden-check` ゲートは:

- **rom**: 関節可動域
- **penetration**: 自己めり込み（カプセル近似）
- **contact**: 期待接地の床高さ
- **palm**: 手のひら向き
- **photoAlignment**: 実写真との landmark 整合

を評価するが、**力学的な安定性**（COM が支持面内にあるか）は測っていない。そのため「関節可動域と接触は妥当だが、重力を受けたら前に倒れるポーズ」がゴールデンとして通過しうる状態だった。

## 決定

### 1. 準静的モデル (COM ⊂ 支持多角形)

物理シミュレータ（rapier / cannon 等）を使わず、以下の準静的モデルで判定する:

1. **COM 計算 (`computeCOM`)**: Winter (1990) の人体分節質量比（Head 8% / Trunk 50% / UpperArm 3% など）を採用。各セグメントの骨のミッドポイントに質点を置き、加重平均で全身の COM (world 座標) を求める。
2. **支持多角形 (`computeSupportPolygon`)**: 「期待接地集合」と「実接地集合」の**積集合**の水平座標（XZ）を凸包で囲む。
3. **判定 (`checkStability`)**: COM の水平投影が支持多角形の内側にあるかで pass/fail。境界からの符号付き距離（内側正・外側負）と `STABILITY.marginM` を比較する 2 段構え:
   - 支持多角形が縮退（頂点数 < 3）→ 常に `pass: false`（marginM に関わらず）
   - 頂点数 >= 3 のときのみ `distanceToBoundaryM > STABILITY.marginM` を判定

### 2. 期待接地集合は既存 `contacts` フィールドを再利用

新規フィールド `expectedSupports` は追加しない。ゴールデン JSON の既存 `contacts`（「床に接地しているべき部位」）を期待接地集合として再利用し、コンセプト重複を避ける。

**なぜ積集合か**: codex 相談で「実接地集合をそのまま支持面に使うと、腕が偶然床に触れているだけで安定と誤判定する。ポーズ側で"支持として期待する接触"を宣言し、その積集合を取れ」との指摘を受けたため。ポーズの意図と実測の両方が揃った接地点だけを支持点とする。

### 3. golden-check への統合 (`stability` ゲート)

- `e2e/golden-check.mjs` の `VALID_GATES` に `"stability"` を追加
- `--json` の各 result に `stability: { pass, distanceToBoundaryM, comXZ, supportBones }` を追加（`schemaVersion` 2 は据え置き、破壊的変更なし）
- `applyWaivers` の per-pose waiver 機構に stability も乗せ、既存 3 ポーズの調整期間中は waiver で保護できるようにする
- `PoseViewer3D.__poseDebug.checkGolden` にも `stability` を含める（e2e ハーネスとランタイム両方で同じ判定を使う）

### 4. /golden 編集画面での可視化

`GoldenViewerPage.tsx` に「重心/支持面を表示」トグルを追加。`stabilityViz.ts`（新規）が:

- COM 位置に球マーカー（THREE.Mesh、半径 2cm）
- 支持多角形を水平面上に LineLoop で描画（頂点 3 未満は「支持面なし」に fallback、マーカーは赤）
- 境界距離を数値でオーバーレイ表示

を管理する。ポーズ選択時 + 編集中ボーン回転確定時に再計算し、リアクティブに更新する。

**色帯 semantics**（`stabilityBandFor()`、`STABILITY.marginM` の値によらず動く）:

- **safe** (緑): `distance > 0`（COM が支持多角形の内側）
- **warn** (黄): `marginM < distance <= 0`（COM は境界上または少し外側だが gate は pass）
- **danger** (赤): `distance <= marginM`（gate も fail）

`checkStability` の pass 判定 `distance > marginM` と整合させ、境界値ちょうどでの false PASS（可視化で虚偽の緑）を防ぐ。

### 5. `STABILITY.marginM = -0.04` の校正

初期値 `+0.02` (2cm 内側マージン必須) では既存 3 ポーズの多くが fail した。実運用では以下のヒューリスティックを取る:

- **`marginM = -0.04`**: 「境界外側 4cm までは歪みを含むゴールデンでも安定とみなす」
- ただし縮退（支持点 < 3）は marginM に関わらず常に fail（false PASS 対策）

これはゴールデンが landmark → 手付け Euler の粗い再現であり、関節位置が数 cm ずれることを許容する現実的な判断。将来ポーズ追加時に緩すぎないか継続確認する。

## 検討して捨てた案

- **物理シミュライブラリ (rapier / cannon)**: 決定論性が失われ、ゴールデンの再現性を損なう。準静的モデルで十分。
- **`expectedSupports` 新設**: 既存 `contacts` と概念が重複するため不採用。
- **単純な `COM ⊂ polygon` (marginM = 0)**: 境界ちょうどでの微小ノイズで false BLOCK が発生し、既存ゴールデンが実質的に通らない。負 marginM で「境界近傍は許容」する運用にする。
- **色帯を `distance >= marginM = safe`**: `checkStability` の strict `>` と不一致で、境界値ちょうどで可視化が「安定 (緑)」と表示するのに gate は fail する false PASS が発生する。strict `>` に統一。
- **stability を pose-score にも展開**: 本 ADR のスコープ外。パイプライン出力（MediaPipe → mannequin リターゲット結果）は landmark 誤差が大きく、stability 判定が pipeline 精度に埋もれる懸念があるため別 issue で検討。

## 変えてよい前提 / 壊すと危ない前提

- **`STABILITY.marginM = -0.04`** は経験値。ゴールデン品質の向上や新ポーズ追加に合わせて調整可（変更したら CHANGELOG or ADR に記録する）。ただし正値に戻す場合は既存 3 ポーズの `contacts` 再定義・waiver 追加も必要になる。
- **Winter 質量比 (`BODY_SEGMENT_MASS`)** は文献値の粗い網。個体差は考慮しない（#84 の設計方針を踏襲）。総和が 0.98〜1.02 に収まる不変式は単体テストで担保する。
- **支持多角形 = 期待 ∩ 実接地の凸包** の invariant は絶対に壊すな。「実接地集合そのまま」に戻すと、腕の偶然接触で pass する false PASS が復活する。
- **縮退時は常に fail** の invariant も絶対に壊すな。負 marginM で回帰した codex 指摘を再度踏む。
- **色帯 semantics の safe/warn/danger 境界** は `checkStability` と一貫させる（strict `>` vs `>=` を混在させない）。

## 関連

- 実装コア: PR #120（#117・poseValidity.ts に関数群追加）
- ゲート統合: PR #122（#118・golden-check.mjs / PoseViewer3D.tsx へ統合、marginM 校正、cross-seat waiver）
- 可視化: PR #121（#119・GoldenViewerPage で COM/支持多角形の live 描画）
- 親: [#116](https://github.com/rengotaku/yoga-pose-3d/issues/116)
