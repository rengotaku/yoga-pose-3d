---
adr: 0012
title: 自己貫通判定の 2 段化 (capsule broad phase + mesh narrow phase) と編集時壁 clamp
status: accepted
superseded_by: null
date: 2026-07-24
issues: [126, 127, 128, 129, 130, 131]
tags: [penetration, capsule, mesh, narrow-phase, tolerance, clamp, gizmo, ik, cross-seat, waiver]
description: penetration ゲートを capsule + tolerance の 1 段から 2 段判定に強化して cross-seat の waivers.penetration を機能で剥がし、/golden 編集時は fail 増加方向へ動けない壁 clamp を導入する。
---

# ADR 0012: 自己貫通判定の 2 段化 (capsule broad phase + mesh narrow phase) と編集時壁 clamp

## 背景

`golden-check` の `penetration` ゲートは capsule 交差 + 単一 `contactToleranceM = 0.03` (3cm 許容) の 1 段判定だったため、cross-seat (あぐら) のように大腿・脛が中央で交差する正当ヨガポーズを false FAIL していた。従来は `e2e/golden/cross-seat.json` に `waivers.penetration` を付けて仕様上通していたが、これは判定側で「触れ合い OK / 突き破り NG」を切り分ける機能が無いための逃げ道だった。

またユーザーから「ポーズを指定する際に、貫通するばあいはそれ以上移動できなくなるとか」という編集時ガードの要件が並行して提示された。

親 issue #126 で codex 相談を経て以下 5 sub-issue に分割し実装:

- #127 (sub A) — 代理形状の再設計 + `EXCLUDED_PAIRS` の縮小
- #128 (sub B) — pair-specific tolerance + warning 段
- #129 (sub C) — mesh narrow phase の 2 段判定
- #130 (sub D) — cross-seat waiver 剥がし + regression
- #131 (sub E) — /golden 編集時 clamp (gizmo / IK)

## 決定

### 代理形状 (sub A)

`CAPSULE_SPECS` (`poseValidity.ts`) を 12 個 → 16 個に拡張:

- 胴体: 単一 `torso` (Spine→Neck) → **`chest` (Spine1→Neck) / `abdomen` (Spine→Spine1) / `pelvis` (Hips→Spine) の 3 分割**
- 手: `hand:L / hand:R` を追加 (`Hand → HandMiddle1` を BONE_ALIASES 経由で解決)
- 既存 (head / upperArm / foreArm / thigh / calf / foot) は据え置き

`SELF_PENETRATION.radiusM` に対応する半径追加 (chest/pelvis 0.13m、abdomen 0.10m 実測、hand 0.04m)。

### `EXCLUDED_PAIRS` の縮小 (sub A + sub D)

「隣接だけ」ではなく **「解剖学的に常時 overlap する transitive 隣接まで」**を除外対象とする:

- 胴体内部 3 分割: `chest|abdomen`, `abdomen|pelvis`, `chest|pelvis` (2-hop transitive)
- 胴体–四肢: `chest|head`, `chest|upperArm:*`, `pelvis|thigh:*`, `abdomen|thigh:*` (2-hop transitive)
- 四肢内: `upperArm|foreArm`, `foreArm|hand`, `thigh|calf`, `calf|foot`

**除外を解除**: `torso|thigh` (旧単一 torso)、`thigh:L|thigh:R` (cross-leg 検出回復)、`head|upperArm` (肩上腕貫通検出回復)。

### pair-specific tolerance + warn/fail 3 帯 (sub B)

`SELF_PENETRATION.perPairToleranceM` に `warnDefault: 0.01`, `failDefault: 0.03`, `overrides: { <pair>: {warn, fail} }` を導入。`Penetration.severity: 'warn' | 'fail'` で 3 帯判定 (`allowed < warn < fail`)。

overrides 初期値 (経験値):

- `calf:R|thigh:L`, `calf:L|thigh:R` (組脚): warn 0.02 / fail 0.05
- `thigh:L|thigh:R` (cross-leg): warn 0.02 / fail 0.16
- `hand:L|hand:R` (合掌): warn 0.02 / fail 0.10
- `foreArm|hand` (腕組み): warn 0.02 / fail 0.07
- `chest|foreArm:*` (合掌前傾): warn 0.02 / fail 0.06

`isPenetrationPass` は **fail 件数 === 0** のみで判定 (warn は情報表示、pass 判定不参加)。golden-check の `--json` 出力は `penetration.warn` フィールドを追加し `violations` は fail のみカウント。/golden UI は fail=赤 / warn=オレンジ で分離表示。

破壊的変更: 旧 `SELF_PENETRATION.contactToleranceM` および `detectSelfPenetrations` の第 2 引数を削除。

### mesh narrow phase 2 段判定 (sub C)

`penetrationNarrowPhase.ts` を新規追加:

- **broad phase** (capsule) の結果のうち `fail 帯 + fail 帯下限 -5mm の warn` ペアのみ narrow phase 再判定
- narrow phase は **自前 AABB による早期リターン + skinned mesh の頂点–三角形距離 (signed)** を計算 (three-mesh-bvh は不採用 = 実測 4ms で予算内)
- 表面距離が正 (実表面は触れていない) なら **`fail → warn` に格下げ + `narrowRefined: true`**
- 表面距離が 0 以下かつ depth が fail 閾値超なら fail 維持

`extractSegmentGeometry` の traverse は **SkinnedMesh のみ** を候補にする (GoldenViewerPage が bone に追加する marker mesh 40+ 個の汚染を防止)。`isStraddledPenetration` は「垂直投射点が三角形内部にある頂点のみ」で判定 (曲面体節の false FAIL 防止)。

