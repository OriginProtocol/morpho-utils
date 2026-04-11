/**
 * Binary search to find the maximum deposit/withdrawal amount
 * within an APY impact threshold. Pure math — zero external deps.
 */
import { mergeMarketDetails, simulateDeposit, simulateWithdrawal, weightedVaultApyDetailed } from './math.js'
import type {
  DepositImpactResult,
  FindMaxConstraint,
  FindMaxDepositResult,
  FindMaxWithdrawalResult,
  MarketApyDetail,
  MarketForApy,
  VaultApyDetailed,
  WithdrawalImpactResult,
} from './types.js'

function defaultPrecision(markets: MarketForApy[]): bigint {
  const decimals = markets.length > 0 ? markets[0].decimals : 18
  return 10n ** BigInt(decimals) // 1 whole token
}

function computeMaxDepositable(markets: MarketForApy[]): bigint {
  return markets
    .filter((m) => m.inSupplyQueue && m.cap > m.vaultSupplyAssets)
    .reduce((sum, m) => sum + (m.cap - m.vaultSupplyAssets), 0n)
}

function computeMaxWithdrawable(markets: MarketForApy[], idleAssets: bigint): bigint {
  const fromMarkets = markets
    .filter((m) => m.inWithdrawQueue && m.withdrawQueueIndex >= 0)
    .reduce((sum, m) => {
      const liquidity = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0n
      const available = m.vaultSupplyAssets < liquidity ? m.vaultSupplyAssets : liquidity
      return sum + (available > 0n ? available : 0n)
    }, 0n)
  return idleAssets + fromMarkets
}

function buildDepositImpact(
  current: VaultApyDetailed,
  simulated: VaultApyDetailed,
  includeMarkets: boolean,
): DepositImpactResult {
  const impact = simulated.apy - current.apy
  return {
    currentApy: current.apy,
    newApy: simulated.apy,
    impact,
    impactBps: Math.round(impact * 10000),
    markets: includeMarkets ? mergeMarketDetails(current.markets, simulated.markets) : [],
  }
}

function buildWithdrawalImpact(
  current: VaultApyDetailed,
  simulated: VaultApyDetailed,
  withdrawable: bigint,
  remaining: bigint,
  includeMarkets: boolean,
): WithdrawalImpactResult {
  const impact = simulated.apy - current.apy
  return {
    currentApy: current.apy,
    newApy: simulated.apy,
    impact,
    impactBps: Math.round(impact * 10000),
    isPartial: remaining > 0n,
    withdrawableAmount: withdrawable.toString(),
    markets: includeMarkets ? mergeMarketDetails(current.markets, simulated.markets) : [],
  }
}

function zeroDepositImpact(markets: MarketForApy[], includeMarkets: boolean): DepositImpactResult {
  if (markets.length === 0) {
    return { currentApy: 0, newApy: 0, impact: 0, impactBps: 0, markets: [] }
  }
  const current = weightedVaultApyDetailed(markets)
  return buildDepositImpact(current, current, includeMarkets)
}

function zeroWithdrawalImpact(
  markets: MarketForApy[],
  idleAssets: bigint,
  includeMarkets: boolean,
): WithdrawalImpactResult {
  if (markets.length === 0) {
    return { currentApy: 0, newApy: 0, impact: 0, impactBps: 0, isPartial: false, withdrawableAmount: '0', markets: [] }
  }
  const current = weightedVaultApyDetailed(markets)
  return buildWithdrawalImpact(current, current, 0n, 0n, includeMarkets)
}

/**
 * Find the maximum deposit amount within an APY impact threshold using binary search.
 *
 * @param markets - Market data from fetchVaultMarkets
 * @param maxAmount - Ceiling amount in base units
 * @param maxImpactBps - Maximum allowed APY impact in basis points (e.g. 50 = 0.5%)
 * @param options.precision - Search granularity in base units. Default: 1 whole token.
 * @param options.includeMarkets - Include per-market details in impact result. Default: false.
 * @param options.constraint - Custom constraint callback. Must be monotonic: if amount X fails, all X+n must also fail.
 */
