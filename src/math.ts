/**
 * Pure APY math for Morpho Blue / MetaMorpho vaults.
 * No external dependencies — fully unit-testable.
 */
import type { MarketApyDetail, MarketForApy, MarketImpactDetail, VaultApyDetailed } from './types.js'

export type { MarketApyDetail, MarketForApy, MarketImpactDetail, VaultApyDetailed } from './types.js'

const TARGET_UTIL = 0.9
const STEEPNESS = 4
const WAD = 1e18
const SECONDS_PER_YEAR = 365 * 24 * 3600 // 365-day year, no leap year — matches Morpho convention
const PRECISION_WARNING_TOKEN_SPACING = 1e-6
const PRECISION_WARNED_MARKETS = new Set<string>()

function estimateTokenSpacing(rawAmount: bigint, decimals: number): number {
  const abs = rawAmount < 0n ? -rawAmount : rawAmount
  if (abs === 0n) return 0
  const bitLength = abs.toString(2).length
  if (bitLength <= 53) return 0
  const spacingRaw = 2 ** (bitLength - 53)
  return spacingRaw / Math.pow(10, decimals)
}

function warnIfPrecisionRisk(marketId: string, decimals: number, simSupply: bigint, simVaultSupply: bigint): void {
  if (PRECISION_WARNED_MARKETS.has(marketId)) return
  const supplySpacing = estimateTokenSpacing(simSupply, decimals)
  const vaultSpacing = estimateTokenSpacing(simVaultSupply, decimals)
  const spacing = Math.max(supplySpacing, vaultSpacing)
  if (spacing < PRECISION_WARNING_TOKEN_SPACING) return

  PRECISION_WARNED_MARKETS.add(marketId)
  console.warn(
    `[morpho-apy] Potential floating-point precision loss for market ${marketId}: ` +
      `number spacing is ~${spacing.toExponential(2)} tokens at current magnitudes.`,
  )
}

/** Normalized distance from target utilization. Range: [-1, +1]. */
function _error(util: number): number {
  if (util > TARGET_UTIL) {
    return (util - TARGET_UTIL) / (1 - TARGET_UTIL)
  }
  return (util - TARGET_UTIL) / TARGET_UTIL
}

/** IRM rate multiplier at a given utilization. Always positive. */
function _curveMultiplier(util: number): number {
  const err = _error(util)
  if (util <= TARGET_UTIL) {
    return (1 - 1 / STEEPNESS) * err + 1 // 0.75 * err + 1
  }
  return (STEEPNESS - 1) * err + 1 // 3 * err + 1
}

/**
 * Compute supply and borrow APY for a single Morpho Blue market.
 *
 * @param depositAmt - Extra supply to simulate (0 for current rate). In token units (float).
 * @param totalSupply - Current total supply assets. In token units (float).
 * @param totalBorrows - Current total borrow assets. In token units (float).
 * @param fee - Protocol fee, WAD-scaled (raw bigint converted to number before passing).
 * @param rateAtTarget - Per-second borrow rate at 90% utilisation, WAD-scaled (raw int256 as number).
 */
export function estimateMarketApy(
  depositAmt: number,
  totalSupply: number,
  totalBorrows: number,
  fee: number,
  rateAtTarget: number,
): { supplyApy: number; borrowApy: number } {
  const supply = totalSupply + depositAmt
  if (supply <= 0 || rateAtTarget <= 0) {
    return { supplyApy: 0, borrowApy: 0 }
  }

  let util = Math.min(totalBorrows / supply, 1.0)
  if (util < 0.0001) util = 0

  const ratePerSec = rateAtTarget / WAD
  const borrowRate = ratePerSec * _curveMultiplier(util)
  const borrowApy = Math.max(0, Math.min(Math.exp(borrowRate * SECONDS_PER_YEAR) - 1, 8.0)) // continuous compounding, clamped to [0, 800%]
  const supplyApy = Math.max(0, Math.min(borrowApy * util * (1 - fee / WAD), 8.0))

  return { supplyApy, borrowApy }
}

