# origin-morpho-utils

[![CI](https://github.com/OriginProtocol/morpho-utils/actions/workflows/ci.yml/badge.svg)](https://github.com/OriginProtocol/morpho-utils/actions/workflows/ci.yml)

Morpho Blue / MetaMorpho vault APY computation, deposit/withdrawal impact simulation, and max-amount binary search.

## Install

```bash
# From npm
pnpm add origin-morpho-utils

# From GitHub
pnpm add github:OriginProtocol/morpho-utils
```

## Usage

### RPC URL API (recommended)

No viem imports needed — just pass an RPC URL:

```typescript
import {
  fetchVaultApy,
  computeDepositImpactRpc,
  computeWithdrawalImpactRpc,
  findMaxDepositRpc,
} from 'origin-morpho-utils'

const RPC_URL = 'https://eth.llamarpc.com'
const vault = '0x5b8b...'

// Current APY
const result = await fetchVaultApy(RPC_URL, 1, vault)
console.log(result.apy) // e.g. 0.0423 (4.23%)

// With per-market breakdown
const detailed = await fetchVaultApy(RPC_URL, 1, vault, { includeMarkets: true })
detailed.marketDetails.forEach(m => {
  console.log(m.marketId, m.supplyApy, m.utilization, m.allocationPct)
})

// Deposit impact
const deposit = await computeDepositImpactRpc(RPC_URL, 1, vault, 1000000000000000000n)
console.log(deposit.impactBps)  // e.g. -12 (APY drops 0.12%)

// With per-market details
const depositDetailed = await computeDepositImpactRpc(RPC_URL, 1, vault, 1000000000000000000n, { includeMarkets: true })
depositDetailed.markets.forEach(m => {
  console.log(m.marketId, m.current.supplyApy, '→', m.simulated.supplyApy)
})

// Withdrawal impact
const withdrawal = await computeWithdrawalImpactRpc(RPC_URL, 1, vault, 1000000000000000000n)
console.log(withdrawal.impactBps)
console.log(withdrawal.isPartial) // true if insufficient liquidity

// Find max deposit within 50 bps APY impact
const maxDeposit = await findMaxDepositRpc(RPC_URL, 1, vault, 100000n * 10n**18n, 50)
console.log(maxDeposit.amount)    // largest deposit within threshold
console.log(maxDeposit.isCapped)  // true if limited by vault capacity
```

### viem PublicClient API

If you already have a viem client:

```typescript
import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { computeDepositImpact, fetchVaultApyViem } from 'origin-morpho-utils'

const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) })
const result = await fetchVaultApyViem(client, vault, '0xBBBB...EFFCb')
```

### CommonJS (require)

For non-TypeScript projects using `require()`:

```js
const { fetchVaultApy, computeDepositImpactRpc } = require('origin-morpho-utils')

const result = await fetchVaultApy('https://eth.llamarpc.com', 1, '0x5b8b...')
console.log(result.apy)
```

### Math-Only (Zero Dependencies)

For offline computation or validation without viem:

```typescript
import { estimateMarketApy, weightedVaultApyDetailed, simulateDeposit } from 'origin-morpho-utils/math'

const { supplyApy, borrowApy } = estimateMarketApy(0, 1000, 800, 0, 3_170_979_198)
```

### CLI

```bash
# Current APY
npx origin-morpho-utils apy \
  --rpc-url https://eth.llamarpc.com --chain-id 1 --vault 0x5b8b...

# APY with per-market breakdown
npx origin-morpho-utils apy \
  --rpc-url https://eth.llamarpc.com --chain-id 1 --vault 0x5b8b... --markets

# Deposit impact
npx origin-morpho-utils deposit-impact \
  --rpc-url https://eth.llamarpc.com --chain-id 1 --vault 0x5b8b... \
  --amount 1000000000000000000

# Find max deposit within 50 bps impact
npx origin-morpho-utils find-max-deposit \
  --rpc-url https://eth.llamarpc.com --chain-id 1 --vault 0x5b8b... \
  --amount 100000000000000000000 --max-impact 50

# Offline compute from JSON stdin
echo '{"markets": [...], "idleAssets": "0"}' | \
  npx origin-morpho-utils compute --deposit 1000000
```

CLI outputs JSON to stdout. BigInt fields are string-encoded. Use `--markets` on any command to include per-market details.

## API Reference

### Options

All RPC and viem functions accept an `options` object as the last parameter:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `morphoAddress` | string | Auto-detected from chainId | Morpho Blue singleton address |
| `includeMarkets` | boolean | `false` | Include per-market breakdown in results |
| `precision` | bigint | 1 whole token | Search granularity for find-max functions |
| `constraint` | `(state) => boolean \| Promise<boolean>` | — | Custom constraint for find-max functions (see below) |

### RPC URL Functions

**`fetchVaultApy(rpcUrl, chainId, vaultAddress, options?)`**
Returns `VaultApyResult | null` — `{ apy, markets, idleAssets, marketDetails }`.

**`fetchVaultMarkets(rpcUrl, chainId, vaultAddress, morphoAddress)`**
Returns `{ markets, idleAssets }` — raw market data for offline use.

**`computeDepositImpactRpc(rpcUrl, chainId, vaultAddress, depositAmount, options?)`**
Returns `{ currentApy, newApy, impact, impactBps, markets }`.

**`computeWithdrawalImpactRpc(rpcUrl, chainId, vaultAddress, withdrawAmount, options?)`**
Returns `{ currentApy, newApy, impact, impactBps, isPartial, withdrawableAmount, markets }`.

**`findMaxDepositRpc(rpcUrl, chainId, vaultAddress, maxAmount, maxImpactBps, options?)`**
Binary search for largest deposit within APY impact threshold.
Returns `{ amount, maxPossibleAmount, isMaxAmount, isCapped, impact }`.

**`findMaxWithdrawalRpc(rpcUrl, chainId, vaultAddress, maxAmount, maxImpactBps, options?)`**
Binary search for largest withdrawal within APY impact threshold.

### viem PublicClient Functions

Same as RPC functions but take a viem `PublicClient` instead of `rpcUrl`/`chainId`:

- `fetchVaultApyViem(client, vaultAddress, morphoAddress, options?)`
- `computeDepositImpact(client, chainId, vaultAddress, amount, options?)`
- `computeWithdrawalImpact(client, chainId, vaultAddress, amount, options?)`
- `findMaxDeposit(client, chainId, vaultAddress, maxAmount, maxImpactBps, options?)`
- `findMaxWithdrawal(client, chainId, vaultAddress, maxAmount, maxImpactBps, options?)`

### Pure Math (`origin-morpho-utils/math`)

**`estimateMarketApy(depositAmt, totalSupply, totalBorrows, fee, rateAtTarget)`**
Compute supply and borrow APY for a single Morpho Blue market.

**`weightedVaultApy(markets, depositSim?, withdrawalSim?)`**
Position-weighted vault APY. Returns a single number.

**`weightedVaultApyDetailed(markets, depositSim?, withdrawalSim?)`**
Same but returns `{ apy, markets: MarketApyDetail[] }` with per-market details.

**`simulateDeposit(markets, depositAmount)`** / **`simulateWithdrawal(markets, withdrawAmount, idleAssets)`**
Simulate how deposits/withdrawals flow through the queue.

**`findMaxDepositAmount(markets, maxAmount, maxImpactBps, options?)`** / **`findMaxWithdrawalAmount(markets, idleAssets, maxAmount, maxImpactBps, options?)`**
Pure math binary search (no RPC). Options: `{ precision?, includeMarkets? }`.

### Addresses

**`MORPHO_BLUE_ADDRESSES`** / **`getMorphoBlueAddress(chainId)`**

## Per-Market Details

When `includeMarkets: true`, impact results include a `markets` array of `MarketImpactDetail`:

```typescript
{
  marketId: string
  name: string             // "WETH/USDC" (collateral/loan symbols)
  current: {
    supplyApy: number      // 0-8.0
    borrowApy: number      // 0-8.0
    utilization: number    // 0-1
    allocationPct: number  // 0-1
    vaultSupplyAssets: bigint
  }
  simulated: { /* same shape */ }
}
```

For `fetchVaultApy`, the `marketDetails` array contains `MarketApyDetail` (same fields as above, without the `current`/`simulated` nesting).

## Impact Sign Convention

Impact values are signed as:

```typescript
impact = newApy - currentApy
impactBps = round(impact * 10000)
```

- negative impact means APY decreased
- positive impact means APY increased

## Numerical Precision Notes

This library converts on-chain `bigint` balances to JavaScript `number` for APY math.

Because IEEE-754 doubles have 53 bits of integer precision, precision loss starts when raw base units exceed `2^53`:

- 18 decimals: `2^53 / 1e18 = 0.009007199254740993` tokens
- 6 decimals: `2^53 / 1e6 = 9,007,199,254.740992` tokens

This does not automatically imply large APY error; it usually starts as tiny base-unit rounding.

Approximate 18-decimal token magnitudes where floating spacing reaches:

- `1e-12` tokens at ~`4.72e3` tokens
- `1e-9` tokens at ~`4.84e6` tokens
- `1e-6` tokens at ~`4.95e9` tokens
- `1e-3` tokens at ~`5.07e12` tokens
- `0.1` tokens at ~`6.49e14` tokens
- `1` token at ~`5.19e15` tokens

At runtime, the math layer emits a one-time warning per market when estimated token spacing reaches `1e-6` tokens or higher.

## Custom Constraints

The `findMaxDeposit*` and `findMaxWithdrawal*` functions accept an optional `constraint` callback that adds custom criteria beyond APY impact. The binary search finds the largest amount satisfying **both** the APY impact threshold and the custom constraint.

```typescript
const result = await findMaxDepositRpc(RPC_URL, 1, vault, 100000n * 10n**18n, 50, {
  includeMarkets: true,
  constraint: (state) => {
    // Keep target market utilization under 80%
    const market = state.markets.find(m => m.marketId === targetId)
    return !market || market.simulated.utilization <= 0.8
  },
})
```

The callback receives `FindMaxConstraintState`:

```typescript
{
  amount: bigint              // candidate amount being tested
  currentApy: number          // vault APY before the action
  simulatedApy: number        // vault APY after the action
  impactBps: number           // APY change in basis points
  markets: MarketImpactDetail[]  // per-market current vs simulated
  isPartial?: boolean         // withdrawal only: liquidity-constrained
  withdrawableAmount?: bigint // withdrawal only: actual removable amount
}
```

The constraint can be sync or async (return `boolean` or `Promise<boolean>`).

**Important:** The constraint must be **monotonic** — if amount X fails, all amounts > X must also fail. Non-monotonic constraints (e.g., "utilization between 70% and 85%") will produce incorrect results. For constraint-only mode (no APY threshold), set `maxImpactBps` to `10000` (100%).

## Algorithm Documentation

See [docs/algorithm.md](docs/algorithm.md) for detailed math, pseudocode, and on-chain data requirements.

## Development

```bash
pnpm install
pnpm build                 # ESM + CJS + types
pnpm test                  # Unit tests
pnpm dev -- apy --rpc-url $RPC --chain-id 1 --vault 0x5b8b...   # Run CLI from source
```

### Publishing

```bash
pnpm build
npm publish
```
