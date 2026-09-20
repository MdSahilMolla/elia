# RSEA-Style Benchmark Integration Plan

## Goal
Add held-out generalization testing to elia's self-improvement benchmark loop, following the RSEA (Recursive Self-Evolving Agent) paper.

## Background
RSEA uses **held-out selection**: candidates must pass on a disjoint subset of tasks they were never trained on. This prevents overfitting to the benchmark and ensures improvements generalize.

elia's current benchmark:
- Measures all tasks together
- Has generality probes within each task
- **Lacks explicit train/test split**

## Proposed Changes

### 1. Task Splitting (`src/evolve/split.ts`)
**Create new file** that:
- Loads all benchmark tasks from `suite.ts` and `hardSuite.ts`
- Uses deterministic hash to split ~70/30 into train/held-out sets
- Exports: `splitTasks()`, `getTrainTasks()`, `getHeldOutTasks()`, `isHeldOutTask()`

**Example API:**
```typescript
const { train, heldOut } = splitTasks()
// train → tasks used for in-sample measurement
// heldOut → tasks used for generalization validation
```

### 2. Update Fitness (`src/evolve/fitness.ts`)
**Modify** `measureFitness()` to:
- Accept optional `split` parameter: `{ phase: 'train' | 'heldOut' | 'all' }`
- Return **three scores** instead of one:
  - `trainPassRate`
  - `heldOutPassRate`
  - `overallPassRate`

**Add** comparison logic:
```typescript
export function compareScorecardsWithSplit(
  baseline: { train: Metrics; heldOut: Metrics },
  candidate: { train: Metrics; heldOut: Metrics }
): Comparison
```

**Rules:**
1. **Held-out must not regress** (any drop = rejection)
2. Train can improve slightly or stay flat
3. Overall must improve OR train+heldOut both improve

### 3. Update Engine (`src/evolve/engine.ts`)
**Modify** `evolve()` to:
- Run **two separate benchmark passes** per candidate:
  - Pass 1: Train tasks (measure in-sample learning)
  - Pass 2: Held-out tasks (measure generalization)
- Compare **both passes** before deciding promotion

**Current flow:**
```
baseline → candidate → compareScorecards → promote/reject
```

**New flow:**
```
baseline (train + heldOut) → candidate (train + heldOut) → compareScorecardsWithSplit → promote/reject
```

### 4. Safety Guards (Maintain Current)
- **Immutable benchmark files** remain unchanged
- **Value probes** and **gap checks** remain unchanged
- **Confirmation runs** remain unchanged (run on held-out too)

### 5. CLI (`src/index.ts`)
**Add** commands:
```bash
elia bench --split train     # Train tasks only
elia bench --split heldOut   # Held-out tasks only
elia bench --split all       # All tasks (default)
```

## File Changes Summary

| File | Change | Lines Added |
|------|--------|-------------|
| `src/evolve/split.ts` | NEW FILE | ~80 |
| `src/evolve/fitness.ts` | Modify `measureFitness()`, add `compareScorecardsWithSplit()` | +100 |
| `src/evolve/engine.ts` | Modify `evolve()`, add dual-pass benchmarking | +120 |
| `src/index.ts` | Add `--split` CLI option | +30 |

## Verification

### Test Cases
1. **Overfitting detection**: A candidate that improves train but fails held-out should be rejected
2. **Generalization check**: A candidate that improves both should be promoted
3. **No regression**: A candidate that holds train but regresses held-out should be rejected

### Commands
```bash
# Run full benchmark suite
bun run bench

# Test held-out subset
bun run bench --split heldOut

# Test train subset  
bun run bench --split train
```

## Timeline
1. **Phase 1** (30 min): Create `split.ts` and verify task distribution
2. **Phase 2** (45 min): Modify `fitness.ts` for split scoring
3. **Phase 3** (60 min): Modify `engine.ts` for dual-pass evaluation
4. **Phase 4** (30 min): Update CLI and run tests
5. **Phase 5** (30 min): Dry-run evolve cycle

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| Held-out set too small (1-2 tasks) | Add more tasks to hardSuite if needed |
| Baseline already has poor held-out score | Track separately; allow candidate to recover |
| Confusion about which split is "official" | Document clearly; default to `all` for compatibility |

## Success Criteria
- [ ] `bun test src/evolve` passes
- [ ] `elia bench --split heldOut` runs and reports score
- [ ] Dry-run `elia evolve` validates held-out rejection logic
