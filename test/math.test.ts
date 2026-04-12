import { describe, expect, it } from 'vitest'

import {
  estimateMarketApy,
  mergeMarketDetails,
  simulateDeposit,
  simulateWithdrawal,
  weightedVaultApy,
  weightedVaultApyDetailed,
} from '../src/math.js'
import type { MarketForApy } from '../src/types.js'

function makeMarket(overrides: Partial<MarketForApy> = {}): MarketForApy {
  return {
    marketId: '0xaaa',
    totalSupplyAssets: 1000n * 10n ** 18n, // 1000 tokens
    totalBorrowAssets: 800n * 10n ** 18n, // 800 tokens → 80% util
    fee: 0n,
    vaultSupplyAssets: 500n * 10n ** 18n,
    rateAtTarget: 3_170_979_198n, // ~10% APY at target (0.9 util)
    decimals: 18,
    inSupplyQueue: true,
    inWithdrawQueue: true,
    withdrawQueueIndex: 0,
    cap: 2000n * 10n ** 18n,
    ...overrides,
  }
}

describe('estimateMarketApy', () => {
  it('returns zero APY when supply is zero', () => {
    const { supplyApy, borrowApy } = estimateMarketApy(0, 0, 0, 0, 1e9)
    expect(supplyApy).toBe(0)
    expect(borrowApy).toBe(0)
  })

  it('returns zero APY when rateAtTarget is zero', () => {
    const { supplyApy, borrowApy } = estimateMarketApy(0, 1000, 800, 0, 0)
    expect(supplyApy).toBe(0)
    expect(borrowApy).toBe(0)
  })

  it('returns zero supply APY when there are no borrows', () => {
    const { supplyApy, borrowApy } = estimateMarketApy(0, 1000, 0, 0, 1e9)
    expect(supplyApy).toBe(0)
    // borrowApy is nonzero (IRM curve at 0% util still has a positive base rate)
    // but supplyApy = borrowApy * util * (1-fee) = 0 since util=0
    expect(borrowApy).toBeGreaterThan(0)
  })

  it('computes positive APY for a market with borrows', () => {
    // 80% utilization, 10% rate at target, no fee
    const { supplyApy, borrowApy } = estimateMarketApy(0, 1000, 800, 0, 3_170_979_198)
    expect(borrowApy).toBeGreaterThan(0)
    expect(supplyApy).toBeGreaterThan(0)
    expect(supplyApy).toBeLessThan(borrowApy)
  })

  it('supply APY is reduced by fee', () => {
    const noFee = estimateMarketApy(0, 1000, 800, 0, 3_170_979_198)
    const withFee = estimateMarketApy(0, 1000, 800, 0.1e18, 3_170_979_198)
    expect(withFee.supplyApy).toBeLessThan(noFee.supplyApy)
    expect(withFee.borrowApy).toBeCloseTo(noFee.borrowApy, 6) // fee doesn't affect borrow rate
  })

  it('additional deposit lowers utilization and supply APY', () => {
    const before = estimateMarketApy(0, 1000, 800, 0, 3_170_979_198)
    const after = estimateMarketApy(500, 1000, 800, 0, 3_170_979_198)
    expect(after.supplyApy).toBeLessThan(before.supplyApy)
  })

  it('APY increases as utilization approaches target (0.9)', () => {
    const low = estimateMarketApy(0, 1000, 500, 0, 3_170_979_198) // 50% util
    const mid = estimateMarketApy(0, 1000, 800, 0, 3_170_979_198) // 80% util
    expect(mid.supplyApy).toBeGreaterThan(low.supplyApy)
  })

  it('borrow APY spikes above target utilization', () => {
    const atTarget = estimateMarketApy(0, 1000, 900, 0, 3_170_979_198) // 90%
    const above = estimateMarketApy(0, 1000, 950, 0, 3_170_979_198) // 95%
    expect(above.borrowApy).toBeGreaterThan(atTarget.borrowApy)
  })

  it('clamps APY to 800%', () => {
    // Very high rate and high utilization
    const { borrowApy, supplyApy } = estimateMarketApy(0, 1000, 999, 0, 1e15)
    expect(borrowApy).toBeLessThanOrEqual(8.0)
    expect(supplyApy).toBeLessThanOrEqual(8.0)
  })
})