export async function findMaxDepositAmount(
  markets: MarketForApy[],
  maxAmount: bigint,
  maxImpactBps: number,
  options?: { precision?: bigint; includeMarkets?: boolean; constraint?: FindMaxConstraint },
): Promise<FindMaxDepositResult> {
  const raw = options?.precision ?? defaultPrecision(markets)
  const step = raw > 0n ? raw : 1n
  const maxImpact = maxImpactBps / 10000
  const incMkts = options?.includeMarkets ?? false
  const constraint = options?.constraint

  if (markets.length === 0 || maxAmount === 0n) {
    return {
      amount: 0n,
      maxPossibleAmount: 0n,
      isMaxAmount: maxAmount === 0n,
      isCapped: false,
      impact: zeroDepositImpact(markets, incMkts),
    }
  }

  const maxPossible = computeMaxDepositable(markets)
  const effectiveMax = maxAmount < maxPossible ? maxAmount : maxPossible

  if (effectiveMax === 0n) {
    return {
      amount: 0n,
      maxPossibleAmount: maxPossible,
      isMaxAmount: false,
      isCapped: maxPossible === 0n,
      impact: zeroDepositImpact(markets, incMkts),
    }
  }

  const current = weightedVaultApyDetailed(markets)

  // Helper: is this amount acceptable (APY impact + custom constraint)?
  async function isAcceptable(amount: bigint): Promise<boolean> {
    const sim = simulateDeposit(markets, amount)
    const simulated = weightedVaultApyDetailed(markets, sim)
    const impact = Math.abs(simulated.apy - current.apy)
    if (impact > maxImpact) return false
    if (!constraint) return true
    return constraint({
      amount,
      currentApy: current.apy,
      simulatedApy: simulated.apy,
      impactBps: Math.round((simulated.apy - current.apy) * 10000),
      markets: mergeMarketDetails(current.markets, simulated.markets),
    })
  }

  // Fast path: full effectiveMax within threshold
  if (await isAcceptable(effectiveMax)) {
    const sim = simulateDeposit(markets, effectiveMax)
    const simulated = weightedVaultApyDetailed(markets, sim)
    return {
      amount: effectiveMax,
      maxPossibleAmount: maxPossible,
      isMaxAmount: effectiveMax === maxAmount,
      isCapped: effectiveMax < maxAmount,
      impact: buildDepositImpact(current, simulated, incMkts),
    }
  }

  // Fast path: even smallest step exceeds threshold
  if (step >= effectiveMax || !(await isAcceptable(step))) {
    return {
      amount: 0n,
      maxPossibleAmount: maxPossible,
      isMaxAmount: false,
      isCapped: false,
      impact: zeroDepositImpact(markets, incMkts),
    }
  }

  // Binary search: lo is within threshold, hi exceeds it
  let lo = step
  let hi = effectiveMax

  while (hi - lo > step) {
    let mid = lo + (hi - lo) / 2n
    mid = (mid / step) * step // snap to precision grid
    if (mid === lo) break

    if (await isAcceptable(mid)) {
      lo = mid
    } else {
      hi = mid
    }
  }

  const sim = simulateDeposit(markets, lo)
  const simulated = weightedVaultApyDetailed(markets, sim)
  return {
    amount: lo,
    maxPossibleAmount: maxPossible,
    isMaxAmount: false,
    isCapped: false,
    impact: buildDepositImpact(current, simulated, incMkts),
  }
}

/**
 * Find the maximum withdrawal amount within an APY impact threshold using binary search.
 *
 * @param markets - Market data from fetchVaultMarkets
 * @param idleAssets - Vault idle assets (undeployed)
 * @param maxAmount - Ceiling amount in base units
 * @param maxImpactBps - Maximum allowed APY impact in basis points (e.g. 50 = 0.5%)
 * @param options.precision - Search granularity in base units. Default: 1 whole token.
 * @param options.includeMarkets - Include per-market details in impact result. Default: false.
 * @param options.constraint - Custom constraint callback. Must be monotonic: if amount X fails, all X+n must also fail.
 */
