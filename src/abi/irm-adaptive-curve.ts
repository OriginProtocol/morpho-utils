/** Minimal IRM Adaptive Curve ABI — rateAtTarget only. */
export const irmAdaptiveCurveAbi = [
  {
    inputs: [{ name: 'id', type: 'bytes32' }],
    name: 'rateAtTarget',
    outputs: [{ name: '', type: 'int256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const
