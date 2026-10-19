#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};

const TOTAL: i128 = 1_000;
const START: u64 = 1_000;
const CLIFF: u64 = 1_250;
const END: u64 = 2_000;

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(VestingScheduleContract, ());
    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_id = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();

    let client = VestingScheduleContractClient::new(&env, &contract_id);
    client.initialize(&admin, &token_id);

    StellarAssetClient::new(&env, &token_id).mint(&admin, &(TOTAL * 10));

    env.ledger().set_timestamp(START);
    (env, contract_id, admin, token_id)
}

fn create_schedule(
    client: &VestingScheduleContractClient,
    admin: &Address,
    beneficiary: &Address,
    revocable: bool,
) {
    client.create_vesting_schedule(admin, beneficiary, &TOTAL, &START, &END, &CLIFF, &revocable);
}

// ── Vesting maths ─────────────────────────────────────────────────────────────

#[test]
fn nothing_vests_before_cliff() {
    assert_eq!(vested_amount(TOTAL, START, CLIFF, END, CLIFF - 1), 0);
}

#[test]
fn cliff_releases_the_linear_share_earned_so_far() {
    // 250 of 1000 seconds have elapsed at the cliff, so 25% has vested.
    assert_eq!(vested_amount(TOTAL, START, CLIFF, END, CLIFF), 250);
}

#[test]
fn vesting_is_linear_between_cliff_and_end() {
    assert_eq!(vested_amount(TOTAL, START, CLIFF, END, 1_500), 500);
    assert_eq!(vested_amount(TOTAL, START, CLIFF, END, 1_750), 750);
}

#[test]
fn full_amount_vests_at_and_after_end() {
    assert_eq!(vested_amount(TOTAL, START, CLIFF, END, END), TOTAL);
    assert_eq!(vested_amount(TOTAL, START, CLIFF, END, END + 10_000), TOTAL);
}

#[test]
fn rounding_is_floored() {
    // 10 tokens over 3 seconds: 1 second vests 3.33 tokens, 2 seconds vests 6.67.
    assert_eq!(vested_amount(10, 0, 0, 3, 1), 3);
    assert_eq!(vested_amount(10, 0, 0, 3, 2), 6);
}

