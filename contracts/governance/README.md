# Governance

Stake-weighted voting on platform parameters (fees, reward rates, thresholds).

Stakers propose a change to a named parameter, vote on it, and, if it passes,
execute it after a timelock. Execution records the decision as an event. The
contract does not apply the new value to other contracts. That step is done
off-chain or by the admin.

## Data

### `Proposal`

| Field                       | Type             | Meaning                                                          |
| --------------------------- | ---------------- | ---------------------------------------------------------------- |
| `id`                        | `u64`            | Sequential, starting at 1.                                       |
| `proposer`                  | `Address`        | Creator. May cancel the proposal while it is active.             |
| `param_key`                 | `Symbol`         | Name of the parameter being changed.                             |
| `current_value`             | `i128`           | Value at the time of proposal.                                   |
| `proposed_value`            | `i128`           | Requested value.                                                 |
| `votes_for`                 | `i128`           | Sum of voter stake voting for.                                   |
| `votes_against`             | `i128`           | Sum of voter stake voting against.                               |
| `status`                    | `ProposalStatus` | See the lifecycle below.                                         |
| `created_at`                | `u64`            | Ledger timestamp at creation (seconds).                          |
| `voting_ends_at`            | `u64`            | `created_at + VOTING_PERIOD`.                                    |
| `snapshotted_total_staked`  | `i128`           | Total stake when the proposal was created. Quorum uses this.     |

### Constants

| Name                         | Value                  | Meaning                                                           |
| ---------------------------- | ---------------------- | ----------------------------------------------------------------- |
| `VOTING_PERIOD`              | 604 800 s (7 days)     | Length of the voting window.                                      |
| `EXECUTION_DELAY`            | 172 800 s (48 hours)   | Timelock between the end of voting and execution.                 |
| `QUORUM_BPS`                 | 1 000 (10%)            | Turnout required, as a share of `snapshotted_total_staked`.       |
| `DEFAULT_MIN_PROPOSER_STAKE` | 1                      | Initial minimum stake to propose. The admin can change it.        |

## Lifecycle

```
            create_proposal
                  │
                  ▼
   ┌──────────── Active ────────────┐
   │ cancel_proposal               │ finalize_proposal (after voting ends)
   ▼ (proposer or admin)           ▼
 Cancelled             Passed ───────────── Rejected
                          │
                          │ execute_proposal (after voting ends + EXECUTION_DELAY)
                          ▼
                       Executed
```

- **Active.** Anyone with stake can vote until `voting_ends_at`. The proposer or
  the admin can cancel.
- **Passed / Rejected.** Set by `finalize_proposal`, which anyone can call once
  voting has ended. A proposal passes when:
  - turnout (`votes_for + votes_against`) is at least `snapshotted_total_staked × QUORUM_BPS / 10 000`, and
  - `votes_for > votes_against`.
  A tie fails. Turnout exactly equal to quorum passes.
- **Executed.** Set by `execute_proposal`, which anyone can call once
  `voting_ends_at + EXECUTION_DELAY` has passed. It emits `executed` with the
  `param_key` and `proposed_value`.

## Entry points

| Function                                      | Auth                  | Notes                                                             |
| --------------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| `init(admin, total_staked)`                   | `admin`               | Runs once.                                                        |
| `set_total_staked(admin, total_staked)`       | admin                 | Total stake used for future snapshots.                            |
| `set_voter_stake(admin, voter, stake)`        | admin                 | Mirrors a voter's stake from `staking_pool`. This is their weight. |
| `set_min_proposer_stake(admin, min_stake)`    | admin                 | Minimum stake to create a proposal.                               |
| `create_proposal(proposer, param_key, current, proposed) -> u64` | `proposer`  | Needs stake ≥ minimum and `current ≠ proposed`.                   |
| `vote(voter, proposal_id, support)`           | `voter`               | Weight is the voter's stake. One vote per address, before the deadline. |
| `finalize_proposal(proposal_id) -> ProposalStatus` | none             | Only after voting ends. Records Passed or Rejected.               |
| `execute_proposal(proposal_id)`               | none                  | Only for Passed proposals, after the timelock.                    |
| `cancel_proposal(caller, proposal_id)`        | `caller`              | Proposer or admin, only while Active.                             |
| `pause(admin)` / `unpause(admin)`             | admin                 | Blocks `create_proposal` and `vote` while paused.                 |
| `get_proposal`, `proposal_count`, `voter_stake`, `total_staked`, `has_voted` | none | Read-only.                                             |

## Events

Every state-changing function emits an event under the topic `governance`:
`initialized`, `total_staked`, `stake_set`, `min_stake_set`, `proposal_created`,
`voted`, `finalized`, `executed`, `cancelled`, `paused`, and `unpaused`.

## Notes

- Vote weight is read at vote time, and quorum is measured against the total
  stake snapshotted at proposal time. The admin keeps both in sync with
  `staking_pool`.
- Delegated voting is not supported.
- The contract does not apply `proposed_value` anywhere. Execution emits an
  event for off-chain or admin action.