describe('weightedVaultApy', () => {
  it('returns 0 for empty markets array', () => {
    expect(weightedVaultApy([])).toBe(0)
  })

  it('returns single market APY when vault has one market', () => {
    const market = makeMarket()
    const apy = weightedVaultApy([market])
    expect(apy).toBeGreaterThan(0)
  })

  it('weights by vault supply assets', () => {
    // Market A: high APY, low weight
    // Market B: low APY, high weight
    const marketA = makeMarket({
      marketId: '0xa',
      totalBorrowAssets: 850n * 10n ** 18n, // higher util → higher APY
      vaultSupplyAssets: 100n * 10n ** 18n,
    })
    const marketB = makeMarket({
      marketId: '0xb',
      totalBorrowAssets: 500n * 10n ** 18n, // lower util → lower APY
      vaultSupplyAssets: 900n * 10n ** 18n,
    })

    const combined = weightedVaultApy([marketA, marketB])
    const apyA = weightedVaultApy([marketA])
    const apyB = weightedVaultApy([marketB])

    // Combined should be between the two, closer to B (higher weight)
    expect(combined).toBeGreaterThan(apyB)
    expect(combined).toBeLessThan(apyA)
  })

  it('throws when all markets have zero vault supply', () => {
    const market = makeMarket({ vaultSupplyAssets: 0n })
    expect(() => weightedVaultApy([market])).toThrow(/zero supply position/)
  })

  it('skips markets with zero vault supply', () => {
    const active = makeMarket({ marketId: '0xa', vaultSupplyAssets: 500n * 10n ** 18n })
    const empty = makeMarket({ marketId: '0xb', vaultSupplyAssets: 0n })
    const apy = weightedVaultApy([active, empty])
    const apySingle = weightedVaultApy([active])
    expect(apy).toBeCloseTo(apySingle, 10)
  })

  it('applies deposit simulation to totalSupplyAssets', () => {
    const market = makeMarket()
    const current = weightedVaultApy([market])
    const withDeposit = weightedVaultApy([market], { '0xaaa': 200n * 10n ** 18n })
    // Deposit increases supply → lowers utilization → typically lowers APY
    expect(withDeposit).toBeLessThan(current)
  })

  it('applies withdrawal simulation to both totalSupply and vaultSupply', () => {
    const market = makeMarket()
    const current = weightedVaultApy([market])
    const withdrawn = 100n * 10n ** 18n
    const withWithdrawal = weightedVaultApy([market], {}, { '0xaaa': withdrawn })
    // Withdrawal decreases supply → raises utilization → changes APY
    expect(withWithdrawal).not.toBe(current)
  })
})

describe('simulateDeposit', () => {
  it('fills supply queue markets up to cap', () => {
    const market = makeMarket({
      cap: 600n * 10n ** 18n,
      vaultSupplyAssets: 500n * 10n ** 18n,
    })
    const sim = simulateDeposit([market], 200n * 10n ** 18n)
    // available = cap - vaultSupply = 100e18, so only 100e18 goes to this market
    expect(sim['0xaaa']).toBe(100n * 10n ** 18n)
  })

  it('spills to next market when first is full', () => {
    const m1 = makeMarket({
      marketId: '0xa',
      cap: 600n * 10n ** 18n,
      vaultSupplyAssets: 500n * 10n ** 18n, // 100e18 available
    })
    const m2 = makeMarket({
      marketId: '0xb',
      cap: 2000n * 10n ** 18n,
      vaultSupplyAssets: 100n * 10n ** 18n, // 1900e18 available
    })
    const sim = simulateDeposit([m1, m2], 300n * 10n ** 18n)
    expect(sim['0xa']).toBe(100n * 10n ** 18n)
    expect(sim['0xb']).toBe(200n * 10n ** 18n)
  })

  it('skips markets not in supply queue', () => {
    const market = makeMarket({ inSupplyQueue: false })
    const sim = simulateDeposit([market], 100n * 10n ** 18n)
    expect(Object.keys(sim)).toHaveLength(0)
  })

  it('returns empty sim for zero deposit', () => {
    const market = makeMarket()
    const sim = simulateDeposit([market], 0n)
    expect(Object.keys(sim)).toHaveLength(0)
  })

  it('skips markets at cap', () => {
    const market = makeMarket({
      cap: 500n * 10n ** 18n,
      vaultSupplyAssets: 500n * 10n ** 18n,
    })
    const sim = simulateDeposit([market], 100n * 10n ** 18n)
    expect(Object.keys(sim)).toHaveLength(0)
  })
})