/**
 * Compute the position-weighted vault APY across all markets,
 * returning per-market details (supplyApy, borrowApy, utilization, allocation).
 *
 * @param markets - All markets (both supply + withdraw queues).
 * @param depositSim - Optional map of { marketId -> extra bigint supply } for deposit simulation.
 * @param withdrawalSim - Optional map of { marketId -> bigint withdrawn } for withdrawal simulation.
 */
export function weightedVaultApyDetailed(
  markets: MarketForApy[],
  depositSim: Record<string, bigint> = {},
  withdrawalSim: Record<string, bigint> = {},
): VaultApyDetailed {
  if (markets.length === 0) return { apy: 0, markets: [] }

  let weightedSum = 0
  let totalWeight = 0

  const suspiciousMarkets = markets.filter((m) => m.rateAtTarget === 0n && m.totalBorrowAssets > 0n)
  if (suspiciousMarkets.length > 0) {
    console.warn(
      `[morpho-apy] ${suspiciousMarkets.length} market(s) have rateAtTarget=0 but non-zero borrows — ` +
        `IRM may not implement rateAtTarget(). APY may be underestimated.`,
    )
  }

  const details: MarketApyDetail[] = []
  const weights: number[] = []

  for (const m of markets) {
    const scale = Math.pow(10, m.decimals)

    // Apply deposit simulation: increase both totalSupplyAssets and vaultSupplyAssets
    const dSim = depositSim[m.marketId] ?? 0n
    let simSupply = m.totalSupplyAssets + dSim

    // Apply withdrawal simulation: decrease both totalSupplyAssets and vaultSupplyAssets
    const wSim = withdrawalSim[m.marketId] ?? 0n
    simSupply = simSupply - wSim
    const simVaultSupply = m.vaultSupplyAssets + dSim - wSim
    warnIfPrecisionRisk(m.marketId, m.decimals, simSupply, simVaultSupply)

    const supply = Number(simSupply) / scale
    const borrows = Number(m.totalBorrowAssets) / scale
    const fee = Number(m.fee) // stays WAD-scaled; /WAD done inside estimateMarketApy
    const rate = Number(m.rateAtTarget) // stays WAD-scaled

    const { supplyApy, borrowApy } = estimateMarketApy(0, supply, borrows, fee, rate)
    const weight = Math.max(0, Number(simVaultSupply) / scale)
    const utilization = supply > 0 ? Math.min(borrows / supply, 1) : 0

    details.push({
      marketId: m.marketId,
      name: m.name,
      supplyApy,
      borrowApy,
      utilization,
      allocationPct: 0, // filled after loop
      vaultSupplyAssets: simVaultSupply,
    })
    weights.push(weight)

    if (weight <= 0) continue

    weightedSum += supplyApy * weight
    totalWeight += weight
  }

  if (totalWeight <= 0) {
    return { apy: 0, markets: details }
  }

  // Fill in allocationPct
  for (let i = 0; i < details.length; i++) {
    details[i].allocationPct = weights[i] / totalWeight
  }

  return { apy: weightedSum / totalWeight, markets: details }
}

/**
 * Compute the position-weighted vault APY across all markets.
 *
 * @param markets - All markets (both supply + withdraw queues).
 * @param depositSim - Optional map of { marketId -> extra bigint supply } for deposit simulation.
 * @param withdrawalSim - Optional map of { marketId -> bigint withdrawn } for withdrawal simulation.
 */
export function weightedVaultApy(
  markets: MarketForApy[],
  depositSim: Record<string, bigint> = {},
  withdrawalSim: Record<string, bigint> = {},
): number {
  return weightedVaultApyDetailed(markets, depositSim, withdrawalSim).apy
}

/**
 * Simulate how a deposit flows through the supply queue and build a depositSim map.
 *
 * Deposits fill each supply-queue market up to its cap, then spill to the next.
 * Returns a Record<marketId, bigint> representing extra supply per market.
 */
