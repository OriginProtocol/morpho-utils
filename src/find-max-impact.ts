import type { PublicClient } from 'viem'

import { getMorphoBlueAddress } from './addresses.js'
import { fetchVaultApyViem } from './fetch.js'
import { findMaxDepositAmount, findMaxWithdrawalAmount } from './find-max.js'
import type { FindMaxConstraint, FindMaxDepositResult, FindMaxWithdrawalResult } from './types.js'

export async function findMaxDeposit(
  client: PublicClient,
  chainId: number,
  vaultAddress: string,
  maxAmount: bigint,
  maxImpactBps: number,
  options?: { precision?: bigint; morphoAddress?: string; includeMarkets?: boolean; constraint?: FindMaxConstraint },
): Promise<FindMaxDepositResult> {
  const morpho = options?.morphoAddress ?? getMorphoBlueAddress(chainId)
  const result = await fetchVaultApyViem(client, vaultAddress, morpho)
  if (!result) {
    return {
      amount: 0n,
      maxPossibleAmount: 0n,
      isMaxAmount: false,
      isCapped: false,
      impact: { currentApy: 0, newApy: 0, impact: 0, impactBps: 0, markets: [] },
    }
  }
  return findMaxDepositAmount(result.markets, maxAmount, maxImpactBps, {
    precision: options?.precision,
    includeMarkets: options?.includeMarkets,
    constraint: options?.constraint,
  })
}

export async function findMaxWithdrawal(
  client: PublicClient,
  chainId: number,
  vaultAddress: string,
  maxAmount: bigint,
  maxImpactBps: number,
  options?: { precision?: bigint; morphoAddress?: string; includeMarkets?: boolean; constraint?: FindMaxConstraint },
): Promise<FindMaxWithdrawalResult> {
  const morpho = options?.morphoAddress ?? getMorphoBlueAddress(chainId)
  const result = await fetchVaultApyViem(client, vaultAddress, morpho)
  if (!result) {
    return {
      amount: 0n,
      maxPossibleAmount: 0n,
      isMaxAmount: false,
      isCapped: false,
      impact: {
        currentApy: 0,
        newApy: 0,
        impact: 0,
        impactBps: 0,
        isPartial: false,
        withdrawableAmount: '0',
        markets: [],
      },
    }
  }
  return findMaxWithdrawalAmount(result.markets, result.idleAssets, maxAmount, maxImpactBps, {
    precision: options?.precision,
    includeMarkets: options?.includeMarkets,
    constraint: options?.constraint,
  })
}
