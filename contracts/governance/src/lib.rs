#![no_std]

//! Stake-weighted governance for platform parameters.
//!
//! Stakers propose a change to a named parameter, then vote for or against it.
//! Vote weight is the voter's stake, as mirrored by the admin from the staking
//! pool. A proposal passes when turnout reaches the quorum and `for` exceeds
//! `against`. A passed proposal can be executed once its timelock has elapsed.
//! Execution emits an event. It does not change any other contract, so the
//! parameter must be applied off-chain or by the admin.
//!
//! See `README.md` for the full lifecycle.

use soroban_access_control::{deny, extend_storage_ttl, require_admin_permission};
use soroban_pausable::{Pausable, PausableError};
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, IntoVal, Symbol,
};

/// Length of the voting window, in seconds (7 days).
pub const VOTING_PERIOD: u64 = 7 * 24 * 60 * 60;
/// Delay between the end of voting and execution, in seconds (48 hours).
pub const EXECUTION_DELAY: u64 = 48 * 60 * 60;
/// Quorum as a share of the snapshotted total stake, in basis points (10%).
pub const QUORUM_BPS: i128 = 1_000;
/// Default minimum stake needed to create a proposal. Adjustable by the admin.
pub const DEFAULT_MIN_PROPOSER_STAKE: i128 = 1;

const BPS_DENOMINATOR: i128 = 10_000;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Paused,
    TotalStaked,
    MinProposerStake,
    Stake(Address),
    ProposalCount,
    Proposal(u64),
    /// Present once an address has voted on a proposal. The value is the vote.
    Vote(u64, Address),
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Passed,
    Rejected,
    Executed,
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub param_key: Symbol,
    pub current_value: i128,
    pub proposed_value: i128,
    pub votes_for: i128,
    pub votes_against: i128,
    pub status: ProposalStatus,
    pub created_at: u64,
    pub voting_ends_at: u64,
    /// Total stake when the proposal was created. Quorum is measured against it.
    pub snapshotted_total_staked: i128,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ContractError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAuthorized = 3,
    Paused = 4,
    InvalidAmount = 5,
    InsufficientStake = 6,
    InvalidProposal = 7,
    ProposalNotFound = 8,
    InvalidStatus = 9,
    VotingClosed = 10,
    VotingStillOpen = 11,
    AlreadyVoted = 12,
    TimelockActive = 13,
}

/// Minimum votes (for + against) needed for a proposal to pass.
pub fn quorum_threshold(snapshotted_total_staked: i128) -> Option<i128> {
    snapshotted_total_staked
        .checked_mul(QUORUM_BPS)
        .map(|scaled| scaled / BPS_DENOMINATOR)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(10_000, 500_000);
}

fn get_admin(env: &Env) -> Result<Address, ContractError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ContractError::NotInitialized)
}

fn require_admin(env: &Env, caller: &Address, operation: &str) -> Result<(), ContractError> {
    let admin = get_admin(env)?;
    require_admin_permission(env, &admin, caller, operation, ContractError::NotAuthorized)
}

fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&DataKey::Paused)
        .unwrap_or(false)
}

fn require_not_paused(env: &Env) -> Result<(), ContractError> {
    if is_paused(env) {
        return Err(ContractError::Paused);
    }
    Ok(())
}

fn get_stake(env: &Env, account: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Stake(account.clone()))
        .unwrap_or(0)
}

fn put_stake(env: &Env, account: &Address, stake: i128) {
    let key = DataKey::Stake(account.clone());
    env.storage().persistent().set(&key, &stake);
    extend_storage_ttl(env, &key.into_val(env));
}

fn get_total_staked(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalStaked)
        .unwrap_or(0)
}

fn get_proposal(env: &Env, proposal_id: u64) -> Result<Proposal, ContractError> {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(proposal_id))
        .ok_or(ContractError::ProposalNotFound)
}

fn put_proposal(env: &Env, proposal: &Proposal) {
    let key = DataKey::Proposal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    extend_storage_ttl(env, &key.into_val(env));
}

fn proposal_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::ProposalCount)
        .unwrap_or(0)
}

#[contract]
pub struct Governance;

#[contractimpl]
impl Pausable for Governance {
    fn pause(env: Env, admin: Address) -> Result<(), PausableError> {
        require_admin(&env, &admin, "pause").map_err(|_| PausableError::NotAuthorized)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        bump_instance(&env);
        env.events().publish(
            (Symbol::new(&env, "governance"), Symbol::new(&env, "paused")),
            admin,
        );
        Ok(())
    }

