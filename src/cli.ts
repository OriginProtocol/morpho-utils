#!/usr/bin/env node
import { findMaxDepositAmount, findMaxWithdrawalAmount } from './find-max.js'
import { simulateDeposit, simulateWithdrawal, weightedVaultApy, weightedVaultApyDetailed } from './math.js'
import {
  computeDepositImpactRpc,
  computeWithdrawalImpactRpc,
  fetchVaultApy,
  findMaxDepositRpc,
  findMaxWithdrawalRpc,
} from './rpc.js'
import type { MarketForApy } from './types.js'

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, jsonReplacer, 2))
}

function usage(): never {
  console.error(`Usage: morpho-utils <command> [options]

Commands:
  apy                 Fetch current vault APY
  deposit-impact      Simulate deposit APY impact
  withdraw-impact     Simulate withdrawal APY impact
  find-max-deposit    Find max deposit within APY impact threshold
  find-max-withdraw   Find max withdrawal within APY impact threshold
  compute             Compute APY from JSON market data on stdin (offline, no RPC)

Options:
  --rpc-url <url>       RPC endpoint (required for RPC commands)
  --chain-id <number>   Chain ID (required for RPC commands)
  --vault <address>     MetaMorpho vault address (required for RPC commands)
  --morpho <address>    Morpho Blue address override (optional)
  --amount <string>     Amount in base units (required for impact/find-max commands)
  --max-impact <number> Max APY impact in bps (for find-max or compute with --deposit/--withdraw)
  --precision <string>  Search precision in base units (optional, default: 1 whole token)
  --deposit <string>    Deposit amount for offline compute
  --withdraw <string>   Withdrawal amount for offline compute
  --markets             Include per-market details in output`)
  process.exit(1)
}

const BOOLEAN_FLAGS = new Set(['markets'])

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue
    const key = args[i].slice(2)
    if (BOOLEAN_FLAGS.has(key)) {
      result[key] = 'true'
    } else if (i + 1 < args.length) {
      result[key] = args[i + 1]
      i++
    }
  }
  return result
}

