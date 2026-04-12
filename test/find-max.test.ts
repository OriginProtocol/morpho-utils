import { describe, expect, it } from 'vitest'

import { findMaxDepositAmount, findMaxWithdrawalAmount } from '../src/find-max.js'
import { simulateDeposit, weightedVaultApyDetailed } from '../src/math.js'
import type { MarketForApy } from '../src/types.js'

function makeMarket(overrides: Partial<MarketForApy> = {}): MarketForApy {
  return {
    marketId: '0xaaa',
    totalSupplyAssets: 1000n * 10n ** 18n,
    totalBorrowAssets: 800n * 10n ** 18n, // 80% util
    fee: 0n,
    vaultSupplyAssets: 500n * 10n ** 18n,
    rateAtTarget: 3_170_979_198n, // ~10% APY at target
    decimals: 18,
    inSupplyQueue: true,
    inWithdrawQueue: true,
    withdrawQueueIndex: 0,
    cap: 2000n * 10n ** 18n,
    ...overrides,
  }
}

const TOKEN = 10n ** 18n

describe('findMaxDepositAmount', async () => {
  it('returns 0 for empty markets', async () => {
    const result = await findMaxDepositAmount([], 100n * TOKEN, 50)
    expect(result.amount).toBe(0n)
    expect(result.maxPossibleAmount).toBe(0n)
    expect(result.isMaxAmount).toBe(false)
  })

  it('returns 0 for maxAmount = 0', async () => {
    const market = makeMarket()
    const result = await findMaxDepositAmount([market], 0n, 50)
    expect(result.amount).toBe(0n)
    expect(result.isMaxAmount).toBe(true)
  })

  it('returns full amount when impact is within threshold', async () => {
    const market = makeMarket()
    // Small deposit relative to market → small impact
    const result = await findMaxDepositAmount([market], 10n * TOKEN, 500) // 500 bps = 5%
    expect(result.amount).toBe(10n * TOKEN)
    expect(result.isMaxAmount).toBe(true)
    expect(result.impact.impactBps).not.toBe(0)
  })

  it('caps at physical max when deposit exceeds capacity', async () => {
    const market = makeMarket({
      cap: 600n * TOKEN,
      vaultSupplyAssets: 500n * TOKEN, // only 100 TOKEN capacity
    })
    const result = await findMaxDepositAmount([market], 200n * TOKEN, 500)
    // Physical max is 100 TOKEN
    expect(result.maxPossibleAmount).toBe(100n * TOKEN)
    expect(result.amount).toBeLessThanOrEqual(100n * TOKEN)
    expect(result.isCapped).toBe(true)
  })

  it('returns 0 when even smallest step exceeds threshold', async () => {
    const market = makeMarket({
      totalSupplyAssets: 10n * TOKEN, // tiny market
      totalBorrowAssets: 9n * TOKEN, // 90% util
      vaultSupplyAssets: 5n * TOKEN,
      cap: 1000n * TOKEN,
    })
    // 1 bps threshold on a tiny market → even 1 TOKEN will exceed
    const result = await findMaxDepositAmount([market], 100n * TOKEN, 1, { precision: TOKEN })
    expect(result.amount).toBe(0n)
  })

  it('binary search finds boundary amount', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      cap: 10000n * TOKEN,
    })
    // Moderate threshold should find an amount via binary search
    const result = await findMaxDepositAmount([market], 1000n * TOKEN, 50, { precision: TOKEN })

    // Amount should be between 0 and maxAmount
    expect(result.amount).toBeGreaterThan(0n)
    expect(result.amount).toBeLessThanOrEqual(1000n * TOKEN)

    // Impact at found amount should be within threshold
    expect(Math.abs(result.impact.impactBps)).toBeLessThanOrEqual(50)
  })

  it('respects custom precision', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      cap: 10000n * TOKEN,
    })
    const precision = 10n * TOKEN
    const result = await findMaxDepositAmount([market], 1000n * TOKEN, 50, { precision })

    // Amount should be a multiple of precision
    if (result.amount > 0n) {
      expect(result.amount % precision).toBe(0n)
    }
  })

  it('maxPossibleAmount sums cap headroom across supply queue markets', async () => {
    const m1 = makeMarket({
      marketId: '0xa',
      cap: 800n * TOKEN,
      vaultSupplyAssets: 500n * TOKEN,
      inSupplyQueue: true,
    })
    const m2 = makeMarket({
      marketId: '0xb',
      cap: 1000n * TOKEN,
      vaultSupplyAssets: 200n * TOKEN,
      inSupplyQueue: true,
    })
    const m3 = makeMarket({
      marketId: '0xc',
      cap: 500n * TOKEN,
      vaultSupplyAssets: 100n * TOKEN,
      inSupplyQueue: false, // not in supply queue
    })
    const result = await findMaxDepositAmount([m1, m2, m3], 5000n * TOKEN, 500)
    // maxPossible = (800-500) + (1000-200) = 300 + 800 = 1100
    expect(result.maxPossibleAmount).toBe(1100n * TOKEN)
  })

  it('returns full impact details at found amount', async () => {
    const market = makeMarket()
    const result = await findMaxDepositAmount([market], 100n * TOKEN, 500, { includeMarkets: true })
    expect(result.impact.currentApy).toBeGreaterThan(0)
    expect(typeof result.impact.newApy).toBe('number')
    expect(typeof result.impact.impact).toBe('number')
    expect(typeof result.impact.impactBps).toBe('number')
    expect(result.impact.markets.length).toBeGreaterThan(0)
  })

  it('returns 0 when maxPossible is 0 (all markets at cap)', async () => {
    const market = makeMarket({
      cap: 500n * TOKEN,
      vaultSupplyAssets: 500n * TOKEN, // at cap
    })
    const result = await findMaxDepositAmount([market], 100n * TOKEN, 500)
    expect(result.amount).toBe(0n)
    expect(result.maxPossibleAmount).toBe(0n)
  })

  it('works with USDC 6-decimal markets', async () => {
    const USDC = 10n ** 6n
    const market = makeMarket({
      totalSupplyAssets: 1_000_000n * USDC,
      totalBorrowAssets: 800_000n * USDC,
      vaultSupplyAssets: 500_000n * USDC,
      rateAtTarget: 3_170_979_198n,
      decimals: 6,
      cap: 2_000_000n * USDC,
    })
    const result = await findMaxDepositAmount([market], 10_000n * USDC, 500)
    // Default precision should be 10^6 = 1 USDC
    expect(result.amount).toBeGreaterThan(0n)
    expect(result.amount).toBeLessThanOrEqual(10_000n * USDC)
  })

  it('binary search boundary is tight (amount+step exceeds threshold)', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      cap: 10000n * TOKEN,
    })
    const step = TOKEN
    const result = await findMaxDepositAmount([market], 1000n * TOKEN, 50, { precision: step })

    // Only check tightness if binary search actually ran (not fast-pathed)
    if (result.amount > 0n && !result.isMaxAmount) {
      const current = weightedVaultApyDetailed([market])
      const simNext = simulateDeposit([market], result.amount + step)
      const next = weightedVaultApyDetailed([market], simNext)
      const nextImpactBps = Math.abs(Math.round((next.apy - current.apy) * 10000))
      expect(nextImpactBps).toBeGreaterThan(50)
    }
  })

  it('returns 0 when maxImpactBps = 0 (zero tolerance)', async () => {
    const market = makeMarket()
    const result = await findMaxDepositAmount([market], 100n * TOKEN, 0)
    expect(result.amount).toBe(0n)
  })

  it('binary search works with multi-market deposit spill', async () => {
    const m1 = makeMarket({
      marketId: '0xa',
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      cap: 80n * TOKEN, // only 30 TOKEN headroom
    })
    const m2 = makeMarket({
      marketId: '0xb',
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      cap: 10000n * TOKEN,
    })
    const result = await findMaxDepositAmount([m1, m2], 500n * TOKEN, 50, { precision: TOKEN })
    expect(result.amount).toBeGreaterThan(0n)
    expect(Math.abs(result.impact.impactBps)).toBeLessThanOrEqual(50)
  })

  it('returns full amount when all borrows are zero (zero APY)', async () => {
    const market = makeMarket({
      totalBorrowAssets: 0n, // no borrows → supplyApy = 0
      cap: 10000n * TOKEN,
    })
    const result = await findMaxDepositAmount([market], 100n * TOKEN, 1)
    // currentApy = 0, newApy = 0, impact = 0 → always within threshold
    expect(result.amount).toBe(100n * TOKEN)
    expect(result.isMaxAmount).toBe(true)
  })

  it('does not crash when precision = 0n (clamps to 1n)', async () => {
    const market = makeMarket()
    await expect(findMaxDepositAmount([market], 100n * TOKEN, 500, { precision: 0n })).resolves.not.toThrow()
  })

  it('excludes markets by default', async () => {
    const market = makeMarket()
    const result = await findMaxDepositAmount([market], 10n * TOKEN, 500)
    expect(result.impact.markets).toEqual([])
  })

  it('includes markets when includeMarkets is true', async () => {
    const market = makeMarket()
    const result = await findMaxDepositAmount([market], 10n * TOKEN, 500, { includeMarkets: true })
    expect(result.impact.markets.length).toBeGreaterThan(0)
    expect(result.impact.markets[0].current).toBeDefined()
    expect(result.impact.markets[0].simulated).toBeDefined()
  })
})

