# ADR 0008: pose-score の内訳出力と golden-check の coverage ゲート化

## ステータス

採用（#71 / #102）

## 背景

pose-score（ADR 0007）は導入以来「15 ボーンの world 回転角度差の重み付き平均」
という単一総合値を返してきた。運用してみて次の問題が確認された（#71 コメント
2026-07-21 の Codex 分析）:

1. **world 回転の階層相関**: 骨盤や脊椎の誤差が、腕・頭・脚の world 回転にも
   伝わり、同じ原因が複数回減点される。
2. **twist の過大評価余地**: ボーン方向（swing）は合っていても軸まわり回転
   （twist）で点が下がる。特に細い四肢では見た目の差ほどにはならない。
3. **missing 除外によるスコア上振れ**: 解決不能ボーンを分母から除くため、
   欠損の多い出力が有利になりうる。
4. **接触・接地・自己めり込みを測らない**: 回転が近くても「手が床に着いて
   いない」「腿が交差していない」など体感上重大な差を直接扱わない。

同時に `golden-check.mjs` の指標A（レンダー再推定 vs 実写真）は、自己遮蔽で
比較セグメントが減っても「比較 1/9」でも「平均角度差」で合格判定していた。
kneel-sidebend のように大半のセグメントが遮蔽で除外されるポーズでは、実質
1 セグメントの合致だけで合格を吐き、指標として機能していなかった。

## 決定

### 1. `PoseScore` に内訳フィールドを追加（`golden.ts`）

既存の `total` と `joints[*].angleDeg,score,weight` は**変更しない**（後方互換）。
以下を追加する。

- `joints[*].swingDeg` / `twistDeg` / `swingScore` / `twistScore`
  - `#82` で追加した `diagnosePose` の swing/twist 分解を関節ごとに保持
  - `swingScore` / `twistScore` は `max(0, 1 − deg / 90°)` の線形換算
  - 子ボーンが無い（`exportBoneChildDirs` に該当無しの）関節は 4 フィールドすべて `null`
- `summary`
  - `swingAvg` / `twistAvg`: swing/twist スコアの**重み付き平均**（0〜1、対応関節が
    0 件なら `null`）
  - `coverage`: `{ scored, missing, ratio }`。`ratio = scored / (scored + missing)`
- `stats`
  - 関節スコア（0〜1）の線形補間分位点 `{ p10, median, min }`。関節数 2 未満は
    `total/100` フォールバック

`scorePose(golden, actual, childDirs?)` の第 3 引数は optional。既存呼び出しは
影響を受けず、swing/twist 系のフィールドはすべて `null` になる。UI 側の
`__poseDebug.scoreGolden` は `exportBoneChildDirs` を渡すよう更新した。

### 2. `pose-score.mjs` に内訳と `--json` を追加

- 関節行に swing / twist の度・スコアを併記
- サマリに `swingAvg / twistAvg / coverage / p10 / median / min` を出力
- `--json <path>` オプションで機械可読出力（`schemaVersion: 1`）。
  hold-out ポーズ集計・分位点比較・時系列トラッキングの後段で使う

### 3. `golden-check.mjs` の指標A に coverage ゲートを追加

比較セグメント数と系統数の下限を導入し、以下いずれかで **FAIL** とする:

- 比較セグメント数 `< 4`
- 使用系統数 `< 2`（9 セグメントを 5 系統に集約: `torso / arm:L / arm:R / leg:L / leg:R`）

**閾値の根拠**:
- 4 セグメント: 総 9 セグメントの半数以下では「見えている一部が合っている」の
  域を出ない。少なくとも半数弱の情報がある状態を最低ラインとする（3 では torso
  ＋片腕だけで通り、姿勢判定として弱すぎる。5 では tabletop も落ちうる）
- 2 系統: 単一系統（例: 体幹だけ・片腕だけ）のみでの合格を禁止。全身姿勢の
  合格には少なくとも 2 系統がまたがるべき

FAIL 理由は表示中に `coverage / 品質 / coverage+品質` で区別する。従来の平均・
セグメント別上限（`A_MEAN_MAX_DEG=20°` / `A_SEG_MAX_DEG=35°`）は残す。

`--json <path>` オプションを追加し、rom / めり込み / 接地 / palm / photoMatch の
判定を機械可読で出力する（後段のダッシュボード・分位点集計向け）。

## この ADR で意図的にやらないこと

- **`total` の重み・線形 90° 換算・階層相関の補正は変更しない**。
  Codex 分析の A 優先項目（角度→得点曲線の校正、階層相関補正）は別 sub-issue で
  扱う。本 ADR は「内訳を出す + coverage をゲート化する」までで、単一総合値の
  数値定義は不変（過去計測との比較性を保つため）。
- **接地・衝突を `total` に統合しない**。並記であって統合ではない。単一総合値に
  混ぜると重み論争になる（Codex 分析の指摘）ため、pose-score は回転誤差、
  golden-check は物理拘束、と役割を分けたまま両方を出す。
- **hold-out ポーズを本 ADR で追加しない**。JSON 出力側（`schemaVersion` / pose
  タグを持つ配列）で hold-out 集計を受けられる形にはしたが、ポーズの整備は
  別 sub-issue（Codex 表3「ポーズ数の層化増強」）で扱う。

## 影響範囲

- `src/components/PoseViewer3D/golden.ts`: `JointScore` / `PoseScore` の拡張、
  `scorePose` の第 3 引数追加、`computeStats` の新設
- `src/components/PoseViewer3D/PoseViewer3D.tsx`: `__poseDebug.scoreGolden` が
  `exportBoneChildDirs` を渡すよう変更
- `e2e/pose-score.mjs`: 表示拡張、`--json` オプション
- `e2e/golden-check.mjs`: 指標A の FAIL に coverage ゲート、`--json` オプション

## 未解決事項

- **coverage 閾値の実測ふるい分け**: 現行 3 ポーズで `< 4 segments` が kneel-sidebend
  のみを弾く想定だが、hold-out ポーズ追加後に系統ミックスが変わるため再校正の
  余地あり
- **`total` の階層相関補正**（親骨盤誤差の子孫伝播ペナルティ）と体感校正曲線は
  別 sub-issue で扱う。ADR 0007 の総合値定義を差し替える段階では新 ADR を書く