### cross-seat の waivers.penetration 剥がし (sub D)

`e2e/golden/cross-seat.json` の `waivers.penetration` を削除。sub A + B + C + 組脚 override で機能的に pass する状態を確認 (`violations = 0`, warn 帯に 5 ペア: thigh:L×calf:R, thigh:L×thigh:R, hand:L×hand:R, foreArm×hand × 2)。他 waiver (`contact.hip / photoAlignment / stability`) は据え置き (別 issue で扱う)。

### 編集時壁 clamp (sub E)

`clampInput.ts` の `tryApplyWithClamp(mannequin, applyDelta)` が現在 pose の fail 件数を baseline、applyDelta 適用後を post として比較。post が増えたら二分探索 (5〜10 反復) で「safe な最大係数」を採用。判定は **broad phase のみ** (60fps 予算保護、narrow phase は debounce 300ms の再計算に任せる)。**warn は clamp トリガに含めない** (正当接触を妨げないため)。

`GoldenViewerPage.tsx` の TransformControls (gizmo) の `onObjectChange` と `ik.ts` の solve loop 出口に統合。clamp 発火時に **赤色フラッシュ 300ms + `blockedPairs` UI パネル**で視覚フィードバック (「clamp: chest × foreArm:R」等)。

## 捨てた案

- **全面 SDF (Signed Distance Field) 導入**: 変形物ごとの SDF 更新コストと closed surface 要件が重い。narrow phase は頂点–三角形距離で足りると判断
- **triangle-triangle 交差ベース**: 包含判定に winding number 併用が必要で複雑度が上がる
- **CCD (Continuous Collision Detection) や topological penetration 検知**: 静的判定では捉えられない完全通過ケースは本親 issue のスコープ外。安全な基準姿勢から中間姿勢を検査する対策も enhancement へ
- **three-mesh-bvh 依存追加**: 自前 AABB で narrow phase 単体 4ms 以下に収まったため不要
- **一律 tolerance の緩和 (0.03 → 0.05 等)**: cross-seat 以外のポーズで false PASS を招く。ペア別 override の方が影響範囲を絞れる
- **clamp トリガに warn を含める**: 合掌前傾など正当な触れ合いを妨げる
- **narrow phase を編集中 (60fps 予算) にも回す**: 実測 100ms 前後の narrow phase では 16ms 予算を超える。debounce 再計算に任せる
- **cross-seat 姿勢を微調整して機械的に fail=0 に**: 判定側で通すのが本親 issue の主旨

## 変えてよい前提 / 壊すと危ない前提

**変えてよい**:

- `SELF_PENETRATION.radiusM` の各 capsule 半径 (実測ベース、モデル変更時に再校正)
- `SELF_PENETRATION.perPairToleranceM.warnDefault` / `failDefault` / `overrides` の値 (経験値、実測分布で校正可能、stability の `marginM` #125 と同じ運用)
- narrow phase の適用対象範囲 (現状 "fail 帯 + fail 直下 5mm warn"、狭める/広げる調整可)
- 編集時 clamp の二分探索反復数 (現状 5〜10、精度と性能のトレードオフ調整可)
- 赤フラッシュ持続時間 (300ms、UX 調整可)

**壊すと危ない**:

- `EXCLUDED_PAIRS` の解剖学的隣接除外 (chest–abdomen / abdomen–pelvis / pelvis–thigh 等)。削除すると全ポーズが常時 false FAIL する
- `Penetration.severity: 'warn' | 'fail'` の 2 値 (pass 判定・golden-check --json・UI 色分け・編集時 clamp すべてが依存)
- `isPenetrationPass` の判定は **fail 件数 === 0 のみ** (warn を混ぜると 3cm 判定より緩くなり false PASS)
- **clamp トリガは fail のみ** (warn を含めると正当接触を妨げ編集不能に近くなる)
- **narrow phase は broad phase の fail 帯 + fail 直下 warn のみに絞る** (全ペアに narrow を回すと `/golden` 300ms debounce 予算を超える)
- **narrow phase の traverse は SkinnedMesh のみを候補にする** (marker mesh 汚染で false PASS/FAIL の両方が起きる)
- `SELF_PENETRATION.perPairToleranceM.overrides` に「実測 depth ≦ fail 閾値」の値を入れる (fail 閾値を実測 depth より低く設定すると意図せず false FAIL 復活)

## 実装のフロー

3 層編成 (Claude 管理 / agy 実装 / codex or code-reviewer sonnet レビュー) の tri-implement で sub A〜E を順次実装。codex は Jul 2026 の usage limit で今週 (Jul 24 以降) 不可のため `code-reviewer` (sonnet) フォールバック。CI runner 未割当 (Actions minutes 枯渇 or 一時 outage) のため `--admin` bypass merge をユーザー明示承認のもと実施 (ローカル `make ci` 全緑を実装ゲートとする)。

## 参照

- Ericson の Real-Time Collision Detection (幾何アルゴリズム標準)
- Eberly の Distance Line3–Line3 (segmentDistance の実装根拠)
- Teschner らの変形物衝突方式概観 (SDF/mesh narrow phase の位置づけ)
- (これらの記述は #126 codex 相談タスクの回答から)

## 関連 ADR

- ADR 0007 (golden-pose-metric): golden-check ゲート全体の設計
- ADR 0011 (gravity-stability-check): stability ゲート導入時の waiver 運用パターン (本 ADR で penetration にも展開)