    fn unpause(env: Env, admin: Address) -> Result<(), PausableError> {
        require_admin(&env, &admin, "unpause").map_err(|_| PausableError::NotAuthorized)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        bump_instance(&env);
        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "unpaused"),
            ),
            admin,
        );
        Ok(())
    }

    fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }
}

#[contractimpl]
impl Governance {
    /// Set the admin and the initial total stake. Can only run once.
    pub fn init(env: Env, admin: Address, total_staked: i128) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        if total_staked < 0 {
            return Err(ContractError::InvalidAmount);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::TotalStaked, &total_staked);
        env.storage()
            .instance()
            .set(&DataKey::MinProposerStake, &DEFAULT_MIN_PROPOSER_STAKE);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage().instance().set(&DataKey::Paused, &false);
        bump_instance(&env);

        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "initialized"),
            ),
            (admin, total_staked),
        );
        Ok(())
    }

    /// Update the total stake that quorum is measured against for new proposals.
    pub fn set_total_staked(
        env: Env,
        admin: Address,
        total_staked: i128,
    ) -> Result<(), ContractError> {
        require_admin(&env, &admin, "set_total_staked")?;
        if total_staked < 0 {
            return Err(ContractError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::TotalStaked, &total_staked);
        bump_instance(&env);
        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "total_staked"),
            ),
            total_staked,
        );
        Ok(())
    }

    /// Mirror a voter's stake from the staking pool. Used as their vote weight.
    pub fn set_voter_stake(
        env: Env,
        admin: Address,
        voter: Address,
        stake: i128,
    ) -> Result<(), ContractError> {
        require_admin(&env, &admin, "set_voter_stake")?;
        if stake < 0 {
            return Err(ContractError::InvalidAmount);
        }
        put_stake(&env, &voter, stake);
        bump_instance(&env);
        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "stake_set"),
                voter,
            ),
            stake,
        );
        Ok(())
    }

    /// Set the minimum stake a proposer must hold. Only the admin may change it.
    pub fn set_min_proposer_stake(
        env: Env,
        admin: Address,
        min_stake: i128,
    ) -> Result<(), ContractError> {
        require_admin(&env, &admin, "set_min_proposer_stake")?;
        if min_stake < 0 {
            return Err(ContractError::InvalidAmount);
        }
        env.storage()
            .instance()
            .set(&DataKey::MinProposerStake, &min_stake);
        bump_instance(&env);
        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "min_stake_set"),
            ),
            min_stake,
        );
        Ok(())
    }

    /// Open a proposal to change `param_key` from `current_value` to
    /// `proposed_value`. Returns the new proposal id.
    pub fn create_proposal(
        env: Env,
        proposer: Address,
        param_key: Symbol,
        current_value: i128,
        proposed_value: i128,
    ) -> Result<u64, ContractError> {
        proposer.require_auth();
        require_not_paused(&env)?;

        if current_value == proposed_value {
            return Err(ContractError::InvalidProposal);
        }
        let min_stake: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinProposerStake)
            .unwrap_or(DEFAULT_MIN_PROPOSER_STAKE);
        let stake = get_stake(&env, &proposer);
        if stake <= 0 || stake < min_stake {
            return Err(ContractError::InsufficientStake);
        }

        let now = env.ledger().timestamp();
        let id = proposal_count(&env) + 1;
        let proposal = Proposal {
            id,
            proposer: proposer.clone(),
            param_key: param_key.clone(),
            current_value,
            proposed_value,
            votes_for: 0,
            votes_against: 0,
            status: ProposalStatus::Active,
            created_at: now,
            voting_ends_at: now + VOTING_PERIOD,
            snapshotted_total_staked: get_total_staked(&env),
        };
        put_proposal(&env, &proposal);
        env.storage().instance().set(&DataKey::ProposalCount, &id);
        bump_instance(&env);

        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "proposal_created"),
                proposer,
            ),
            (id, param_key, proposed_value),
        );
        Ok(id)
    }

    /// Vote on an active proposal before its voting window closes. The vote
    /// weight is the voter's current stake. Each address may vote once.
    pub fn vote(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: bool,
    ) -> Result<(), ContractError> {
        voter.require_auth();
        require_not_paused(&env)?;

        let mut proposal = get_proposal(&env, proposal_id)?;
        if proposal.status != ProposalStatus::Active {
            return Err(ContractError::InvalidStatus);
        }
        if env.ledger().timestamp() >= proposal.voting_ends_at {
            return Err(ContractError::VotingClosed);
        }
        let vote_key = DataKey::Vote(proposal_id, voter.clone());
        if env.storage().persistent().has(&vote_key) {
            return Err(ContractError::AlreadyVoted);
        }
        let weight = get_stake(&env, &voter);
        if weight <= 0 {
            return Err(ContractError::InsufficientStake);
        }

        if support {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(weight)
                .ok_or(ContractError::InvalidAmount)?;
        } else {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(weight)
                .ok_or(ContractError::InvalidAmount)?;
        }

        env.storage().persistent().set(&vote_key, &support);
        extend_storage_ttl(&env, &vote_key.into_val(&env));
        put_proposal(&env, &proposal);
        bump_instance(&env);

        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "voted"),
                voter,
            ),
            (proposal_id, support, weight),
        );
        Ok(())
    }

    /// Close voting and record the outcome. Anyone can call this after the
    /// voting window ends. The proposal passes if turnout reaches quorum and
    /// `for` exceeds `against`. Otherwise it is rejected.
    pub fn finalize_proposal(env: Env, proposal_id: u64) -> Result<ProposalStatus, ContractError> {
        let mut proposal = get_proposal(&env, proposal_id)?;
        if proposal.status != ProposalStatus::Active {
            return Err(ContractError::InvalidStatus);
        }
        if env.ledger().timestamp() < proposal.voting_ends_at {
            return Err(ContractError::VotingStillOpen);
        }

        let turnout = proposal.votes_for + proposal.votes_against;
        let quorum = quorum_threshold(proposal.snapshotted_total_staked)
            .ok_or(ContractError::InvalidAmount)?;
        let passed = turnout >= quorum && proposal.votes_for > proposal.votes_against;

        proposal.status = if passed {
            ProposalStatus::Passed
        } else {
            ProposalStatus::Rejected
        };
        put_proposal(&env, &proposal);
        bump_instance(&env);

        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "finalized"),
            ),
            (proposal_id, proposal.status),
        );
        Ok(proposal.status)
    }

    /// Mark a passed proposal as executed once its timelock has elapsed. The
    /// timelock runs from the end of voting. Anyone can call this. The event
    /// carries the parameter and the new value for off-chain or admin action.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<(), ContractError> {
        let mut proposal = get_proposal(&env, proposal_id)?;
        if proposal.status != ProposalStatus::Passed {
            return Err(ContractError::InvalidStatus);
        }
        let executable_at = proposal.voting_ends_at.saturating_add(EXECUTION_DELAY);
        if env.ledger().timestamp() < executable_at {
            return Err(ContractError::TimelockActive);
        }

        proposal.status = ProposalStatus::Executed;
        put_proposal(&env, &proposal);
        bump_instance(&env);

        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "executed"),
            ),
            (proposal_id, proposal.param_key, proposal.proposed_value),
        );
        Ok(())
    }

    /// Cancel an active proposal. The proposer or the admin may do this.
    pub fn cancel_proposal(
        env: Env,
        caller: Address,
        proposal_id: u64,
    ) -> Result<(), ContractError> {
        caller.require_auth();

        let mut proposal = get_proposal(&env, proposal_id)?;
        if proposal.status != ProposalStatus::Active {
            return Err(ContractError::InvalidStatus);
        }
        let admin = get_admin(&env)?;
        if caller != proposal.proposer && caller != admin {
            return Err(deny(
                &env,
                &caller,
                "cancel_proposal",
                ContractError::NotAuthorized,
            ));
        }

        proposal.status = ProposalStatus::Cancelled;
        put_proposal(&env, &proposal);
        bump_instance(&env);

        env.events().publish(
            (
                Symbol::new(&env, "governance"),
                Symbol::new(&env, "cancelled"),
            ),
            (proposal_id, caller),
        );
        Ok(())
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(proposal_id))
    }

    pub fn proposal_count(env: Env) -> u64 {
        proposal_count(&env)
    }

    pub fn voter_stake(env: Env, voter: Address) -> i128 {
        get_stake(&env, &voter)
    }

    pub fn total_staked(env: Env) -> i128 {
        get_total_staked(&env)
    }

    pub fn has_voted(env: Env, proposal_id: u64, voter: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Vote(proposal_id, voter))
    }
}

#[cfg(test)]
mod test;