describe('simulateWithdrawal', () => {
  it('consumes idle assets first', () => {
    const market = makeMarket({ withdrawQueueIndex: 0 })
    const idle = 100n * 10n ** 18n
    const { sim, withdrawable, remaining } = simulateWithdrawal([market], 50n * 10n ** 18n, idle)
    // All from idle, no market impact
    expect(Object.keys(sim)).toHaveLength(0)
    expect(withdrawable).toBe(50n * 10n ** 18n)
    expect(remaining).toBe(0n)
  })

  it('deducts from markets after idle is exhausted', () => {
    const market = makeMarket({ withdrawQueueIndex: 0 })
    const idle = 50n * 10n ** 18n
    const { sim, withdrawable } = simulateWithdrawal([market], 150n * 10n ** 18n, idle)
    // 50 from idle, 100 from market
    expect(sim['0xaaa']).toBe(100n * 10n ** 18n)
    expect(withdrawable).toBe(150n * 10n ** 18n)
  })

  it('respects withdraw queue order', () => {
    const m1 = makeMarket({
      marketId: '0xa',
      vaultSupplyAssets: 50n * 10n ** 18n,
      withdrawQueueIndex: 0,
    })
    const m2 = makeMarket({
      marketId: '0xb',
      vaultSupplyAssets: 200n * 10n ** 18n,
      withdrawQueueIndex: 1,
    })
    const { sim } = simulateWithdrawal([m2, m1], 120n * 10n ** 18n, 0n)
    // m1 first (index 0), m2 second (index 1)
    expect(sim['0xa']).toBe(50n * 10n ** 18n) // drained
    expect(sim['0xb']).toBe(70n * 10n ** 18n) // partial
  })

  it('limits withdrawal to available liquidity', () => {
    // Market has 500 vault supply but only 200 liquidity (supply - borrows)
    const market = makeMarket({
      totalSupplyAssets: 1000n * 10n ** 18n,
      totalBorrowAssets: 800n * 10n ** 18n, // liquidity = 200
      vaultSupplyAssets: 500n * 10n ** 18n,
      withdrawQueueIndex: 0,
    })
    const { sim, withdrawable, remaining } = simulateWithdrawal([market], 300n * 10n ** 18n, 0n)
    expect(sim['0xaaa']).toBe(200n * 10n ** 18n) // limited by liquidity
    expect(remaining).toBe(100n * 10n ** 18n)
    expect(withdrawable).toBe(200n * 10n ** 18n)
  })

  it('reports partial withdrawal correctly', () => {
    const market = makeMarket({
      totalSupplyAssets: 1000n * 10n ** 18n,
      totalBorrowAssets: 900n * 10n ** 18n, // liquidity = 100
      vaultSupplyAssets: 500n * 10n ** 18n,
      withdrawQueueIndex: 0,
    })
    const { remaining } = simulateWithdrawal([market], 200n * 10n ** 18n, 0n)
    expect(remaining).toBeGreaterThan(0n)
  })

  it('skips markets not in withdraw queue', () => {
    const market = makeMarket({ inWithdrawQueue: false, withdrawQueueIndex: -1 })
    const { sim, remaining } = simulateWithdrawal([market], 100n * 10n ** 18n, 0n)
    expect(Object.keys(sim)).toHaveLength(0)
    expect(remaining).toBe(100n * 10n ** 18n)
  })

  it('handles full withdrawal (drains everything)', () => {
    const market = makeMarket({
      totalSupplyAssets: 500n * 10n ** 18n,
      totalBorrowAssets: 0n, // full liquidity
      vaultSupplyAssets: 500n * 10n ** 18n,
      withdrawQueueIndex: 0,
    })
    const idle = 100n * 10n ** 18n
    const { sim, withdrawable, remaining } = simulateWithdrawal([market], 600n * 10n ** 18n, idle)
    expect(sim['0xaaa']).toBe(500n * 10n ** 18n)
    expect(withdrawable).toBe(600n * 10n ** 18n)
    expect(remaining).toBe(0n)
  })
})

