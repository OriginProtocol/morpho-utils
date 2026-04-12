import type { PublicClient } from 'viem'

import { getMorphoBlueAddress } from './addresses.js'
import { fetchVaultApyViem } from './fetch.js'
import { mergeMarketDetails, simulateWithdrawal, weightedVaultApyDetailed } from './math.js'
import type { WithdrawalImpactResult } from './types.js'

function makeFullDrainMarketDetails(current: ReturnType<typeof weightedVaultApyDetailed>) {
  return current.markets.map((m) => ({
    marketId: m.marketId,
    name: m.name,
    supplyApy: 0,
    borrowApy: 0,
    utilization: 0,
    allocationPct: 0,
    vaultSupplyAssets: 0n,
  }))
}

/**
 * Compute the APY impact of a withdrawal from a MetaMorpho vault.
 * Makes live on-chain RPC calls via the provided viem PublicClient.
 *
 * @param client   viem PublicClient for the target chain
 * @param chainId  Chain ID (used to resolve the Morpho Blue singleton address)
 * @param vaultAddress  MetaMorpho V1.1 vault address
 * @param withdrawAmount  Withdrawal size in loan-token base units (e.g. 1e18 for 1 ETH)
 * @param morphoAddress  Optional override for the Morpho Blue singleton address
 */
export async function computeWithdrawalImpact(
  client: PublicClient,
  chainId: number,
  vaultAddress: string,
  withdrawAmount: bigint,
  options?: { morphoAddress?: string; includeMarkets?: boolean },
): Promise<WithdrawalImpactResult> {
  const morpho = options?.morphoAddress ?? getMorphoBlueAddress(chainId)
  const incMkts = options?.includeMarkets ?? false

  const result = await fetchVaultApyViem(client, vaultAddress, morpho)
  if (!result) {
    return {
      currentApy: 0,
      newApy: 0,
      impact: 0,
      impactBps: 0,
      isPartial: false,
      withdrawableAmount: '0',
      markets: [],
    }
  }

  const { markets, idleAssets } = result
  const current = weightedVaultApyDetailed(markets)
  const { sim, withdrawable, remaining } = simulateWithdrawal(markets, withdrawAmount, idleAssets)

  // Edge case: full withdrawal drains all vault positions
  const totalVaultAssets = markets.reduce((acc, m) => acc + m.vaultSupplyAssets, 0n) + idleAssets
  const simulated =
    withdrawable >= totalVaultAssets
      ? { apy: 0, markets: makeFullDrainMarketDetails(current) }
      : weightedVaultApyDetailed(markets, {}, sim)
  const impact = simulated.apy - current.apy

  return {
    currentApy: current.apy,
    newApy: simulated.apy,
    impact,
    impactBps: Math.round(impact * 10000),
    isPartial: remaining > 0n,
    withdrawableAmount: withdrawable.toString(),
    markets: incMkts ? mergeMarketDetails(current.markets, simulated.markets) : [],
  }
}
