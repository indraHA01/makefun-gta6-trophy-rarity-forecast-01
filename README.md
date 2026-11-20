# makefun-gta6-trophy-rarity-forecast-01

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/indraHA01/makefun-gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/indraHA01/makefun-gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecast every GTA VI trophy's earn rate on Exophase at one week after launch — a calibrated rarity forecaster built for make.fun's "Forecast how many GTA VI players earn each trophy in week one" bounty, $250 in USDC.

## The idea

A trophy's earn rate is an adoption curve in log-time, not a number that stays put. Players join over days and progress through a ~50-hour campaign over days, so `logit(rate)` is roughly linear in `ln(1 + days since release)`. The house persistence baseline ignores that and scores ~1.51 on the practice; this entry beats it three ways:

- **Fit the case's own curve.** `main.ts` collapses Exophase's step-wise refreshes into distinct snapshots, fits a least-squares line of `logit(rate)` on log-time per trophy, and reads it at the target. On a two-day final history with real movement, the case's own line does most of the work.
- **Shrink toward a class prior.** Two days cannot identify a seven-day curve alone, so the fit is blended with a prior curve anchored at the trophy's last observed rate and ending at its class's day-7 rate. Classes come from each trophy's own name and description (story chapter, finale, 100% completion, platinum, grind, side mission, light activity), and the day-7 rates are grounded in GTA V's Exophase PS5 page (236,467 players tracked: first story mission 46.9%, mid-story 15–24%, final mission 15.4%, 100% completion 4.6%, platinum 3.75%, collectible sets ~5.4%, explore-all 6.0%), scaled down for week one, when far fewer players have finished the campaign and the tracked population is still diluting with new buyers.
- **Expect the refresh to dilute.** Exophase refreshes in lumps, and a refresh dilutes: launch night's first refresh took tracked players from 638 to 3,868 and every rate but the 100% one fell. When a case's history is perfectly flat and the checkpoint is on launch night, the forecast expects the next refresh to dilute the rates and says so with a wide spread. The story chain is enforced on medians (Chapter 1 ≥ Chapter 2 ≥ … ≥ finale; 100% ≤ finale; platinum ≤ 100%).

## Validation (local, practice cases)

The kit ships no practice answers, so the answers were reconstructed from the facts in `competition.yaml` (04:30Z read: 3,868 players, 4,276 trophies earned; every rate but the 100% one fell), with two alternates that re-weight story vs grind trophies while keeping the exact earned total:

| answers | this entry | house baseline |
| --- | --- | --- |
| proportional reconstruction | **0.349** | 1.405 |
| story-heavy alternate | **0.408** | 1.476 |
| grind-light alternate | **0.428** | 1.508 |

Mean pinball loss on the logit scale; 90% coverage 0.89–0.98 (honest ≈ 0.9). A synthetic final-like case (2.5 days of history, 15 distinct refresh snapshots, known day-7 truth) scores 0.261 with medians tracking the truth (Chapter 1 52.0% vs 52% true, finale 12.0% vs 12%, platinum 0.29% vs 0.30%).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, standard library only, no network, deterministic — two runs write identical bytes. One file, `main.ts`, at the repository root.
