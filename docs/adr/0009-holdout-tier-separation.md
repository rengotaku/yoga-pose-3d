# ADR 0009: pose-score / golden-check の dev / holdout tier 分離

## ステータス

採用（#71 / #104）

## 背景

#71 の Codex 分析（2026-07-21）が次の懸念を指摘した:

> 90%を「現3ポーズ」と「hold-out汎化」の2種類に分ける。ここを飛ばすと、
> 誤ったゴールデンへの過適合または評価式の攻略になります。

現行の 3 ポーズ（tabletop / cross-seat / kneel-sidebend）は、パイプライン改善の
チューニング対象そのものである。今後 #71 の次段階（ヨガプリセット検索 + 複数
仮説導入）で「テスト対象ポーズに直接最適化したプリセット」が生成されると、
pose-score が「本当に汎化して 90%」なのか「チューニング対象への過適合で
90%」なのかを区別できなくなる。

区別するには、**改善作業から隠しておき、汎化確認にのみ使うポーズ集合
（hold-out）** が要る。本 ADR はその枠組み（tier 属性・集計分離・出力
schema）だけを整備する。hold-out ポーズの実データ追加は別 sub-issue（写真
調達が要る）で扱う。

## 決定

### 1. `GoldenPose.tier` フィールド

`src/components/PoseViewer3D/golden.ts` の `GoldenPose` に
`tier?: "dev" | "holdout"` を追加する。

- **デフォルトは `dev`**: 明示指定がない場合、集計側（`pose-score.mjs` /
  `golden-check.mjs` / `e2e/lib/aggregate.mjs`）は `tier` 未指定を `dev` として
  扱う。既存 3 ポーズは `"tier": "dev"` を明示的に JSON へ追加した（省略でも
  同じ扱いになるが、tier の存在自体を読み手に伝えるため明示する）。
- `scorePose` 等の採点ロジック自体は tier を関知しない。`tier` は golden JSON
  のメタデータであり、`PoseScore` の計算（重み・線形換算・階層相関補正）には
  一切影響しない。

### 2. 集計ロジックの純粋関数化（`e2e/lib/aggregate.mjs`）

`pose-score.mjs` は playwright 依存で vitest から直接実行できないため、tier
振り分け・平均計算だけを `e2e/lib/aggregate.mjs` に切り出した:

- `splitByTier(items)`: `tier` フィールドを持つ配列を `{ dev, holdout }` に
  分割する。未指定は `dev` 扱い。
- `averageOf(items, selector)`: 空配列は `null`（コンソールのセクション省略・
  JSON の `null` 出力の両方に使う）。
- `aggregateTotals(totals)`: `{ pose, tier, total }` の配列から
  `averageDev` / `averageHoldout` / `average`（dev+holdout 全体）を返す。

このモジュールは `e2e/lib/aggregate.test.mjs`（vitest）で dev のみ / holdout
のみ / 混在の 3 パターンをテストする。

### 3. `pose-score.mjs` の集計・出力分離

- コンソール `=== summary ===` を `=== summary (dev) ===` /
  `=== summary (holdout) ===` に分割する。**該当ポーズが 0 件のセクションは
  出さない**（hold-out 未追加の現状では holdout セクションは表示されない）。
