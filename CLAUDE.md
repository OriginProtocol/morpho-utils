# CLAUDE.md

## Project Overview

TypeScript library for Morpho Blue / MetaMorpho vault APY computation, deposit/withdrawal impact simulation, and max-amount binary search. Published as `origin-morpho-utils`. Dual-format output (ESM + CJS) via tsup.

## Common Commands

```bash
pnpm install          # Install dependencies
pnpm build            # ESM + CJS + types (tsup)
pnpm test             # Unit tests (vitest)
pnpm test:watch       # Watch mode
pnpm lint             # ESLint
pnpm lint:fix         # ESLint with auto-fix
pnpm prettier-check   # Check formatting
pnpm prettier-fix     # Auto-format
pnpm typecheck        # TypeScript type checking (tsc --noEmit)
pnpm dev -- <command> # Run CLI from source (tsx)
```

## Architecture

Three API layers, each wrapping the one below:

1. **Pure math** (`src/math.ts`, `src/find-max.ts`) — zero dependencies, fully unit-testable. Exported via `origin-morpho-utils/math` subpath.
2. **viem layer** (`src/fetch.ts`, `src/deposit-impact.ts`, `src/withdrawal-impact.ts`, `src/find-max-impact.ts`) — takes a viem `PublicClient`, fetches on-chain data, delegates math to layer 1.
3. **RPC URL layer** (`src/rpc.ts`) — convenience wrappers that create a viem client internally so consumers don't need viem imports.

CLI (`src/cli.ts`) uses both layer 1 (offline `compute` command) and layer 3 (RPC commands).

### Key Files

- `src/types.ts` — all shared TypeScript interfaces
- `src/math.ts` — IRM curve math, APY estimation, deposit/withdrawal simulation
- `src/find-max.ts` — binary search for max deposit/withdrawal within APY impact threshold
- `src/fetch.ts` — on-chain data fetching via multicall (vault config, market state, IRM params)
- `src/rpc.ts` — RPC URL convenience wrappers
- `src/addresses.ts` — Morpho Blue contract addresses per chain
- `src/abi/` — TypeScript ABI constants (morpho, meta-morpho, IRM, ERC20)
- `docs/algorithm.md` — detailed math documentation

### Build

tsup compiles three entry points: `index.ts`, `math.ts`, `cli.ts`. Output is ESM + CJS with `.d.ts` declarations and source maps. Config in `tsup.config.ts`.

## Code Conventions

- No semicolons, single quotes, 2-space indent, trailing commas (enforced by prettier)
- Import ordering enforced by `@trivago/prettier-plugin-sort-imports`
- All BigInt values use native `bigint` (not ethers BigNumber)
- Math layer functions are pure — no side effects, no RPC calls
- Binary search functions are async (to support async constraint callbacks)

## Testing

- Framework: vitest
- Test files: `test/math.test.ts`, `test/find-max.test.ts`
- Tests use mock market data (no RPC calls) — fully offline
- Helper: `makeMarket()` creates a `MarketForApy` with sensible defaults
