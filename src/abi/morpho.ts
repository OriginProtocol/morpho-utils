/** Minimal Morpho Blue ABI — only view functions used by fetchVaultMarketsViem. */
export const morphoAbi = [
  {
    inputs: [{ name: 'id', type: 'bytes32' }],
    name: 'market',
    outputs: [
      { name: 'totalSupplyAssets', type: 'uint128' },
      { name: 'totalSupplyShares', type: 'uint128' },
      { name: 'totalBorrowAssets', type: 'uint128' },
      { name: 'totalBorrowShares', type: 'uint128' },
      { name: 'lastUpdate', type: 'uint128' },
      { name: 'fee', type: 'uint128' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'user', type: 'address' },
    ],
    name: 'position',
    outputs: [
      { name: 'supplyShares', type: 'uint256' },
      { name: 'borrowShares', type: 'uint128' },
      { name: 'collateral', type: 'uint128' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'id', type: 'bytes32' }],
    name: 'idToMarketParams',
    outputs: [
      { name: 'loanToken', type: 'address' },
      { name: 'collateralToken', type: 'address' },
      { name: 'oracle', type: 'address' },
      { name: 'irm', type: 'address' },
      { name: 'lltv', type: 'uint256' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const
