/** Well-known Morpho Blue singleton addresses per chain. */
export const MORPHO_BLUE_ADDRESSES: Record<number, `0x${string}`> = {
  1: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', // Ethereum
  8453: '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', // Base
  999: '0x68e37de8d93d3496ae143f2e900490f6280c57cd', // HyperEVM
}

/** Look up Morpho Blue singleton address by chain ID. Throws if unknown. */
export function getMorphoBlueAddress(chainId: number): `0x${string}` {
  const addr = MORPHO_BLUE_ADDRESSES[chainId]
  if (!addr) {
    throw new Error(
      `No Morpho Blue address configured for chainId ${chainId}. ` +
        `Known chains: ${Object.keys(MORPHO_BLUE_ADDRESSES).join(', ')}`,
    )
  }
  return addr
}
