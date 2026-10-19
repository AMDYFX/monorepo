#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};

const START: u64 = 1_000;
const TOTAL_STAKED: i128 = 1_000;

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(Governance, ());
    let admin = Address::generate(&env);

    let client = GovernanceClient::new(&env, &contract_id);
    client.init(&admin, &TOTAL_STAKED);

    env.ledger().set_timestamp(START);
    (env, contract_id, admin)
}

fn param(env: &Env) -> Symbol {
    Symbol::new(env, "fee_bps")
}

fn propose(env: &Env, client: &GovernanceClient, proposer: &Address) -> u64 {
    client.create_proposal(proposer, &param(env), &100, &150)
}

// ── Quorum maths ──────────────────────────────────────────────────────────────

#[test]
fn quorum_is_ten_percent_of_snapshotted_stake() {
    assert_eq!(quorum_threshold(1_000), Some(100));
    assert_eq!(quorum_threshold(999), Some(99));
    assert_eq!(quorum_threshold(0), Some(0));
    assert_eq!(quorum_threshold(i128::MAX), None);
}

// ── Initialisation and proposal creation ──────────────────────────────────────

#[test]
fn init_runs_once_and_records_total_stake() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);

    assert_eq!(client.total_staked(), TOTAL_STAKED);
    assert_eq!(client.proposal_count(), 0);
    assert_eq!(
        client.try_init(&admin, &TOTAL_STAKED),
        Err(Ok(ContractError::AlreadyInitialized))
    );
}

#[test]
fn create_proposal_snapshots_stake_and_sets_voting_window() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);

    let id = propose(&env, &client, &proposer);
    assert_eq!(id, 1);
    assert_eq!(client.proposal_count(), 1);

    let proposal = client.get_proposal(&id).unwrap();
    assert_eq!(proposal.proposer, proposer);
    assert_eq!(proposal.current_value, 100);
    assert_eq!(proposal.proposed_value, 150);
    assert_eq!(proposal.votes_for, 0);
    assert_eq!(proposal.votes_against, 0);
    assert_eq!(proposal.status, ProposalStatus::Active);
    assert_eq!(proposal.created_at, START);
    assert_eq!(proposal.voting_ends_at, START + VOTING_PERIOD);
    assert_eq!(proposal.snapshotted_total_staked, TOTAL_STAKED);
}

#[test]
fn proposer_needs_stake_and_a_real_change() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let unstaked = Address::generate(&env);
    let staked = Address::generate(&env);
    client.set_voter_stake(&admin, &staked, &10);

    assert_eq!(
        client.try_create_proposal(&unstaked, &param(&env), &100, &150),
        Err(Ok(ContractError::InsufficientStake))
    );
    assert_eq!(
        client.try_create_proposal(&staked, &param(&env), &100, &100),
        Err(Ok(ContractError::InvalidProposal))
    );

    client.set_min_proposer_stake(&admin, &50);
    assert_eq!(
        client.try_create_proposal(&staked, &param(&env), &100, &150),
        Err(Ok(ContractError::InsufficientStake))
    );
}

// ── Voting ────────────────────────────────────────────────────────────────────

#[test]
fn votes_are_weighted_by_stake() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let for_voter = Address::generate(&env);
    let against_voter = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    client.set_voter_stake(&admin, &for_voter, &70);
    client.set_voter_stake(&admin, &against_voter, &20);
    let id = propose(&env, &client, &proposer);

    client.vote(&for_voter, &id, &true);
    client.vote(&against_voter, &id, &false);

    let proposal = client.get_proposal(&id).unwrap();
    assert_eq!(proposal.votes_for, 70);
    assert_eq!(proposal.votes_against, 20);
    assert!(client.has_voted(&id, &for_voter));
}

#[test]
fn an_address_votes_only_once() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    client.set_voter_stake(&admin, &voter, &50);
    let id = propose(&env, &client, &proposer);

    client.vote(&voter, &id, &true);
    assert_eq!(
        client.try_vote(&voter, &id, &false),
        Err(Ok(ContractError::AlreadyVoted))
    );
    assert_eq!(client.get_proposal(&id).unwrap().votes_for, 50);
}

#[test]
fn voting_closes_when_the_window_ends() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let late = Address::generate(&env);
    let early = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    client.set_voter_stake(&admin, &late, &50);
    client.set_voter_stake(&admin, &early, &50);
    let id = propose(&env, &client, &proposer);
    let ends = START + VOTING_PERIOD;

    env.ledger().set_timestamp(ends - 1);
    client.vote(&early, &id, &true);

    env.ledger().set_timestamp(ends);
    assert_eq!(
        client.try_vote(&late, &id, &true),
        Err(Ok(ContractError::VotingClosed))
    );
}