export async function findMaxWithdrawalAmount(
  markets: MarketForApy[],
  idleAssets: bigint,
  maxAmount: bigint,
  maxImpactBps: number,
  options?: { precision?: bigint; includeMarkets?: boolean; constraint?: FindMaxConstraint },
): Promise<FindMaxWithdrawalResult> {
  const raw = options?.precision ?? defaultPrecision(markets)
  const step = raw > 0n ? raw : 1n
  const maxImpact = maxImpactBps / 10000
  const incMkts = options?.includeMarkets ?? false
  const constraint = options?.constraint

  if (markets.length === 0 || maxAmount === 0n) {
    return {
      amount: 0n,
      maxPossibleAmount: 0n,
      isMaxAmount: maxAmount === 0n,
      isCapped: false,
      impact: zeroWithdrawalImpact(markets, idleAssets, incMkts),
    }
  }

  const maxPossible = computeMaxWithdrawable(markets, idleAssets)
  const effectiveMax = maxAmount < maxPossible ? maxAmount : maxPossible

  if (effectiveMax === 0n) {
    return {
      amount: 0n,
      maxPossibleAmount: maxPossible,
      isMaxAmount: false,
      isCapped: maxPossible === 0n,
      impact: zeroWithdrawalImpact(markets, idleAssets, incMkts),
    }
  }

  const current = weightedVaultApyDetailed(markets)
  const totalVaultAssets = markets.reduce((acc, m) => acc + m.vaultSupplyAssets, 0n) + idleAssets

  // Helper: is this amount acceptable (APY impact + custom constraint)?
  async function isAcceptable(amount: bigint): Promise<boolean> {
    const { sim, withdrawable, remaining } = simulateWithdrawal(markets, amount, idleAssets)
    const isFullDrain = withdrawable >= totalVaultAssets
    const simulated = isFullDrain
      ? { apy: 0, markets: [] as MarketApyDetail[] }
      : weightedVaultApyDetailed(markets, {}, sim)
    const impact = Math.abs(simulated.apy - current.apy)
    if (impact > maxImpact) return false
    if (!constraint) return true
    return constraint({
      amount,
      currentApy: current.apy,
      simulatedApy: simulated.apy,
      impactBps: Math.round((simulated.apy - current.apy) * 10000),
      markets: mergeMarketDetails(current.markets, simulated.markets),
      isPartial: remaining > 0n,
      withdrawableAmount: withdrawable,
    })
  }

  // Fast path: idle covers everything (zero APY impact)
  if (effectiveMax <= idleAssets) {
    if (!constraint || (await isAcceptable(effectiveMax))) {
      const { withdrawable, remaining } = simulateWithdrawal(markets, effectiveMax, idleAssets)
      return {
        amount: effectiveMax,
        maxPossibleAmount: maxPossible,
        isMaxAmount: effectiveMax === maxAmount,
        isCapped: effectiveMax < maxAmount,
        impact: buildWithdrawalImpact(current, current, withdrawable, remaining, incMkts),
      }
    }
    // Constraint failed despite zero APY impact — fall through to binary search
  }

  // Fast path: full effectiveMax within threshold
  if (await isAcceptable(effectiveMax)) {
    const { sim, withdrawable, remaining } = simulateWithdrawal(markets, effectiveMax, idleAssets)
    const simulated =
      withdrawable >= totalVaultAssets
        ? { apy: 0, markets: [] as MarketApyDetail[] }
        : weightedVaultApyDetailed(markets, {}, sim)
    return {
      amount: effectiveMax,
      maxPossibleAmount: maxPossible,
      isMaxAmount: effectiveMax === maxAmount,
      isCapped: effectiveMax < maxAmount,
      impact: buildWithdrawalImpact(current, simulated, withdrawable, remaining, incMkts),
    }
  }

  // Fast path: even smallest step exceeds threshold
  if (step >= effectiveMax || !(await isAcceptable(step))) {
    return {
      amount: 0n,
      maxPossibleAmount: maxPossible,
      isMaxAmount: false,
      isCapped: false,
      impact: zeroWithdrawalImpact(markets, idleAssets, incMkts),
    }
  }

  // Binary search
  let lo = step
  let hi = effectiveMax

  while (hi - lo > step) {
    let mid = lo + (hi - lo) / 2n
    mid = (mid / step) * step
    if (mid === lo) break

    if (await isAcceptable(mid)) {
      lo = mid
    } else {
      hi = mid
    }
  }

  const { sim, withdrawable, remaining } = simulateWithdrawal(markets, lo, idleAssets)
  const simulated =
    withdrawable >= totalVaultAssets
      ? { apy: 0, markets: [] as MarketApyDetail[] }
      : weightedVaultApyDetailed(markets, {}, sim)
  return {
    amount: lo,
    maxPossibleAmount: maxPossible,
    isMaxAmount: false,
    isCapped: false,
    impact: buildWithdrawalImpact(current, simulated, withdrawable, remaining, incMkts),
  }
}
