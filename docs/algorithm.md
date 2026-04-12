# Morpho Blue / MetaMorpho APY Algorithm

This document describes the math behind vault APY computation, deposit impact simulation, and withdrawal impact simulation. It is intended to enable reimplementation in any language.

## 1. Constants

| Name | Value | Description |
|------|-------|-------------|
| TARGET_UTIL | 0.9 (90%) | Target utilization ratio for the IRM adaptive curve |
| STEEPNESS | 4 | Curve steepness factor |
| WAD | 1e18 | Fixed-point scaling factor (18 decimals) |
| SECONDS_PER_YEAR | 31,536,000 | 365 * 24 * 3600 (no leap year, matches Morpho convention) |

## 1.1 Numerical Precision

APY computation uses JavaScript `number` values after converting on-chain `bigint` balances by token decimals.

- First precision loss starts when raw base units exceed `2^53`.
- For 18-decimal tokens, this is `0.009007199254740993` tokens.
- For 6-decimal tokens, this is `9,007,199,254.740992` tokens.

In practice, rounding is usually tiny at first. For 18-decimal assets, approximate token magnitudes where floating spacing reaches:

- `1e-12` tokens at ~`4.72e3` tokens
- `1e-9` tokens at ~`4.84e6` tokens
- `1e-6` tokens at ~`4.95e9` tokens
- `1e-3` tokens at ~`5.07e12` tokens

The implementation emits a one-time warning per market when estimated spacing reaches `1e-6` tokens or higher.

## 2. Single Market APY

### 2.1 Utilization

```
utilization = totalBorrowAssets / totalSupplyAssets
```

Clamped to `[0, 0.9999]`. Values below `0.0001` are treated as `0`.

### 2.2 Error Function

Normalized distance from target utilization. Range: `[-1, +1]`.

```
if utilization <= TARGET_UTIL:
    error = (utilization - 0.9) / 0.9
else:
    error = (utilization - 0.9) / 0.1
```

### 2.3 Curve Multiplier

Piecewise linear function of the error:

```
if utilization <= TARGET_UTIL:
    multiplier = (1 - 1/STEEPNESS) * error + 1
    # = 0.75 * error + 1
    # Range: [0.25, 1.0]
else:
    multiplier = (STEEPNESS - 1) * error + 1
    # = 3 * error + 1
    # Range: [1.0, 4.0]
```

The multiplier is always positive. Below 90% utilization, rates decrease gradually (down to 25% of rateAtTarget). Above 90%, rates spike sharply (up to 4x rateAtTarget).

### 2.4 Borrow Rate and APY

```
ratePerSecond = rateAtTarget / WAD
borrowRatePerSecond = ratePerSecond * multiplier
borrowAPY = exp(borrowRatePerSecond * SECONDS_PER_YEAR) - 1
```

Uses continuous compounding: `exp(rate * time) - 1`.

Clamped to `[0, 8.0]` (0% to 800%).

### 2.5 Supply APY

```
supplyAPY = borrowAPY * utilization * (1 - fee / WAD)
```

Where `fee` is the protocol fee in WAD (e.g., `0.1e18` = 10% fee).

Clamped to `[0, 8.0]`.

### 2.6 Worked Example

Given:
- totalSupplyAssets = 1000 tokens
- totalBorrowAssets = 800 tokens
- rateAtTarget = 3,170,979,198 (WAD-scaled, ~10% APY at 90% util)
- fee = 0

Calculation:
1. utilization = 800 / 1000 = 0.8
2. error = (0.8 - 0.9) / 0.9 = -0.1111
3. multiplier = 0.75 * (-0.1111) + 1 = 0.9167
4. ratePerSecond = 3,170,979,198 / 1e18 = 3.17e-9
5. borrowRate = 3.17e-9 * 0.9167 = 2.906e-9
6. borrowAPY = exp(2.906e-9 * 31536000) - 1 = 0.0963 (9.63%)
7. supplyAPY = 0.0963 * 0.8 * (1 - 0) = 0.0770 (7.70%)

## 3. Vault APY (Weighted Average)

A MetaMorpho vault allocates funds across multiple Morpho Blue markets. The vault APY is the position-weighted average of individual market supply APYs.

```
vaultAPY = sum(supplyAPY_i * vaultSupplyAssets_i) / sum(vaultSupplyAssets_i)
```

Only markets where the vault has a nonzero supply position (`vaultSupplyAssets > 0`) contribute to the average.