- `--json` 出力の `schemaVersion` を **2** にバンプする:

  ```jsonc
  {
    "schemaVersion": 2,
    "average": 43.5,       // dev + holdout 全体の単純平均
    "averageDev": 43.5,    // dev のみ（null は該当 0 件）
    "averageHoldout": null,
    "resultsByTier": { "dev": [...], "holdout": [...] },
    "results": [...]       // 後方互換。resultsByTier.dev.concat(holdout) と同一
  }
  ```

  `results`（schemaVersion 1 のフィールド）は残す。既存の hold-out ポーズが
  無い現状では `average === averageDev` かつ `results` は従来と同じ内容になる
  ため、**tier 分離が既存 dev 集計値を変えないことを保証する**（retrograde
  確認済み）。

  **schemaVersion 互換の運用ポリシー**:

  - schemaVersion 1 の consumer が `schemaVersion === 1` を厳密にチェックする実装は、
    現行のリポジトリ内に存在しない（`--json` 出力は成果物であって内部 API ではなく、
    schemaVersion チェックは書き手側の意図表明）。したがって旧 consumer が
    「1 なら受理、2 なら拒否」で動いていても、今回の変更で壊れるのは Claude が
    書いた過去スクリプト等の限られた範囲であり、それらは併せて更新する。
  - **後方互換の実効的な担保**は「`results` フィールドを残す」1 点。旧 consumer は
    `schemaVersion` を無視して `results` だけ読めば動く。この契約は
    `e2e/lib/aggregate.test.mjs` で `results === resultsByTier.dev.concat(holdout)` の
    順序保存も含めて機械的に固定する。
  - **`results` フィールドの廃止条件**（未来の schemaVersion 3）は次のいずれかを
    満たしたときに新 ADR で扱う: (a) `results` を参照している consumer が
    リポジトリ内・ダッシュボード側とも 0 件になった、または (b) hold-out
    ポーズ集合が 5 件以上に増え、dev + holdout を平坦に連結して読む用途が
    実運用上ミスリーディングになる。それまで `results` は維持する。

### 4. `golden-check.mjs` は個別 tier タグのみ追加

golden-check は「合格/不合格」を各ポーズ個別に判定する指標（ROM / めり込み /
接地 / 手のひら向き / 写真整合）であり、複数ポーズを平均するものではない。
そのため集計分離は行わず、`--json` 出力の各 `result` に `tier` フィールドを
追加するにとどめる（`schemaVersion` は同様に 2 にバンプ）。

### 5. 数値目標は本 ADR の対象外

hold-out ポーズでの「汎化 90%」という数値目標は本 ADR / sub-issue #104 の
完了条件に含めない。ヨガプリセット検索 sub-issue（#71 の次段階）で扱う。

## この ADR で意図的にやらないこと

- **hold-out ポーズの実データ追加**: 写真調達が要るため別 sub-issue。
- **`total` の重み・線形 90° 換算・階層相関補正の変更**: ADR 0008 の決定を
  維持する。
- **CI での pose-score / golden-check 実行**: 実写真依存のためローカル実行
  前提は不変（`e2e/golden/sources.local.json` は gitignore 済み）。
- **既存 3 ポーズを holdout に変える**: 既存の 43% 系列との比較性を壊すため
  全て `dev` のまま。

## 影響範囲

- `src/components/PoseViewer3D/golden.ts`: `GoldenPose.tier` の追加
- `src/components/PoseViewer3D/golden.test.ts`: tier の型テスト
- `e2e/golden/{tabletop,cross-seat,kneel-sidebend}.json`: `"tier": "dev"` を明示追加
- `e2e/lib/aggregate.mjs`（新規）+ `e2e/lib/aggregate.test.mjs`（新規）: tier 別集計の純粋関数とテスト
- `e2e/pose-score.mjs`: dev/holdout 分割表示、`--json` schemaVersion 2
- `e2e/golden-check.mjs`: 各 result への tier 付与、`--json` schemaVersion 2
- `e2e/golden/README.md`（新規）: hold-out 追加時の運用手順
- `docs/ARCHITECTURE.md`: 「精度評価 (Golden Metrics)」節に tier 分離を追記

## 未解決事項

- **`results` フィールド廃止（schemaVersion 3）のタイミング**: 上記「決定」節
  の廃止条件 (a)(b) のどちらかを満たした時点で新 ADR を書く。それまで維持。
- **hold-out の合格しきい値**: dev/holdout の乖離をどこまで許容するかは、
  実際に hold-out ポーズが追加されて計測値が出てから検討する。
- **未知 tier 値の扱いは throw**: `"dev" | "holdout" | undefined` 以外は
  `e2e/lib/aggregate.mjs` の `splitByTier` および `pose-score.mjs` /
  `golden-check.mjs` の `normalizeTier` で throw する。`"holdot"` のような
  typo を黙って `dev` に落とすと過適合検出の役割が壊れるため（Codex レビュー
  指摘）。