describe('findMaxWithdrawalAmount', async () => {
  it('returns 0 for empty markets', async () => {
    const result = await findMaxWithdrawalAmount([], 0n, 100n * TOKEN, 50)
    expect(result.amount).toBe(0n)
    expect(result.maxPossibleAmount).toBe(0n)
  })

  it('returns 0 for maxAmount = 0', async () => {
    const market = makeMarket()
    const result = await findMaxWithdrawalAmount([market], 0n, 0n, 50)
    expect(result.amount).toBe(0n)
    expect(result.isMaxAmount).toBe(true)
  })

  it('returns full amount when idle covers everything (zero impact)', async () => {
    const market = makeMarket()
    const idle = 200n * TOKEN
    const result = await findMaxWithdrawalAmount([market], idle, 100n * TOKEN, 1) // 1 bps threshold
    // Idle fully covers → zero impact → should return full amount
    expect(result.amount).toBe(100n * TOKEN)
    expect(result.isMaxAmount).toBe(true)
    expect(result.impact.impactBps).toBe(0) // no market impact from idle withdrawal
  })

  it('caps at physical max when requested exceeds withdrawable', async () => {
    const market = makeMarket({
      totalSupplyAssets: 1000n * TOKEN,
      totalBorrowAssets: 800n * TOKEN, // liquidity = 200
      vaultSupplyAssets: 500n * TOKEN,
      withdrawQueueIndex: 0,
    })
    const idle = 50n * TOKEN
    // maxPossible = idle(50) + min(vaultSupply(500), liquidity(200)) = 250
    const result = await findMaxWithdrawalAmount([market], idle, 1000n * TOKEN, 500)
    expect(result.maxPossibleAmount).toBe(250n * TOKEN)
  })

  it('returns full amount when impact within threshold', async () => {
    const market = makeMarket({
      totalSupplyAssets: 10000n * TOKEN,
      totalBorrowAssets: 5000n * TOKEN,
      vaultSupplyAssets: 2000n * TOKEN,
      withdrawQueueIndex: 0,
    })
    const idle = 100n * TOKEN
    // Small withdrawal from a large market → small impact
    const result = await findMaxWithdrawalAmount([market], idle, 10n * TOKEN, 500)
    expect(result.amount).toBe(10n * TOKEN)
    expect(result.isMaxAmount).toBe(true)
  })

  it('binary search finds boundary amount for withdrawal', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      withdrawQueueIndex: 0,
    })
    const idle = 0n
    const result = await findMaxWithdrawalAmount([market], idle, 50n * TOKEN, 50, { precision: TOKEN })

    expect(result.amount).toBeGreaterThan(0n)
    expect(result.amount).toBeLessThanOrEqual(50n * TOKEN)
    expect(Math.abs(result.impact.impactBps)).toBeLessThanOrEqual(50)
  })

  it('respects custom precision for withdrawal', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      withdrawQueueIndex: 0,
    })
    const precision = 5n * TOKEN
    const result = await findMaxWithdrawalAmount([market], 0n, 50n * TOKEN, 50, { precision })

    if (result.amount > 0n) {
      expect(result.amount % precision).toBe(0n)
    }
  })

  it('returns 0 when even smallest step exceeds threshold', async () => {
    const market = makeMarket({
      totalSupplyAssets: 10n * TOKEN,
      totalBorrowAssets: 9n * TOKEN, // very high util, tiny market
      vaultSupplyAssets: 5n * TOKEN,
      withdrawQueueIndex: 0,
    })
    // Withdrawing even 1 TOKEN from this tiny market will cause huge APY impact
    const result = await findMaxWithdrawalAmount([market], 0n, 5n * TOKEN, 1, { precision: TOKEN })
    expect(result.amount).toBe(0n)
  })

  it('withdrawal impact details include isPartial and withdrawableAmount', async () => {
    const market = makeMarket()
    const result = await findMaxWithdrawalAmount([market], 0n, 100n * TOKEN, 500)
    expect(typeof result.impact.isPartial).toBe('boolean')
    expect(typeof result.impact.withdrawableAmount).toBe('string')
  })

  it('handles multiple markets in withdraw queue', async () => {
    const m1 = makeMarket({
      marketId: '0xa',
      totalSupplyAssets: 1000n * TOKEN,
      totalBorrowAssets: 500n * TOKEN, // liquidity = 500
      vaultSupplyAssets: 200n * TOKEN,
      withdrawQueueIndex: 0,
    })
    const m2 = makeMarket({
      marketId: '0xb',
      totalSupplyAssets: 1000n * TOKEN,
      totalBorrowAssets: 300n * TOKEN, // liquidity = 700
      vaultSupplyAssets: 300n * TOKEN,
      withdrawQueueIndex: 1,
    })
    const idle = 50n * TOKEN
    // maxPossible = 50 + min(200,500) + min(300,700) = 550
    const result = await findMaxWithdrawalAmount([m1, m2], idle, 1000n * TOKEN, 500)
    expect(result.maxPossibleAmount).toBe(550n * TOKEN)
  })

  it('handles full drain (newApy = 0)', async () => {
    const market = makeMarket({
      totalSupplyAssets: 500n * TOKEN,
      totalBorrowAssets: 0n, // full liquidity
      vaultSupplyAssets: 500n * TOKEN,
      withdrawQueueIndex: 0,
    })
    const idle = 100n * TOKEN
    // Withdraw everything: 600 TOKEN total vault assets
    const result = await findMaxWithdrawalAmount([market], idle, 600n * TOKEN, 10000) // 100% threshold
    expect(result.amount).toBe(600n * TOKEN)
    expect(result.isMaxAmount).toBe(true)
    expect(result.impact.newApy).toBe(0)
  })

  it('full drain still returns includeMarkets details', async () => {
    const market = makeMarket({
      totalSupplyAssets: 500n * TOKEN,
      totalBorrowAssets: 0n,
      vaultSupplyAssets: 500n * TOKEN,
      withdrawQueueIndex: 0,
    })
    const idle = 100n * TOKEN
    const result = await findMaxWithdrawalAmount([market], idle, 600n * TOKEN, 10000, { includeMarkets: true })

    expect(result.amount).toBe(600n * TOKEN)
    expect(result.impact.newApy).toBe(0)
    expect(result.impact.markets).toHaveLength(1)
    expect(result.impact.markets[0].simulated.vaultSupplyAssets).toBe(0n)
  })

  it('returns 0 when market is 100% utilized and no idle', async () => {
    const market = makeMarket({
      totalSupplyAssets: 1000n * TOKEN,
      totalBorrowAssets: 1000n * TOKEN, // 100% util → 0 liquidity
      vaultSupplyAssets: 500n * TOKEN,
      withdrawQueueIndex: 0,
    })
    // maxPossible = idle(0) + min(vaultSupply(500), liquidity(0)) = 0
    const result = await findMaxWithdrawalAmount([market], 0n, 100n * TOKEN, 500)
    expect(result.amount).toBe(0n)
    expect(result.maxPossibleAmount).toBe(0n)
  })

  it('maxImpactBps = 0 works when idle covers request (zero impact)', async () => {
    const market = makeMarket()
    const idle = 200n * TOKEN
    const result = await findMaxWithdrawalAmount([market], idle, 100n * TOKEN, 0) // zero tolerance
    // Idle covers everything → zero market impact → passes even 0 bps threshold
    expect(result.amount).toBe(100n * TOKEN)
    expect(result.isMaxAmount).toBe(true)
    expect(result.impact.impactBps).toBe(0)
  })

  it('does not crash when precision = 0n (clamps to 1n)', async () => {
    const market = makeMarket()
    await expect(findMaxWithdrawalAmount([market], 0n, 100n * TOKEN, 500, { precision: 0n })).resolves.not.toThrow()
  })

  it('excludes markets by default', async () => {
    const market = makeMarket()
    const result = await findMaxWithdrawalAmount([market], 0n, 10n * TOKEN, 500)
    expect(result.impact.markets).toEqual([])
  })

  it('includes markets when includeMarkets is true', async () => {
    const market = makeMarket()
    const result = await findMaxWithdrawalAmount([market], 0n, 10n * TOKEN, 500, { includeMarkets: true })
    expect(result.impact.markets.length).toBeGreaterThan(0)
    expect(result.impact.markets[0].current).toBeDefined()
    expect(result.impact.markets[0].simulated).toBeDefined()
  })
})