export function simulateDeposit(markets: MarketForApy[], depositAmount: bigint): Record<string, bigint> {
  const sim: Record<string, bigint> = {}
  let remaining = depositAmount

  for (const m of markets) {
    if (!m.inSupplyQueue) continue
    if (remaining === 0n) break

    // How much more can this market absorb (vault cap - current vault supply)?
    const available = m.cap > m.vaultSupplyAssets ? m.cap - m.vaultSupplyAssets : 0n
    if (available === 0n) continue

    const fill = remaining < available ? remaining : available
    sim[m.marketId] = fill
    remaining -= fill
  }

  return sim
}

/**
 * Simulate how a withdrawal flows through the withdraw queue.
 *
 * Idle assets are consumed first (no market APY impact), then each withdraw-queue
 * market is drained up to min(vaultSupplyAssets, available liquidity).
 * Returns positive values representing amounts removed per market.
 */
export function simulateWithdrawal(
  markets: MarketForApy[],
  withdrawAmount: bigint,
  idleAssets: bigint,
): { sim: Record<string, bigint>; withdrawable: bigint; remaining: bigint } {
  const sim: Record<string, bigint> = {}
  let remaining = withdrawAmount

  // 1. Consume idle assets first (no market impact)
  if (idleAssets > 0n) {
    const fromIdle = remaining < idleAssets ? remaining : idleAssets
    remaining -= fromIdle
  }

  // 2. Iterate withdraw queue in order
  const withdrawMarkets = markets
    .filter((m) => m.inWithdrawQueue && m.withdrawQueueIndex >= 0)
    .sort((a, b) => a.withdrawQueueIndex - b.withdrawQueueIndex)

  for (const m of withdrawMarkets) {
    if (remaining === 0n) break

    const marketLiquidity = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0n
    const available = m.vaultSupplyAssets < marketLiquidity ? m.vaultSupplyAssets : marketLiquidity
    if (available <= 0n) continue

    const take = remaining < available ? remaining : available
    sim[m.marketId] = take
    remaining -= take
  }

  return { sim, withdrawable: withdrawAmount - remaining, remaining }
}

/**
 * Merge two MarketApyDetail arrays (current vs simulated) into a single
 * array of MarketImpactDetail with nested `current` and `simulated` snapshots.
 */
export function mergeMarketDetails(current: MarketApyDetail[], simulated: MarketApyDetail[]): MarketImpactDetail[] {
  const currentIds = new Set<string>()
  for (const c of current) {
    if (currentIds.has(c.marketId)) {
      throw new Error(`[morpho-apy] Duplicate current marketId in mergeMarketDetails: ${c.marketId}`)
    }
    currentIds.add(c.marketId)
  }

  const simulatedById = new Map<string, MarketApyDetail>()
  for (const s of simulated) {
    if (simulatedById.has(s.marketId)) {
      throw new Error(`[morpho-apy] Duplicate simulated marketId in mergeMarketDetails: ${s.marketId}`)
    }
    simulatedById.set(s.marketId, s)
  }

  return current.map((c) => {
    const s = simulatedById.get(c.marketId)
    if (!s) {
      throw new Error(`[morpho-apy] Missing simulated marketId in mergeMarketDetails: ${c.marketId}`)
    }
    return {
      marketId: c.marketId,
      name: c.name,
      current: {
        supplyApy: c.supplyApy,
        borrowApy: c.borrowApy,
        utilization: c.utilization,
        allocationPct: c.allocationPct,
        vaultSupplyAssets: c.vaultSupplyAssets,
      },
      simulated: {
        supplyApy: s.supplyApy,
        borrowApy: s.borrowApy,
        utilization: s.utilization,
        allocationPct: s.allocationPct,
        vaultSupplyAssets: s.vaultSupplyAssets,
      },
    }
  })
}
