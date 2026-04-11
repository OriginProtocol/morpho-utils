// Types
export type {
  MarketForApy,
  MarketApyDetail,
  MarketApySnapshot,
  MarketImpactDetail,
  VaultApyDetailed,
  VaultApyResult,
  VaultFetchResult,
  DepositImpactResult,
  WithdrawalImpactResult,
  FindMaxDepositResult,
  FindMaxWithdrawalResult,
  FindMaxConstraintState,
  FindMaxConstraint,
} from './types.js'

// Pure math (zero deps)
export {
  estimateMarketApy,
  weightedVaultApy,
  weightedVaultApyDetailed,
  mergeMarketDetails,
  simulateDeposit,
  simulateWithdrawal,
} from './math.js'

// On-chain data fetching (requires viem)
export { fetchVaultMarketsViem, fetchVaultApyViem } from './fetch.js'

// High-level impact computation (requires viem PublicClient)
export { computeDepositImpact } from './deposit-impact.js'
export { computeWithdrawalImpact } from './withdrawal-impact.js'

// Find max deposit/withdrawal within APY impact threshold (pure math)
export { findMaxDepositAmount, findMaxWithdrawalAmount } from './find-max.js'

// Find max with viem client (single RPC round-trip + binary search in memory)
export { findMaxDeposit, findMaxWithdrawal } from './find-max-impact.js'

// RPC URL convenience functions (requires viem, but consumer doesn't import it)
export {
  fetchVaultApy,
  fetchVaultMarkets,
  computeDepositImpactRpc,
  computeWithdrawalImpactRpc,
  findMaxDepositRpc,
  findMaxWithdrawalRpc,
} from './rpc.js'

// Addresses
export { MORPHO_BLUE_ADDRESSES, getMorphoBlueAddress } from './addresses.js'

// ABIs
export { morphoAbi } from './abi/morpho.js'
export { metaMorphoAbi } from './abi/meta-morpho.js'
export { irmAdaptiveCurveAbi } from './abi/irm-adaptive-curve.js'
export { erc20Abi } from './abi/erc20.js'