describe('weightedVaultApyDetailed', () => {
  it('returns same apy as weightedVaultApy', () => {
    const market = makeMarket()
    const apy = weightedVaultApy([market])
    const detailed = weightedVaultApyDetailed([market])
    expect(detailed.apy).toBe(apy)
  })

  it('returns empty markets array for empty input', () => {
    const detailed = weightedVaultApyDetailed([])
    expect(detailed.apy).toBe(0)
    expect(detailed.markets).toHaveLength(0)
  })

  it('returns one detail per market', () => {
    const m1 = makeMarket({ marketId: '0xa' })
    const m2 = makeMarket({ marketId: '0xb', vaultSupplyAssets: 200n * 10n ** 18n })
    const detailed = weightedVaultApyDetailed([m1, m2])
    expect(detailed.markets).toHaveLength(2)
    expect(detailed.markets[0].marketId).toBe('0xa')
    expect(detailed.markets[1].marketId).toBe('0xb')
  })

  it('computes utilization correctly', () => {
    // 800/1000 = 0.8
    const market = makeMarket({
      totalSupplyAssets: 1000n * 10n ** 18n,
      totalBorrowAssets: 800n * 10n ** 18n,
    })
    const detailed = weightedVaultApyDetailed([market])
    expect(detailed.markets[0].utilization).toBeCloseTo(0.8, 6)
  })

  it('captures borrowApy', () => {
    const market = makeMarket()
    const detailed = weightedVaultApyDetailed([market])
    expect(detailed.markets[0].borrowApy).toBeGreaterThan(0)
    expect(detailed.markets[0].borrowApy).toBeGreaterThan(detailed.markets[0].supplyApy)
  })

  it('allocationPct sums to 1.0 for active markets', () => {
    const m1 = makeMarket({ marketId: '0xa', vaultSupplyAssets: 300n * 10n ** 18n })
    const m2 = makeMarket({ marketId: '0xb', vaultSupplyAssets: 700n * 10n ** 18n })
    const detailed = weightedVaultApyDetailed([m1, m2])
    const sum = detailed.markets.reduce((acc, m) => acc + m.allocationPct, 0)
    expect(sum).toBeCloseTo(1.0, 10)
  })

  it('markets with zero vault supply have allocationPct 0', () => {
    const active = makeMarket({ marketId: '0xa', vaultSupplyAssets: 500n * 10n ** 18n })
    const empty = makeMarket({ marketId: '0xb', vaultSupplyAssets: 0n })
    const detailed = weightedVaultApyDetailed([active, empty])
    expect(detailed.markets[1].allocationPct).toBe(0)
    expect(detailed.markets[0].allocationPct).toBeCloseTo(1.0, 10)
  })

  it('deposit sim changes per-market details', () => {
    const market = makeMarket()
    const current = weightedVaultApyDetailed([market])
    const withDeposit = weightedVaultApyDetailed([market], { '0xaaa': 200n * 10n ** 18n })
    // Deposit increases supply → lowers utilization
    expect(withDeposit.markets[0].utilization).toBeLessThan(current.markets[0].utilization)
    expect(withDeposit.markets[0].supplyApy).toBeLessThan(current.markets[0].supplyApy)
  })

  it('withdrawal sim adjusts vaultSupplyAssets', () => {
    const market = makeMarket({ vaultSupplyAssets: 500n * 10n ** 18n })
    const withdrawn = 100n * 10n ** 18n
    const detailed = weightedVaultApyDetailed([market], {}, { '0xaaa': withdrawn })
    expect(detailed.markets[0].vaultSupplyAssets).toBe(400n * 10n ** 18n)
  })
})

describe('mergeMarketDetails', () => {
  it('merges by marketId even when simulated order differs', () => {
    const current = weightedVaultApyDetailed([
      makeMarket({ marketId: '0xa' }),
      makeMarket({ marketId: '0xb', totalBorrowAssets: 700n * 10n ** 18n }),
    ]).markets
    const simulated = weightedVaultApyDetailed([
      makeMarket({ marketId: '0xa', totalSupplyAssets: 1100n * 10n ** 18n }),
      makeMarket({ marketId: '0xb', totalSupplyAssets: 1200n * 10n ** 18n }),
    ]).markets

    const reordered = [simulated[1], simulated[0]]
    const merged = mergeMarketDetails(current, reordered)

    expect(merged).toHaveLength(2)
    expect(merged[0].marketId).toBe('0xa')
    expect(merged[0].simulated.vaultSupplyAssets).toBe(simulated[0].vaultSupplyAssets)
    expect(merged[1].marketId).toBe('0xb')
    expect(merged[1].simulated.vaultSupplyAssets).toBe(simulated[1].vaultSupplyAssets)
  })

  it('throws on duplicate simulated market IDs', () => {
    const current = weightedVaultApyDetailed([makeMarket({ marketId: '0xa' })]).markets
    const simulated = weightedVaultApyDetailed([makeMarket({ marketId: '0xa' })]).markets
    const duplicated = [simulated[0], simulated[0]]

    expect(() => mergeMarketDetails(current, duplicated)).toThrow(/Duplicate simulated marketId/)
  })

  it('throws when a current market is missing from simulated details', () => {
    const current = weightedVaultApyDetailed([makeMarket({ marketId: '0xa' }), makeMarket({ marketId: '0xb' })]).markets
    const simulated = weightedVaultApyDetailed([makeMarket({ marketId: '0xa' })]).markets

    expect(() => mergeMarketDetails(current, simulated)).toThrow(/Missing simulated marketId/)
  })
})
