export interface MarketForApy {
  marketId: string
  name?: string // human-readable label, e.g. "WETH/USDC" (collateral/loan)
  loanToken?: string
  collateralToken?: string
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
  fee: bigint
  vaultSupplyAssets: bigint
  rateAtTarget: bigint
  decimals: number
  inSupplyQueue: boolean
  inWithdrawQueue: boolean
  withdrawQueueIndex: number // position in withdraw queue, -1 if not in it
  cap: bigint
}

export interface VaultFetchResult {
  markets: MarketForApy[]
  idleAssets: bigint
}

export interface VaultApyResult {
  apy: number
  markets: MarketForApy[]
  idleAssets: bigint
  marketDetails: MarketApyDetail[]
}

export interface MarketApyDetail {
  marketId: string
  name?: string
  supplyApy: number
  borrowApy: number
  utilization: number // totalBorrow / totalSupply, 0-1
  allocationPct: number // vault weight in this market / total weight, 0-1
  vaultSupplyAssets: bigint
}

export interface VaultApyDetailed {
  apy: number
  markets: MarketApyDetail[]
}

export interface MarketApySnapshot {
  supplyApy: number
  borrowApy: number
  utilization: number
  allocationPct: number
  vaultSupplyAssets: bigint
}

export interface MarketImpactDetail {
  marketId: string
  name?: string
  current: MarketApySnapshot
  simulated: MarketApySnapshot
}

export interface DepositImpactResult {
  currentApy: number
  newApy: number
  impact: number // newApy - currentApy (decimal, same scale as apy)
  impactBps: number // impact in basis points
  markets: MarketImpactDetail[]
}

export interface WithdrawalImpactResult {
  currentApy: number
  newApy: number
  impact: number
  impactBps: number
  isPartial: boolean
  withdrawableAmount: string
  markets: MarketImpactDetail[]
}

export interface FindMaxDepositResult {
  amount: bigint
  maxPossibleAmount: bigint
  isMaxAmount: boolean
  isCapped: boolean
  impact: DepositImpactResult
}

export interface FindMaxWithdrawalResult {
  amount: bigint
  maxPossibleAmount: bigint
  isMaxAmount: boolean
  isCapped: boolean
  impact: WithdrawalImpactResult
}

/** State passed to custom constraint callback during find-max binary search. */
export interface FindMaxConstraintState {
  amount: bigint
  currentApy: number
  simulatedApy: number
  impactBps: number
  markets: MarketImpactDetail[]
  /** true if withdrawal was liquidity-constrained (withdrawal only) */
  isPartial?: boolean
  /** Actual removable amount (withdrawal only) */
  withdrawableAmount?: bigint
}

/**
 * Custom constraint for find-max binary search. Must be monotonic in amount:
 * if amount X fails, all amounts > X must also fail.
 *
 * Returns true if the amount is acceptable, false if it exceeds the constraint.
 * Can be async (e.g. to fetch external data).
 */
export type FindMaxConstraint = (state: FindMaxConstraintState) => boolean | Promise<boolean>