#[test]
fn zero_stake_cannot_vote() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    let id = propose(&env, &client, &proposer);

    assert_eq!(
        client.try_vote(&Address::generate(&env), &id, &true),
        Err(Ok(ContractError::InsufficientStake))
    );
}

// ── Finalisation ──────────────────────────────────────────────────────────────

#[test]
fn finalize_is_blocked_until_voting_ends() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    let id = propose(&env, &client, &proposer);

    env.ledger().set_timestamp(START + VOTING_PERIOD - 1);
    assert_eq!(
        client.try_finalize_proposal(&id),
        Err(Ok(ContractError::VotingStillOpen))
    );
}

#[test]
fn passes_when_turnout_is_exactly_quorum_and_for_wins() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let for_voter = Address::generate(&env);
    let against_voter = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    // 60 + 40 = 100, which is exactly 10% of the 1000 snapshotted stake.
    client.set_voter_stake(&admin, &for_voter, &60);
    client.set_voter_stake(&admin, &against_voter, &40);
    let id = propose(&env, &client, &proposer);
    client.vote(&for_voter, &id, &true);
    client.vote(&against_voter, &id, &false);

    env.ledger().set_timestamp(START + VOTING_PERIOD);
    assert_eq!(client.finalize_proposal(&id), ProposalStatus::Passed);
    assert_eq!(
        client.get_proposal(&id).unwrap().status,
        ProposalStatus::Passed
    );
}

#[test]
fn rejected_when_turnout_is_one_short_of_quorum() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    client.set_voter_stake(&admin, &voter, &99);
    let id = propose(&env, &client, &proposer);
    client.vote(&voter, &id, &true);

    env.ledger().set_timestamp(START + VOTING_PERIOD);
    assert_eq!(client.finalize_proposal(&id), ProposalStatus::Rejected);
}

#[test]
fn rejected_on_a_tie_even_with_quorum() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let for_voter = Address::generate(&env);
    let against_voter = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    client.set_voter_stake(&admin, &for_voter, &50);
    client.set_voter_stake(&admin, &against_voter, &50);
    let id = propose(&env, &client, &proposer);
    client.vote(&for_voter, &id, &true);
    client.vote(&against_voter, &id, &false);

    env.ledger().set_timestamp(START + VOTING_PERIOD);
    assert_eq!(client.finalize_proposal(&id), ProposalStatus::Rejected);
}

#[test]
fn finalize_only_runs_once() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    let id = propose(&env, &client, &proposer);

    env.ledger().set_timestamp(START + VOTING_PERIOD);
    client.finalize_proposal(&id);
    assert_eq!(
        client.try_finalize_proposal(&id),
        Err(Ok(ContractError::InvalidStatus))
    );
}

// ── Execution ─────────────────────────────────────────────────────────────────

#[test]
fn execute_waits_for_the_timelock() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    client.set_voter_stake(&admin, &voter, &100);
    let id = propose(&env, &client, &proposer);
    client.vote(&voter, &id, &true);

    let ends = START + VOTING_PERIOD;
    env.ledger().set_timestamp(ends);
    client.finalize_proposal(&id);

    env.ledger().set_timestamp(ends + EXECUTION_DELAY - 1);
    assert_eq!(
        client.try_execute_proposal(&id),
        Err(Ok(ContractError::TimelockActive))
    );

    env.ledger().set_timestamp(ends + EXECUTION_DELAY);
    client.execute_proposal(&id);
    assert_eq!(
        client.get_proposal(&id).unwrap().status,
        ProposalStatus::Executed
    );
    assert_eq!(
        client.try_execute_proposal(&id),
        Err(Ok(ContractError::InvalidStatus))
    );
}

#[test]
fn rejected_proposals_cannot_execute() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    let id = propose(&env, &client, &proposer);

    env.ledger().set_timestamp(START + VOTING_PERIOD);
    client.finalize_proposal(&id);
    env.ledger()
        .set_timestamp(START + VOTING_PERIOD + EXECUTION_DELAY);
    assert_eq!(
        client.try_execute_proposal(&id),
        Err(Ok(ContractError::InvalidStatus))
    );
}

// ── Cancellation ──────────────────────────────────────────────────────────────

#[test]
fn proposer_can_cancel_an_active_proposal() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let voter = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    client.set_voter_stake(&admin, &voter, &100);
    let id = propose(&env, &client, &proposer);

    client.cancel_proposal(&proposer, &id);
    assert_eq!(
        client.get_proposal(&id).unwrap().status,
        ProposalStatus::Cancelled
    );
    assert_eq!(
        client.try_vote(&voter, &id, &true),
        Err(Ok(ContractError::InvalidStatus))
    );
}