describe('findMaxDepositAmount with constraint', async () => {
  it('constraint that always returns true has no effect', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      cap: 10000n * TOKEN,
    })
    const without = await findMaxDepositAmount([market], 1000n * TOKEN, 50, { precision: TOKEN })
    const withConstraint = await findMaxDepositAmount([market], 1000n * TOKEN, 50, {
      precision: TOKEN,
      constraint: () => true,
    })
    expect(withConstraint.amount).toBe(without.amount)
  })

  it('constraint that always returns false yields 0', async () => {
    const market = makeMarket()
    const result = await findMaxDepositAmount([market], 100n * TOKEN, 500, {
      precision: TOKEN,
      constraint: () => false,
    })
    expect(result.amount).toBe(0n)
  })

  it('utilization constraint limits deposit amount', async () => {
    const market = makeMarket({
      marketId: '0xaaa',
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN, // 80% util currently
      vaultSupplyAssets: 50n * TOKEN,
      cap: 10000n * TOKEN,
    })
    // Without constraint: find max within 500 bps APY impact
    const unconstrained = await findMaxDepositAmount([market], 1000n * TOKEN, 500, { precision: TOKEN })

    // With constraint: also require simulated utilization stays above 50%
    // (depositing more supply lowers utilization, so this limits how much we can deposit)
    const constrained = await findMaxDepositAmount([market], 1000n * TOKEN, 500, {
      precision: TOKEN,
      constraint: (state) => {
        const m = state.markets.find((m) => m.marketId === '0xaaa')
        return !m || m.simulated.utilization >= 0.5
      },
    })
    // Constrained amount should be <= unconstrained
    expect(constrained.amount).toBeLessThanOrEqual(unconstrained.amount)
    expect(constrained.amount).toBeGreaterThan(0n)
  })

  it('constraint receives correct state', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      cap: 10000n * TOKEN,
    })
    let lastState: Parameters<import('../src/types.js').FindMaxConstraint>[0] | undefined
    await findMaxDepositAmount([market], 100n * TOKEN, 500, {
      precision: TOKEN,
      constraint: (state) => {
        lastState = state
        return true
      },
    })
    expect(lastState).toBeDefined()
    expect(lastState!.amount).toBeGreaterThan(0n)
    expect(typeof lastState!.currentApy).toBe('number')
    expect(typeof lastState!.simulatedApy).toBe('number')
    expect(typeof lastState!.impactBps).toBe('number')
    expect(lastState!.markets.length).toBeGreaterThan(0)
    // Deposit-specific: no withdrawal fields
    expect(lastState!.isPartial).toBeUndefined()
    expect(lastState!.withdrawableAmount).toBeUndefined()
  })

  it('fast path respects constraint (full amount passes APY but fails constraint)', async () => {
    const market = makeMarket()
    // 500 bps = very permissive APY threshold → fast path would normally return full amount
    const unconstrained = await findMaxDepositAmount([market], 10n * TOKEN, 500, { precision: TOKEN })
    expect(unconstrained.amount).toBe(10n * TOKEN)
    expect(unconstrained.isMaxAmount).toBe(true)

    // Constraint that rejects the full amount
    const constrained = await findMaxDepositAmount([market], 10n * TOKEN, 500, {
      precision: TOKEN,
      constraint: (state) => state.amount <= 5n * TOKEN,
    })
    expect(constrained.amount).toBeLessThanOrEqual(5n * TOKEN)
    expect(constrained.amount).toBeGreaterThan(0n)
  })

  it('async constraint works', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      cap: 10000n * TOKEN,
    })
    const result = await findMaxDepositAmount([market], 1000n * TOKEN, 500, {
      precision: TOKEN,
      constraint: async (state) => {
        // Simulate async work (e.g., external API call)
        await Promise.resolve()
        return state.simulatedApy > 0
      },
    })
    expect(result.amount).toBeGreaterThan(0n)
  })
})

