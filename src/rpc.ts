/**
 * RPC URL-based convenience functions.
 * These wrap the viem-based functions so consumers don't need to create a PublicClient.
 */
import { createPublicClient, defineChain, http } from 'viem'

import { getMorphoBlueAddress } from './addresses.js'
import { computeDepositImpact as computeDepositImpactViem } from './deposit-impact.js'
import { fetchVaultApyViem, fetchVaultMarketsViem } from './fetch.js'
import { findMaxDeposit as findMaxDepositViem, findMaxWithdrawal as findMaxWithdrawalViem } from './find-max-impact.js'
import type {
  DepositImpactResult,
  FindMaxConstraint,
  FindMaxDepositResult,
  FindMaxWithdrawalResult,
  VaultApyResult,
  VaultFetchResult,
  WithdrawalImpactResult,
} from './types.js'
import { computeWithdrawalImpact as computeWithdrawalImpactViem } from './withdrawal-impact.js'

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

function makeClient(rpcUrl: string, chainId: number) {
  return createPublicClient({
    transport: http(rpcUrl),
    chain: defineChain({
      id: chainId,
      name: `Chain ${chainId}`,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
      contracts: { multicall3: { address: MULTICALL3 } },
    }),
  })
}

export async function fetchVaultMarkets(
  rpcUrl: string,
  chainId: number,
  vaultAddress: string,
  morphoAddress: string,
): Promise<VaultFetchResult> {
  return fetchVaultMarketsViem(makeClient(rpcUrl, chainId), vaultAddress, morphoAddress)
}

export async function fetchVaultApy(
  rpcUrl: string,
  chainId: number,
  vaultAddress: string,
  options?: { morphoAddress?: string; includeMarkets?: boolean },
): Promise<VaultApyResult | null> {
  const morpho = options?.morphoAddress ?? getMorphoBlueAddress(chainId)
  return fetchVaultApyViem(makeClient(rpcUrl, chainId), vaultAddress, morpho, {
    includeMarkets: options?.includeMarkets,
  })
}

export async function computeDepositImpactRpc(
  rpcUrl: string,
  chainId: number,
  vaultAddress: string,
  depositAmount: bigint,
  options?: { morphoAddress?: string; includeMarkets?: boolean },
): Promise<DepositImpactResult> {
  return computeDepositImpactViem(makeClient(rpcUrl, chainId), chainId, vaultAddress, depositAmount, options)
}

export async function computeWithdrawalImpactRpc(
  rpcUrl: string,
  chainId: number,
  vaultAddress: string,
  withdrawAmount: bigint,
  options?: { morphoAddress?: string; includeMarkets?: boolean },
): Promise<WithdrawalImpactResult> {
  return computeWithdrawalImpactViem(makeClient(rpcUrl, chainId), chainId, vaultAddress, withdrawAmount, options)
}

export async function findMaxDepositRpc(
  rpcUrl: string,
  chainId: number,
  vaultAddress: string,
  maxAmount: bigint,
  maxImpactBps: number,
  options?: { precision?: bigint; morphoAddress?: string; includeMarkets?: boolean; constraint?: FindMaxConstraint },
): Promise<FindMaxDepositResult> {
  return findMaxDepositViem(makeClient(rpcUrl, chainId), chainId, vaultAddress, maxAmount, maxImpactBps, options)
}

export async function findMaxWithdrawalRpc(
  rpcUrl: string,
  chainId: number,
  vaultAddress: string,
  maxAmount: bigint,
  maxImpactBps: number,
  options?: { precision?: bigint; morphoAddress?: string; includeMarkets?: boolean; constraint?: FindMaxConstraint },
): Promise<FindMaxWithdrawalResult> {
  return findMaxWithdrawalViem(makeClient(rpcUrl, chainId), chainId, vaultAddress, maxAmount, maxImpactBps, options)
}
