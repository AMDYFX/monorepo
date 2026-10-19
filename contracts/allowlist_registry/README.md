# Allowlist Registry

On-chain allowlist for KYC-verified wallets with expiry support and bulk operations.

## Functions

### Admin Setup
- `initialize(admin: Address)` — One-time initialization; stores the admin.

### Member Management
- `add(address: Address, label: String, expires_at: u64)` — Add or update a member (admin only).
  - `expires_at = 0` means no expiry; member remains valid indefinitely.
  - Re-adding an existing member updates its label and expiry time.
  - Emits `added` event.

- `remove(address: Address)` — Remove a member from the allowlist (admin only).
  - Returns error `NotFound` if the address is not a member.
  - Emits `removed` event.

- `is_member(address: Address) -> bool` — Check if an address is an active member.
  - Returns `false` if the address is not a member.
  - Returns `false` if the member is expired (`current_time > expires_at`).
  - Returns `true` if `expires_at = 0` (no expiry) or if the member is not yet expired.

- `get_entry(address: Address) -> AllowlistEntry` — Retrieve the full entry for an address.
  - Returns `{ label, expires_at, added_at }` where `added_at` is the ledger sequence at the time of addition.
  - Returns error `NotFound` if the address is not a member.

- `bulk_add(entries: Vec<(Address, String, u64)>) -> Result<(), ContractError>` — Add multiple members in one call.
  - Maximum batch size: 100 entries.
  - Returns error `BulkSizeExceeded` if more than 100 entries are provided.
  - Re-adds within a batch update existing members.
  - Emits `added` event for each entry.

- `member_count() -> u32` — Return the total number of members.

## Errors

- `NotAuthorized` (6001) — Caller is not the admin.
- `NotFound` (6002) — Address not found in the allowlist or attempting to remove a non-existent member.
- `BulkSizeExceeded` (6003) — Bulk operation exceeds the maximum batch size (100).

## Events

- `initialized(admin: Address)` — Contract initialized.
- `added(address: Address, label: String, expires_at: u64)` — Member added or updated.
- `removed(address: Address)` — Member removed.

## Expiry Logic

- If `expires_at = 0`, the member never expires.
- If `expires_at > 0`, the member is valid until `current_time <= expires_at`.
- Once `current_time > expires_at`, `is_member()` returns `false`, but `get_entry()` still returns the entry (callers must check `is_member()` separately for validity).
- Expired entries remain in storage and count toward `member_count()`. Use `remove()` to delete them explicitly.