If all markets have zero vault supply, the computation is invalid (the vault has no deployed capital).

### 3.1 How vaultSupplyAssets Is Computed

The vault's supply in each market is derived from its share position:

```
vaultSupplyAssets = (vault_supplyShares * market_totalSupplyAssets) / market_totalSupplyShares
```

Where `vault_supplyShares` comes from `Morpho.position(marketId, vaultAddress)`.

## 4. Deposit Simulation

A deposit flows through the vault's **supply queue** in order. Each market absorbs funds up to its cap.

### 4.1 Algorithm

```
function simulateDeposit(markets, depositAmount):
    sim = {}  // marketId -> extra supply amount
    remaining = depositAmount

    for market in supplyQueue (in order):
        if remaining == 0: break
        available = max(0, market.cap - market.vaultSupplyAssets)
        if available == 0: continue
        fill = min(remaining, available)
        sim[market.id] = fill
        remaining -= fill

    return sim
```

### 4.2 Impact on APY

The deposit simulation only modifies `totalSupplyAssets` (increases supply in target markets). It does NOT modify `vaultSupplyAssets` (the vault's weight in the market).

This is a deliberate approximation: the new deposit earns the same rate as existing supply, so the weight adjustment is unnecessary for APY estimation.

The increased supply lowers utilization, which typically lowers both borrow and supply APY.

```
newAPY = weightedVaultApy(markets, depositSim={})
impact = newAPY - currentAPY
impactBps = round(impact * 10000)
```

## 5. Withdrawal Simulation

A withdrawal has two phases:

### 5.1 Phase 1: Idle Assets

Idle assets are vault funds not deployed to any market (`totalAssets - sum(vaultSupplyAssets)`). Withdrawing from idle has no impact on market APYs.

```
fromIdle = min(remaining, idleAssets)
remaining -= fromIdle
```

### 5.2 Phase 2: Withdraw Queue

After idle is exhausted, funds are pulled from markets in **withdraw queue order**. Each market can provide up to the lesser of:
- The vault's supply in that market (`vaultSupplyAssets`)
- Available liquidity (`totalSupplyAssets - totalBorrowAssets`)

```
function simulateWithdrawal(markets, withdrawAmount, idleAssets):
    sim = {}
    remaining = withdrawAmount

    // Phase 1: idle
    fromIdle = min(remaining, idleAssets)
    remaining -= fromIdle

    // Phase 2: markets in withdraw queue order
    for market in withdrawQueue (sorted by withdrawQueueIndex):
        if remaining == 0: break
        liquidity = max(0, market.totalSupplyAssets - market.totalBorrowAssets)
        available = min(market.vaultSupplyAssets, liquidity)
        if available <= 0: continue
        take = min(remaining, available)
        sim[market.id] = take
        remaining -= take

    withdrawable = withdrawAmount - remaining
    return { sim, withdrawable, remaining }
```

### 5.3 Impact on APY

Unlike deposits, withdrawals modify **both** `totalSupplyAssets` AND `vaultSupplyAssets`:

```
for each market in sim:
    simTotalSupply = market.totalSupplyAssets - sim[market.id]
    simVaultSupply = market.vaultSupplyAssets - sim[market.id]
```

This is necessary because a drained market should no longer contribute to the weighted average.

### 5.4 Edge Cases

- **Full drain**: If `withdrawable >= totalVaultAssets` (sum of all vault positions + idle), `newAPY = 0`.
- **Partial withdrawal**: If `remaining > 0`, the withdrawal is partial (`isPartial = true`). This means some of the requested amount cannot be withdrawn due to insufficient liquidity across all markets.
- **Insufficient liquidity**: Markets where borrows equal supply have zero liquidity and are skipped.

### 5.5 Asymmetry with Deposits

| | Modifies totalSupplyAssets | Modifies vaultSupplyAssets |
|---|---|---|
| Deposit | Yes (increases) | No |
| Withdrawal | Yes (decreases) | Yes (decreases) |

This asymmetry is intentional. For deposits, the new capital earns the same rate, so weight adjustment is unnecessary. For withdrawals, removed capital must stop contributing to the weighted average.

## 6. On-Chain Data Requirements

All data is fetched via multicall from three contracts.

### 6.1 MetaMorpho Vault Calls

| Function | Args | Returns | Purpose |
|----------|------|---------|---------|
| `supplyQueueLength()` | none | `uint256` | Number of markets in supply queue |
| `withdrawQueueLength()` | none | `uint256` | Number of markets in withdraw queue |
| `totalAssets()` | none | `uint256` | Total vault assets (for idle computation) |
| `supplyQueue(uint256)` | index | `bytes32` | Market ID at supply queue position |
| `withdrawQueue(uint256)` | index | `bytes32` | Market ID at withdraw queue position |
| `config(bytes32)` | marketId | `(uint184 cap, bool enabled, uint64 removableAt)` | Market cap for deposit simulation |

### 6.2 Morpho Blue Singleton Calls

| Function | Args | Returns | Purpose |
|----------|------|---------|---------|
| `market(bytes32)` | marketId | `(uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)` | Market state |
| `position(bytes32, address)` | marketId, vaultAddress | `(uint256 supplyShares, uint128 borrowShares, uint128 collateral)` | Vault's share position |
| `idToMarketParams(bytes32)` | marketId | `(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)` | To find IRM and token |

### 6.3 IRM Adaptive Curve Calls

| Function | Args | Returns | Purpose |
|----------|------|---------|---------|
| `rateAtTarget(bytes32)` | marketId | `int256` | WAD-scaled per-second borrow rate at 90% utilization |

Note: If the IRM address is `0x0000...0000`, the market has no IRM and `rateAtTarget` defaults to 0.

### 6.4 ERC20 Token Calls

| Function | Args | Returns | Purpose |
|----------|------|---------|---------|
| `decimals()` | none | `uint8` | Token decimals for bigint-to-float conversion |

### 6.5 Known Morpho Blue Addresses

| Chain | Chain ID | Address |
|-------|----------|---------|
| Ethereum | 1 | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Base | 8453 | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| HyperEVM | 999 | `0x68e37de8d93d3496ae143f2e900490f6280c57cd` |

## 7. Complete Pseudocode

### 7.1 estimateMarketApy

```pseudocode
function estimateMarketApy(depositAmt, totalSupply, totalBorrows, fee, rateAtTarget):
    supply = totalSupply + depositAmt
    if supply <= 0 or rateAtTarget <= 0:
        return { supplyApy: 0, borrowApy: 0 }

    util = min(totalBorrows / supply, 0.9999)
    if util < 0.0001:
        util = 0

    ratePerSec = rateAtTarget / 1e18

    // Error function
    if util > 0.9:
        err = (util - 0.9) / 0.1
    else:
        err = (util - 0.9) / 0.9

    // Curve multiplier
    if util <= 0.9:
        mult = 0.75 * err + 1
    else:
        mult = 3 * err + 1

    borrowRate = ratePerSec * mult
    borrowApy = clamp(exp(borrowRate * 31536000) - 1, 0, 8.0)
    supplyApy = clamp(borrowApy * util * (1 - fee / 1e18), 0, 8.0)

    return { supplyApy, borrowApy }
```

### 7.2 weightedVaultApy

```pseudocode
function weightedVaultApy(markets, depositSim={}, withdrawalSim={}):
    if markets is empty:
        return 0

    weightedSum = 0
    totalWeight = 0

    for market in markets:
        scale = 10 ^ market.decimals

        // Apply simulations
        simSupply = market.totalSupplyAssets
        if market.id in depositSim:
            simSupply += depositSim[market.id]

        wSim = withdrawalSim[market.id] or 0
        simSupply -= wSim
        simVaultSupply = market.vaultSupplyAssets - wSim

        // Convert to floats
        supply = simSupply / scale
        borrows = market.totalBorrowAssets / scale
        fee = market.fee         // stays WAD-scaled
        rate = market.rateAtTarget  // stays WAD-scaled

        { supplyApy } = estimateMarketApy(0, supply, borrows, fee, rate)
        weight = max(0, simVaultSupply / scale)

        if weight <= 0: continue

        weightedSum += supplyApy * weight
        totalWeight += weight

    if totalWeight <= 0:
        error("Vault has zero supply")

    return weightedSum / totalWeight
```

### 7.3 simulateDeposit

```pseudocode
function simulateDeposit(markets, depositAmount):
    sim = {}
    remaining = depositAmount

    for market in markets:  // supply queue order
        if not market.inSupplyQueue: continue
        if remaining == 0: break

        available = max(0, market.cap - market.vaultSupplyAssets)
        if available == 0: continue

        fill = min(remaining, available)
        sim[market.id] = fill
        remaining -= fill

    return sim
```

### 7.4 simulateWithdrawal

```pseudocode
function simulateWithdrawal(markets, withdrawAmount, idleAssets):
    sim = {}
    remaining = withdrawAmount

    // Phase 1: idle
    if idleAssets > 0:
        fromIdle = min(remaining, idleAssets)
        remaining -= fromIdle

    // Phase 2: withdraw queue (sorted by withdrawQueueIndex)
    withdrawMarkets = markets
        .filter(m => m.inWithdrawQueue and m.withdrawQueueIndex >= 0)
        .sort(by withdrawQueueIndex ascending)

    for market in withdrawMarkets:
        if remaining == 0: break

        liquidity = max(0, market.totalSupplyAssets - market.totalBorrowAssets)
        available = min(market.vaultSupplyAssets, liquidity)
        if available <= 0: continue

        take = min(remaining, available)
        sim[market.id] = take
        remaining -= take

    withdrawable = withdrawAmount - remaining
    return { sim, withdrawable, remaining }
```

### 7.5 computeDepositImpact

```pseudocode
function computeDepositImpact(markets, idleAssets, depositAmount):
    currentApy = weightedVaultApy(markets)
    sim = simulateDeposit(markets, depositAmount)
    newApy = weightedVaultApy(markets, depositSim=sim)
    impact = newApy - currentApy
    impactBps = round(impact * 10000)
    return { currentApy, newApy, impact, impactBps }
```

### 7.6 computeWithdrawalImpact

```pseudocode
function computeWithdrawalImpact(markets, idleAssets, withdrawAmount):
    currentApy = weightedVaultApy(markets)
    { sim, withdrawable, remaining } = simulateWithdrawal(markets, withdrawAmount, idleAssets)

    newApy = weightedVaultApy(markets, withdrawalSim=sim)
    // Full drain: all vault weights become 0 → weightedVaultApy returns 0 naturally

    impact = newApy - currentApy
    impactBps = round(impact * 10000)
    isPartial = remaining > 0
    return { currentApy, newApy, impact, impactBps, isPartial, withdrawableAmount: withdrawable }
```

## 8. Interest Accrual

Morpho Blue accrues interest lazily — `totalSupplyAssets` and `totalBorrowAssets` are only updated on-chain when someone interacts with the market. The `market()` view function returns stored (potentially stale) state.

When fetching market data, the library computes accrued interest locally to correct for staleness:

```pseudocode
function accrueMarketInterest(market, now):
    elapsed = now - market.lastUpdate
    if elapsed <= 0 or market.totalBorrowAssets == 0:
        return unchanged

    borrowRate = computeBorrowRate(market.rateAtTarget, market.totalSupplyAssets, market.totalBorrowAssets)
    interest = market.totalBorrowAssets * taylorCompounded(borrowRate, elapsed) / WAD
    feeAmount = interest * market.fee / WAD

    market.totalBorrowAssets += interest
    market.totalSupplyAssets += interest
    market.totalSupplyShares += feeAmount * market.totalSupplyShares / (market.totalSupplyAssets - feeAmount)
```

Where `taylorCompounded(rate, n)` is a 3rd-order Taylor approximation of `exp(rate * n) - 1`, matching the on-chain implementation.

## 9. Limitations

### 9.1 Point-in-Time rateAtTarget

The Morpho Blue IRM is adaptive: `rateAtTarget` drifts over time based on utilization history. When utilization is above the 90% target, `rateAtTarget` increases; when below, it decreases. The adjustment speed is approximately 50x/year.

All simulations in this library use the **current** `rateAtTarget` value. A large deposit that pushes utilization well below target would, over time, cause `rateAtTarget` to decrease further, compounding the APY reduction beyond the point-in-time estimate. Conversely, a large withdrawal pushing utilization above target would cause `rateAtTarget` to increase.

For small deposits/withdrawals relative to market size, this drift is negligible. For large position changes, the true long-term impact will differ from the instantaneous estimate.

### 9.2 Floating-Point Precision

See section 1.1 for details on numerical precision. The library uses JavaScript `number` (IEEE-754 double) for APY math after converting on-chain `bigint` values. This is sufficient for all practical vault sizes but loses precision for raw balances exceeding `2^53` base units.

### 9.3 Continuous Compounding Approximation

The library uses `exp(rate * time) - 1` for APY computation, while Morpho on-chain uses a 3rd-order Taylor approximation. Both approximate continuous compounding and differ by less than `10^-8` for realistic rates.
