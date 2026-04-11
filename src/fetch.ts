/**
 * Market data fetching for Morpho Blue / MetaMorpho vaults using viem.
 */
import type { PublicClient } from 'viem'
import { getAddress } from 'viem'

import { erc20Abi } from './abi/erc20.js'
import { irmAdaptiveCurveAbi } from './abi/irm-adaptive-curve.js'
import { metaMorphoAbi } from './abi/meta-morpho.js'
import { morphoAbi } from './abi/morpho.js'
import { weightedVaultApyDetailed } from './math.js'
import type { MarketForApy, VaultApyResult, VaultFetchResult } from './types.js'

const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Fetch all market data for a MetaMorpho vault using viem multicall.
 *
 * Returns market data needed for APY computation and simulation,
 * plus the vault's idle (undeployed) assets.
 */
export async function fetchVaultMarketsViem(
  client: PublicClient,
  vaultAddress: string,
  morphoAddress: string,
): Promise<VaultFetchResult> {
  const vault = getAddress(vaultAddress)
  const morpho = getAddress(morphoAddress)

  // 1. Queue lengths + total assets
  const [supplyLen, withdrawLen, totalAssets] = await client.multicall({
    contracts: [
      { address: vault, abi: metaMorphoAbi, functionName: 'supplyQueueLength' },
      { address: vault, abi: metaMorphoAbi, functionName: 'withdrawQueueLength' },
      { address: vault, abi: metaMorphoAbi, functionName: 'totalAssets' },
    ],
    allowFailure: false,
  })

  const supplyLenN = Number(supplyLen)
  const withdrawLenN = Number(withdrawLen)
  if (supplyLenN === 0 && withdrawLenN === 0) return { markets: [], idleAssets: 0n }

  // 2. Market IDs from both queues
  const queueCalls = [
    ...Array.from({ length: supplyLenN }, (_, i) => ({
      address: vault,
      abi: metaMorphoAbi,
      functionName: 'supplyQueue' as const,
      args: [BigInt(i)] as const,
    })),
    ...Array.from({ length: withdrawLenN }, (_, i) => ({
      address: vault,
      abi: metaMorphoAbi,
      functionName: 'withdrawQueue' as const,
      args: [BigInt(i)] as const,
    })),
  ]

  const queueResults = await client.multicall({ contracts: queueCalls, allowFailure: false })
  const supplyIds = queueResults.slice(0, supplyLenN) as `0x${string}`[]
  const withdrawIds = queueResults.slice(supplyLenN) as `0x${string}`[]

  // 3. Union market IDs + withdraw queue ordering
  const supplySet = new Set(supplyIds)
  const withdrawSet = new Set(withdrawIds)
  const withdrawQueueOrder = new Map<string, number>()
  ;(withdrawIds as string[]).forEach((id, i) => withdrawQueueOrder.set(id, i))
  const allIds = [...new Set([...supplyIds, ...withdrawIds])]

  if (allIds.length === 0) return { markets: [], idleAssets: 0n }

  // 4. Fetch market state, position, params, config (parallel multicalls)
  const [marketStates, positions, marketParams, configs] = await Promise.all([
    client.multicall({
      contracts: allIds.map((id) => ({
        address: morpho,
        abi: morphoAbi,
        functionName: 'market' as const,
        args: [id] as const,
      })),
      allowFailure: false,
    }),
    client.multicall({
      contracts: allIds.map((id) => ({
        address: morpho,
        abi: morphoAbi,
        functionName: 'position' as const,
        args: [id, vault] as const,
      })),
      allowFailure: false,
    }),
    client.multicall({
      contracts: allIds.map((id) => ({
        address: morpho,
        abi: morphoAbi,
        functionName: 'idToMarketParams' as const,
        args: [id] as const,
      })),
      allowFailure: false,
    }),
    client.multicall({
      contracts: allIds.map((id) => ({
        address: vault,
        abi: metaMorphoAbi,
        functionName: 'config' as const,
        args: [id] as const,
      })),
      allowFailure: false,
    }),
  ])

  // 5. Per-market IRM + decimals + token symbols (single multicall batch)
  type MulticallContract = Parameters<PublicClient['multicall']>[0]['contracts'][number]
  const irmAndDecimalCalls: MulticallContract[] = marketParams.flatMap(
    ([loanToken, collateralToken, , irm]: readonly [string, string, string, string, bigint], i: number) => {
      const hasIrm = irm && irm.toLowerCase() !== ADDRESS_ZERO
      const hasCollateral = collateralToken && collateralToken.toLowerCase() !== ADDRESS_ZERO
      const calls: (MulticallContract | null)[] = [
        hasIrm
          ? {
              address: getAddress(irm),
              abi: irmAdaptiveCurveAbi,
              functionName: 'rateAtTarget' as const,
              args: [allIds[i]] as const,
            }
          : null,
        { address: getAddress(loanToken), abi: erc20Abi, functionName: 'decimals' as const },
        { address: getAddress(loanToken), abi: erc20Abi, functionName: 'symbol' as const },
        hasCollateral ? { address: getAddress(collateralToken), abi: erc20Abi, functionName: 'symbol' as const } : null,
      ]
      return calls.filter((c): c is MulticallContract => c !== null)
    },
  )

  const irmAndDecimalResults = await client.multicall({
    contracts: irmAndDecimalCalls as readonly MulticallContract[],
    allowFailure: true,
  })

  // Map results back, accounting for skipped IRM and collateral symbol calls
  let resultIdx = 0
  const ratesAtTarget: bigint[] = []
  const decimals: number[] = []
  const loanSymbols: string[] = []
  const collateralSymbols: string[] = []
  for (const [, collateralToken, , irm] of marketParams as unknown as readonly [
    string,
    string,
    string,
    string,
    bigint,
  ][]) {
    const hasIrm = irm && irm.toLowerCase() !== ADDRESS_ZERO
    const hasCollateral = collateralToken && collateralToken.toLowerCase() !== ADDRESS_ZERO
    if (hasIrm) {
      const r = irmAndDecimalResults[resultIdx++]
      const rate = r.status === 'success' ? (r.result as bigint) : 0n
      ratesAtTarget.push(rate < 0n ? 0n : rate)
    } else {
      ratesAtTarget.push(0n)
    }
    const d = irmAndDecimalResults[resultIdx++]
    decimals.push(d.status === 'success' ? Number(d.result) : 18)
    const ls = irmAndDecimalResults[resultIdx++]
    loanSymbols.push(ls.status === 'success' ? (ls.result as string) : '???')
    if (hasCollateral) {
      const cs = irmAndDecimalResults[resultIdx++]
      collateralSymbols.push(cs.status === 'success' ? (cs.result as string) : '???')
    } else {
      collateralSymbols.push('—')
    }
  }

  // 6. Assemble
  const markets: MarketForApy[] = allIds.map((marketId, i) => {
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, , , fee] = marketStates[i]
    const [supplyShares] = positions[i]
    const [cap] = configs[i]

    let vaultSupplyAssets = 0n
    if (supplyShares > 0n && totalSupplyShares > 0n) {
      vaultSupplyAssets = (supplyShares * totalSupplyAssets) / totalSupplyShares
    }

    const [loanToken, collateralToken] = marketParams[i] as unknown as [string, string, string, string, bigint]

    return {
      marketId,
      name: `${collateralSymbols[i]}/${loanSymbols[i]}`,
      loanToken,
      collateralToken,
      totalSupplyAssets,
      totalBorrowAssets,
      fee,
      vaultSupplyAssets,
      rateAtTarget: ratesAtTarget[i],
      cap,
      decimals: decimals[i],
      inSupplyQueue: supplySet.has(marketId as `0x${string}`),
      inWithdrawQueue: withdrawSet.has(marketId as `0x${string}`),
      withdrawQueueIndex: withdrawQueueOrder.get(marketId) ?? -1,
    }
  })

  const sumVaultSupply = markets.reduce((acc, m) => acc + m.vaultSupplyAssets, 0n)
  const idleAssets = totalAssets > sumVaultSupply ? totalAssets - sumVaultSupply : 0n

  return { markets, idleAssets }
}

/**
 * Fetch vault markets and compute the weighted APY in one call.
 * Returns null if the vault has no markets yet (not yet deployed).
 * Returns `apy`, `markets`, and `idleAssets` so callers can reuse for simulation.
 */
export async function fetchVaultApyViem(
  client: PublicClient,
  vaultAddress: string,
  morphoAddress: string,
  options?: { includeMarkets?: boolean },
): Promise<VaultApyResult | null> {
  const { markets, idleAssets } = await fetchVaultMarketsViem(client, vaultAddress, morphoAddress)
  if (markets.length === 0) return null
  const detailed = weightedVaultApyDetailed(markets)
  return { apy: detailed.apy, markets, idleAssets, marketDetails: options?.includeMarkets ? detailed.markets : [] }
}