describe('findMaxWithdrawalAmount with constraint', async () => {
  it('constraint receives withdrawal-specific fields', async () => {
    const market = makeMarket({
      totalSupplyAssets: 100n * TOKEN,
      totalBorrowAssets: 80n * TOKEN,
      vaultSupplyAssets: 50n * TOKEN,
      withdrawQueueIndex: 0,
    })
    let lastState: Parameters<import('../src/types.js').FindMaxConstraint>[0] | undefined
    await findMaxWithdrawalAmount([market], 0n, 50n * TOKEN, 500, {
      precision: TOKEN,
      constraint: (state) => {
        lastState = state
        return true
      },
    })
    expect(lastState).toBeDefined()
    expect(typeof lastState!.isPartial).toBe('boolean')
    expect(typeof lastState!.withdrawableAmount).toBe('bigint')
  })

  it('withdrawal constraint limits amount', async () => {
    const market = makeMarket({
      totalSupplyAssets: 1000n * TOKEN,
      totalBorrowAssets: 500n * TOKEN,
      vaultSupplyAssets: 200n * TOKEN,
      withdrawQueueIndex: 0,
    })
    // Without constraint
    const unconstrained = await findMaxWithdrawalAmount([market], 0n, 200n * TOKEN, 500, { precision: TOKEN })

    // Constraint: keep market utilization under 90% after withdrawal
    const constrained = await findMaxWithdrawalAmount([market], 0n, 200n * TOKEN, 500, {
      precision: TOKEN,
      constraint: (state) => {
        const m = state.markets.find((m) => m.marketId === '0xaaa')
        return !m || m.simulated.utilization <= 0.9
      },
    })
    expect(constrained.amount).toBeLessThanOrEqual(unconstrained.amount)
  })

  it('idle fast path respects constraint', async () => {
    const market = makeMarket()
    const idle = 200n * TOKEN
    // Without constraint: idle covers everything, returns full amount
    const unconstrained = await findMaxWithdrawalAmount([market], idle, 100n * TOKEN, 1)
    expect(unconstrained.amount).toBe(100n * TOKEN)

    // With always-false constraint: should return 0
    const constrained = await findMaxWithdrawalAmount([market], idle, 100n * TOKEN, 1, {
      precision: TOKEN,
      constraint: () => false,
    })
    expect(constrained.amount).toBe(0n)
  })
})