function requireArg(opts: Record<string, string>, key: string): string {
  if (!opts[key]) {
    console.error(`Error: --${key} is required`)
    process.exit(1)
  }
  return opts[key]
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function parseMarkets(data: { markets: Record<string, string | number | boolean>[]; idleAssets?: string }): {
  markets: MarketForApy[]
  idleAssets: bigint
} {
  return {
    markets: data.markets.map((m) => ({
      marketId: String(m.marketId),
      name: m.name ? String(m.name) : undefined,
      loanToken: m.loanToken ? String(m.loanToken) : undefined,
      collateralToken: m.collateralToken ? String(m.collateralToken) : undefined,
      totalSupplyAssets: BigInt(m.totalSupplyAssets),
      totalBorrowAssets: BigInt(m.totalBorrowAssets),
      fee: BigInt(m.fee),
      vaultSupplyAssets: BigInt(m.vaultSupplyAssets),
      rateAtTarget: BigInt(m.rateAtTarget),
      decimals: Number(m.decimals),
      inSupplyQueue: Boolean(m.inSupplyQueue),
      inWithdrawQueue: Boolean(m.inWithdrawQueue),
      withdrawQueueIndex: Number(m.withdrawQueueIndex),
      cap: BigInt(m.cap),
    })),
    idleAssets: BigInt(data.idleAssets ?? '0'),
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command) usage()

  const opts = parseArgs(rest)

  if (command === 'compute') {
    const input = JSON.parse(await readStdin())
    const { markets, idleAssets } = parseMarkets(input)
    const maxImpactBps = opts['max-impact'] ? Number(opts['max-impact']) : undefined
    const precision = opts.precision ? BigInt(opts.precision) : undefined

    const includeMarkets = opts.markets === 'true'

    if (opts.deposit) {
      const amount = BigInt(opts.deposit)
      if (maxImpactBps !== undefined) {
        const result = await findMaxDepositAmount(markets, amount, maxImpactBps, { precision, includeMarkets })
        printJson(result)
      } else {
        const sim = simulateDeposit(markets, amount)
        const currentApy = weightedVaultApy(markets)
        const newApy = weightedVaultApy(markets, sim)
        const impact = newApy - currentApy
        printJson({ currentApy, newApy, impact, impactBps: Math.round(impact * 10000) })
      }
    } else if (opts.withdraw) {
      const amount = BigInt(opts.withdraw)
      if (maxImpactBps !== undefined) {
        const result = await findMaxWithdrawalAmount(markets, idleAssets, amount, maxImpactBps, {
          precision,
          includeMarkets,
        })
        printJson(result)
      } else {
        const { sim, withdrawable, remaining } = simulateWithdrawal(markets, amount, idleAssets)
        const currentApy = weightedVaultApy(markets)
        const totalVaultAssets = markets.reduce((acc, m) => acc + m.vaultSupplyAssets, 0n) + idleAssets
        const newApy = withdrawable >= totalVaultAssets ? 0 : weightedVaultApy(markets, {}, sim)
        const impact = newApy - currentApy
        printJson({
          currentApy,
          newApy,
          impact,
          impactBps: Math.round(impact * 10000),
          isPartial: remaining > 0n,
          withdrawableAmount: withdrawable.toString(),
        })
      }
    } else {
      if (includeMarkets) {
        const detailed = weightedVaultApyDetailed(markets)
        printJson({ apy: detailed.apy, markets: detailed.markets })
      } else {
        printJson({ apy: weightedVaultApy(markets) })
      }
    }
    return
  }

  // RPC-based commands
  const rpcUrl = requireArg(opts, 'rpc-url')
  const chainId = Number(requireArg(opts, 'chain-id'))
  const vaultAddress = requireArg(opts, 'vault')
  const morphoAddress = opts.morpho
  const includeMarkets = opts.markets === 'true'

  if (command === 'apy') {
    const result = await fetchVaultApy(rpcUrl, chainId, vaultAddress, { morphoAddress, includeMarkets })
    printJson(
      result
        ? { apy: result.apy, idleAssets: result.idleAssets, markets: result.marketDetails }
        : { apy: 0, markets: [] },
    )
  } else if (command === 'deposit-impact') {
    const amount = BigInt(requireArg(opts, 'amount'))
    const result = await computeDepositImpactRpc(rpcUrl, chainId, vaultAddress, amount, {
      morphoAddress,
      includeMarkets,
    })
    printJson(result)
  } else if (command === 'withdraw-impact') {
    const amount = BigInt(requireArg(opts, 'amount'))
    const result = await computeWithdrawalImpactRpc(rpcUrl, chainId, vaultAddress, amount, {
      morphoAddress,
      includeMarkets,
    })
    printJson(result)
  } else if (command === 'find-max-deposit') {
    const amount = BigInt(requireArg(opts, 'amount'))
    const maxImpactBps = Number(requireArg(opts, 'max-impact'))
    const precision = opts.precision ? BigInt(opts.precision) : undefined
    const result = await findMaxDepositRpc(rpcUrl, chainId, vaultAddress, amount, maxImpactBps, {
      precision,
      morphoAddress,
      includeMarkets,
    })
    printJson(result)
  } else if (command === 'find-max-withdraw') {
    const amount = BigInt(requireArg(opts, 'amount'))
    const maxImpactBps = Number(requireArg(opts, 'max-impact'))
    const precision = opts.precision ? BigInt(opts.precision) : undefined
    const result = await findMaxWithdrawalRpc(rpcUrl, chainId, vaultAddress, amount, maxImpactBps, {
      precision,
      morphoAddress,
      includeMarkets,
    })
    printJson(result)
  } else {
    console.error(`Unknown command: ${command}`)
    usage()
  }
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