#[test]
fn admin_can_cancel_an_active_proposal() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    let id = propose(&env, &client, &proposer);

    client.cancel_proposal(&admin, &id);
    assert_eq!(
        client.get_proposal(&id).unwrap().status,
        ProposalStatus::Cancelled
    );
}

#[test]
fn cancel_rules_hold() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    let stranger = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    let id = propose(&env, &client, &proposer);

    assert_eq!(
        client.try_cancel_proposal(&stranger, &id),
        Err(Ok(ContractError::NotAuthorized))
    );

    env.ledger().set_timestamp(START + VOTING_PERIOD);
    client.finalize_proposal(&id);
    assert_eq!(
        client.try_cancel_proposal(&proposer, &id),
        Err(Ok(ContractError::InvalidStatus))
    );
}

// ── Pause and missing proposals ───────────────────────────────────────────────

#[test]
fn pause_blocks_new_proposals_and_votes() {
    let (env, contract_id, admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let proposer = Address::generate(&env);
    client.set_voter_stake(&admin, &proposer, &10);
    let id = propose(&env, &client, &proposer);

    client.pause(&admin);
    assert_eq!(
        client.try_create_proposal(&proposer, &param(&env), &100, &150),
        Err(Ok(ContractError::Paused))
    );
    assert_eq!(
        client.try_vote(&proposer, &id, &true),
        Err(Ok(ContractError::Paused))
    );

    client.unpause(&admin);
    assert_eq!(propose(&env, &client, &proposer), 2);
}

#[test]
fn unknown_proposals_are_reported() {
    let (env, contract_id, _admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let voter = Address::generate(&env);

    assert!(client.get_proposal(&99).is_none());
    assert_eq!(
        client.try_vote(&voter, &99, &true),
        Err(Ok(ContractError::ProposalNotFound))
    );
    assert_eq!(
        client.try_execute_proposal(&99),
        Err(Ok(ContractError::ProposalNotFound))
    );
}

#[test]
fn only_the_admin_can_change_admin_settings() {
    let (env, contract_id, _admin) = setup();
    let client = GovernanceClient::new(&env, &contract_id);
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_set_total_staked(&stranger, &5_000),
        Err(Ok(ContractError::NotAuthorized))
    );
    assert_eq!(
        client.try_set_voter_stake(&stranger, &stranger, &5_000),
        Err(Ok(ContractError::NotAuthorized))
    );
    assert_eq!(
        client.try_set_min_proposer_stake(&stranger, &5),
        Err(Ok(ContractError::NotAuthorized))
    );
    assert!(client.try_pause(&stranger).is_err());
}

// ── Authorization ─────────────────────────────────────────────────────────────

#[test]
fn entry_points_require_authorization() {
    // No mock_all_auths. State is written directly so each call reaches its
    // auth check and fails there.
    let env = Env::default();
    let contract_id = env.register(Governance, ());
    let admin = Address::generate(&env);
    let proposer = Address::generate(&env);
    let proposal = Proposal {
        id: 1,
        proposer: proposer.clone(),
        param_key: Symbol::new(&env, "fee_bps"),
        current_value: 100,
        proposed_value: 150,
        votes_for: 0,
        votes_against: 0,
        status: ProposalStatus::Active,
        created_at: START,
        voting_ends_at: START + VOTING_PERIOD,
        snapshotted_total_staked: TOTAL_STAKED,
    };
    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::TotalStaked, &TOTAL_STAKED);
        env.storage()
            .instance()
            .set(&DataKey::MinProposerStake, &DEFAULT_MIN_PROPOSER_STAKE);
        env.storage().instance().set(&DataKey::ProposalCount, &1u64);
        env.storage()
            .persistent()
            .set(&DataKey::Stake(proposer.clone()), &10i128);
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(1), &proposal);
    });
    env.ledger().set_timestamp(START);

    let client = GovernanceClient::new(&env, &contract_id);
    assert!(client
        .try_create_proposal(&proposer, &Symbol::new(&env, "fee_bps"), &100, &150)
        .is_err());
    assert!(client.try_vote(&proposer, &1, &true).is_err());
    assert!(client.try_cancel_proposal(&proposer, &1).is_err());
    assert!(client.try_set_voter_stake(&admin, &proposer, &5).is_err());
    assert!(client.try_set_total_staked(&admin, &5).is_err());
}
