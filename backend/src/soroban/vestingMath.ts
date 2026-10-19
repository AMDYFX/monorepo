/**
 * Vesting maths for the vesting_schedule contract (#1883). This mirrors
 * `vested_amount` in contracts/vesting_schedule/src/lib.rs, so the stub adapter
 * behaves like the chain. Keep the two in sync.
 */

/**
 * Amount of an allocation that has vested at `now` (unix seconds).
 *
 * Returns 0 before the cliff and `total` at or after `end`. In between, vesting
 * is linear from `start` to `end`, rounded down. Arithmetic is exact (BigInt),
 * so the result matches the contract's integer result.
 */
export function vestedAmount(
  total: bigint,
  start: bigint,
  cliff: bigint,
  end: bigint,
  now: bigint,
): bigint {
  if (total <= 0n || now < cliff) return 0n
  if (now >= end) return total
  return (total * (now - start)) / (end - start)
}
