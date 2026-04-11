import type { PublicClient } from 'viem'

import { getMorphoBlueAddress } from './addresses.js'
import { fetchVaultApyViem } from './fetch.js'
import { mergeMarketDetails, simulateDeposit, weightedVaultApyDetailed } from './math.js'
import type { DepositImpactResult } from './types.js'

/**
 * Compute the APY impact of a deposit into a MetaMorpho vault.
 * Makes live on-chain RPC calls via the provided viem PublicClient.
 *
 * @param client   viem PublicClient for the target chain
 * @param chainId  Chain ID (used to resolve the Morpho Blue singleton address)
 * @param vaultAddress  MetaMorpho V1.1 vault address
 * @param depositAmount  Deposit size in loan-token base units (e.g. 1e18 for 1 ETH)
 * @param morphoAddress  Optional override for the Morpho Blue singleton address
 */
export async function computeDepositImpact(
  client: PublicClient,
  chainId: number,
  vaultAddress: string,
  depositAmount: bigint,
  options?: { morphoAddress?: string; includeMarkets?: boolean },
): Promise<DepositImpactResult> {
  const morpho = options?.morphoAddress ?? getMorphoBlueAddress(chainId)
  const incMkts = options?.includeMarkets ?? false

  const result = await fetchVaultApyViem(client, vaultAddress, morpho)
  if (!result) {
    return { currentApy: 0, newApy: 0, impact: 0, impactBps: 0, markets: [] }
  }

  const { markets } = result
  const current = weightedVaultApyDetailed(markets)
  const sim = simulateDeposit(markets, depositAmount)
  const simulated = weightedVaultApyDetailed(markets, sim)
  const impact = simulated.apy - current.apy

  return {
    currentApy: current.apy,
    newApy: simulated.apy,
    impact,
    impactBps: Math.round(impact * 10000),
    markets: incMkts ? mergeMarketDetails(current.markets, simulated.markets) : [],
  }
}
