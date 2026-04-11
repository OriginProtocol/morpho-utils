/** Minimal MetaMorpho (ERC4626 vault) ABI — only view functions used by fetchVaultMarketsViem. */
export const metaMorphoAbi = [
  {
    inputs: [],
    name: 'supplyQueueLength',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'withdrawQueueLength',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalAssets',
    outputs: [{ name: 'totalManagedAssets', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'supplyQueue',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'uint256' }],
    name: 'withdrawQueue',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: '', type: 'bytes32' }],
    name: 'config',
    outputs: [
      { name: 'cap', type: 'uint184' },
      { name: 'enabled', type: 'bool' },
      { name: 'removableAt', type: 'uint64' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
] as const
