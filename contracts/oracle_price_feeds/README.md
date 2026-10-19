# Oracle Price Feeds

On-chain price oracle for NGN/USDC and other currency pairs, with multi-source updates, deviation guards, and staleness checks.

## Functions

### Admin Setup
- `init(admin: Address)` — One-time initialization; stores the admin.
- `pause(admin: Address)` — Blocks price updates until unpaused.
- `unpause(admin: Address)` — Re-enables price updates.
- `is_paused() -> bool` — Check pause state.

### Source Management
- `add_source(admin: Address, pair: Symbol, source: Address)` — Register a price source for a pair (admin only).
- `remove_source(admin: Address, pair: Symbol, source: Address)` — Deregister a source (admin only).
- `get_sources(pair: Symbol) -> Vec<Address>` — List all registered sources for a pair.
- `set_quorum(admin: Address, pair: Symbol, quorum: u32)` — Set the number of sources required for consensus (admin only).

### Configuration
- `set_staleness_threshold(admin: Address, threshold: u64)` — Set max age of a price in seconds (default 600s, admin only).
- `set_max_deviation_bps(admin: Address, bps: u32)` — Set max allowed deviation from current price in basis points (default 500 bps = 5%, admin only).

### Price Updates
- `update_price(source: Address, pair: Symbol, price: i128)` — Submit a price update.
  - Requires source authorization.
  - Rejects prices ≤ 0.
  - Rejects prices deviating more than `max_deviation_bps` from the current price.
  - Blocked while paused.
  - Emits `price_updated` event.

### Price Reads
- `get_price(pair: Symbol) -> PriceFeed` — Fetch the latest price feed.
  - Returns `{ pair, price, decimals, updated_at, sequence }`.
  - Returns error `PriceTooStale` if price is older than `staleness_threshold` or doesn't exist.
  - Decimals is always 7.

- `is_stale(pair: Symbol) -> bool` — Check if a price has exceeded the staleness threshold.
  - Returns error `UnknownPair` if the pair has no price history.

## Errors

- `NotAuthorized` (5001) — Unauthorized caller or unregistered source.
- `PriceTooStale` (5002) — Price exceeded staleness threshold.
- `InvalidPrice` (5003) — Price is non-positive (≤ 0).
- `InvalidDeviation` (5004) — Price deviates too far from current price.
- `UnknownPair` (5005) — No price history for the pair.
- `QuorumNotMet` (5006) — Reserved for future quorum enforcement.
- `Paused` (5007) — Contract is paused.

## Quorum Logic

Quorum is stored per pair but not currently enforced. Future versions may require N sources to agree within a threshold before a price update is finalized. Currently, any registered source can update the price independently.

## Precision

All prices are stored and returned with **7 decimals**.

## Events

- `initialized(admin: Address)` — Contract initialized.
- `source_added(pair: Symbol, source: Address)` — Source registered.
- `source_removed(pair: Symbol, source: Address)` — Source deregistered.
- `quorum_set(pair: Symbol, quorum: u32)` — Quorum updated.
- `price_updated(pair: Symbol, price: i128)` — Price submitted.
- `staleness_threshold_set(threshold: u64)` — Staleness threshold updated.
- `max_deviation_bps_set(bps: u32)` — Max deviation updated.
- `paused()` — Contract paused.
- `unpaused()` — Contract unpaused.