#[test]
fn large_allocations_do_not_overflow() {
    // elapsed / duration is just under one half, so the result is just under
    // i128::MAX / 2 (about 2^62 below it). Naive `total * elapsed` would overflow.
    let vested = vested_amount(i128::MAX, 0, 0, u64::MAX, u64::MAX / 2);
    assert!(vested <= i128::MAX / 2);
    assert!(vested > i128::MAX / 2 - (1i128 << 63));
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

#[test]
fn create_funds_the_contract_and_stores_the_schedule() {
    let (env, contract_id, admin, token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let beneficiary = Address::generate(&env);

    create_schedule(&client, &admin, &beneficiary, false);

    let token = TokenClient::new(&env, &token_id);
    assert_eq!(token.balance(&contract_id), TOTAL);
    assert_eq!(token.balance(&admin), TOTAL * 10 - TOTAL);

    let schedule = client.get_vesting_schedule(&beneficiary).unwrap();
    assert_eq!(schedule.total_amount, TOTAL);
    assert_eq!(schedule.claimed_amount, 0);
    assert_eq!(schedule.start_time, START);
    assert_eq!(schedule.cliff_time, CLIFF);
    assert_eq!(schedule.end_time, END);
    assert!(!schedule.revocable);
    assert!(!schedule.revoked);
}

#[test]
fn claim_pays_only_the_vested_unclaimed_amount() {
    let (env, contract_id, admin, token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let beneficiary = Address::generate(&env);
    create_schedule(&client, &admin, &beneficiary, false);

    env.ledger().set_timestamp(1_500);
    assert_eq!(client.get_claimable_amount(&beneficiary), 500);
    assert_eq!(client.claim(&beneficiary), 500);
    assert_eq!(TokenClient::new(&env, &token_id).balance(&beneficiary), 500);

    // A second claim at the same time has nothing left to take.
    assert_eq!(
        client.try_claim(&beneficiary),
        Err(Ok(ContractError::NothingToClaim))
    );

    env.ledger().set_timestamp(END);
    assert_eq!(client.claim(&beneficiary), 500);
    assert_eq!(
        TokenClient::new(&env, &token_id).balance(&beneficiary),
        TOTAL
    );
}

#[test]
fn claim_before_cliff_fails() {
    let (env, contract_id, admin, _token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let beneficiary = Address::generate(&env);
    create_schedule(&client, &admin, &beneficiary, false);

    env.ledger().set_timestamp(CLIFF - 1);
    assert_eq!(
        client.try_claim(&beneficiary),
        Err(Ok(ContractError::NothingToClaim))
    );
}

#[test]
fn claim_without_a_schedule_fails() {
    let (env, contract_id, _admin, _token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let stranger = Address::generate(&env);

    assert_eq!(
        client.try_claim(&stranger),
        Err(Ok(ContractError::ScheduleNotFound))
    );
    assert_eq!(client.get_claimable_amount(&stranger), 0);
}

#[test]
fn create_rejects_invalid_schedules() {
    let (env, contract_id, admin, _token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let beneficiary = Address::generate(&env);

    assert_eq!(
        client.try_create_vesting_schedule(&admin, &beneficiary, &0, &START, &END, &CLIFF, &false),
        Err(Ok(ContractError::InvalidAmount))
    );
    assert_eq!(
        client.try_create_vesting_schedule(
            &admin,
            &beneficiary,
            &TOTAL,
            &END,
            &START,
            &CLIFF,
            &false
        ),
        Err(Ok(ContractError::InvalidSchedule))
    );
    // Cliff before start.
    assert_eq!(
        client.try_create_vesting_schedule(
            &admin,
            &beneficiary,
            &TOTAL,
            &START,
            &END,
            &(START - 1),
            &false
        ),
        Err(Ok(ContractError::InvalidSchedule))
    );
    // Cliff after end.
    assert_eq!(
        client.try_create_vesting_schedule(
            &admin,
            &beneficiary,
            &TOTAL,
            &START,
            &END,
            &(END + 1),
            &false
        ),
        Err(Ok(ContractError::InvalidSchedule))
    );

    create_schedule(&client, &admin, &beneficiary, false);
    assert_eq!(
        client.try_create_vesting_schedule(
            &admin,
            &beneficiary,
            &TOTAL,
            &START,
            &END,
            &CLIFF,
            &false
        ),
        Err(Ok(ContractError::ScheduleExists))
    );
}

#[test]
fn revoke_splits_vested_and_unvested_between_beneficiary_and_admin() {
    let (env, contract_id, admin, token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let beneficiary = Address::generate(&env);
    create_schedule(&client, &admin, &beneficiary, true);

    let token = TokenClient::new(&env, &token_id);
    let admin_before = token.balance(&admin);

    env.ledger().set_timestamp(1_500);
    let returned = client.revoke(&admin, &beneficiary);

    assert_eq!(returned, 500);
    assert_eq!(token.balance(&beneficiary), 500);
    assert_eq!(token.balance(&admin), admin_before + 500);
    assert_eq!(token.balance(&contract_id), 0);

    // Nothing vests after revocation, even much later.
    env.ledger().set_timestamp(END + 1_000);
    assert_eq!(client.get_claimable_amount(&beneficiary), 0);
    assert_eq!(
        client.try_claim(&beneficiary),
        Err(Ok(ContractError::NothingToClaim))
    );
    assert_eq!(
        client.try_revoke(&admin, &beneficiary),
        Err(Ok(ContractError::AlreadyRevoked))
    );
}

#[test]
fn revoke_before_start_returns_everything_to_admin() {
    let (env, contract_id, admin, token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let beneficiary = Address::generate(&env);
    create_schedule(&client, &admin, &beneficiary, true);

    env.ledger().set_timestamp(START - 1);
    assert_eq!(client.revoke(&admin, &beneficiary), TOTAL);
    assert_eq!(TokenClient::new(&env, &token_id).balance(&beneficiary), 0);
}

#[test]
fn non_revocable_schedule_cannot_be_revoked() {
    let (env, contract_id, admin, _token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let beneficiary = Address::generate(&env);
    create_schedule(&client, &admin, &beneficiary, false);

    assert_eq!(
        client.try_revoke(&admin, &beneficiary),
        Err(Ok(ContractError::NotRevocable))
    );
}

#[test]
fn pause_blocks_claims_until_unpaused() {
    let (env, contract_id, admin, _token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let beneficiary = Address::generate(&env);
    create_schedule(&client, &admin, &beneficiary, false);
    env.ledger().set_timestamp(1_500);

    client.pause(&admin);
    assert!(client.is_paused());
    assert_eq!(
        client.try_claim(&beneficiary),
        Err(Ok(ContractError::Paused))
    );

    client.unpause(&admin);
    assert!(!client.is_paused());
    assert_eq!(client.claim(&beneficiary), 500);
}

#[test]
fn only_the_admin_can_manage_schedules_and_pause() {
    let (env, contract_id, admin, _token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let stranger = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    create_schedule(&client, &admin, &beneficiary, true);

    assert_eq!(
        client.try_create_vesting_schedule(
            &stranger,
            &Address::generate(&env),
            &TOTAL,
            &START,
            &END,
            &CLIFF,
            &false
        ),
        Err(Ok(ContractError::NotAuthorized))
    );
    assert_eq!(
        client.try_revoke(&stranger, &beneficiary),
        Err(Ok(ContractError::NotAuthorized))
    );
    assert!(client.try_pause(&stranger).is_err());
}

#[test]
fn set_admin_transfers_control() {
    let (env, contract_id, admin, _token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);
    let new_admin = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    client.set_admin(&admin, &new_admin);

    assert_eq!(
        client.try_revoke(&admin, &beneficiary),
        Err(Ok(ContractError::NotAuthorized))
    );
    assert_eq!(
        client.try_revoke(&new_admin, &beneficiary),
        Err(Ok(ContractError::ScheduleNotFound))
    );
}

#[test]
fn initialize_only_runs_once() {
    let (env, contract_id, admin, token_id) = setup();
    let client = VestingScheduleContractClient::new(&env, &contract_id);

    assert_eq!(
        client.try_initialize(&admin, &token_id),
        Err(Ok(ContractError::AlreadyInitialized))
    );
}

// ── Authorization ─────────────────────────────────────────────────────────────

#[test]
fn state_changing_calls_require_authorization() {
    // No mock_all_auths here, so every require_auth() must fail. The state is
    // written directly so that the calls below reach their auth checks.
    let env = Env::default();
    let contract_id = env.register(VestingScheduleContract, ());
    let admin = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let schedule = VestingSchedule {
        total_amount: TOTAL,
        claimed_amount: 0,
        start_time: START,
        cliff_time: CLIFF,
        end_time: END,
        revocable: true,
        revoked: false,
    };
    env.as_contract(&contract_id, || {
        env.storage().instance().set(&DataKey::Admin, &admin);
        put_schedule(&env, &beneficiary, &schedule);
    });
    env.ledger().set_timestamp(1_500);

    let client = VestingScheduleContractClient::new(&env, &contract_id);
    assert!(client.try_claim(&beneficiary).is_err());
    assert!(client.try_revoke(&admin, &beneficiary).is_err());
    assert!(client
        .try_create_vesting_schedule(
            &admin,
            &Address::generate(&env),
            &TOTAL,
            &START,
            &END,
            &CLIFF,
            &false,
        )
        .is_err());
}
