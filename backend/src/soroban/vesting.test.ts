import { describe, it, expect, vi } from 'vitest'
import {
  Account,
  Address,
  Keypair,
  nativeToScVal,
  Operation,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { RealSorobanAdapter } from './real-adapter.js'
import { SorobanConfig } from './client.js'
import { assertVestingClaimXdr, buildVestingClaimOperation } from './vestingClaim.js'
import { vestedAmount } from './vestingMath.js'

const PASSPHRASE = 'Test SDF Network ; September 2015'
const VESTING_ID = StrKey.encodeContract(Buffer.alloc(32, 9))

function makeConfig(adminSecret: string): SorobanConfig {
  return {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: PASSPHRASE,
    vestingScheduleId: VESTING_ID,
    adminSecret,
  }
}

/** A wallet-signed claim(beneficiary) envelope, as the wallet would return it. */
function signedClaim(signer: Keypair, beneficiary: string, contractId = VESTING_ID): string {
  const tx = new TransactionBuilder(new Account(signer.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(buildVestingClaimOperation(contractId, beneficiary))
    .setTimeout(300)
    .build()
  tx.sign(signer)
  return tx.toXDR()
}

describe('vestedAmount', () => {
  const total = 1_000n
  const start = 1_000n
  const cliff = 1_250n
  const end = 2_000n

  it('is zero before the cliff', () => {
    expect(vestedAmount(total, start, cliff, end, 1_249n)).toBe(0n)
  })

  it('releases the linear share earned so far at the cliff', () => {
    expect(vestedAmount(total, start, cliff, end, 1_250n)).toBe(250n)
  })

  it('is linear between the cliff and the end', () => {
    expect(vestedAmount(total, start, cliff, end, 1_500n)).toBe(500n)
  })

  it('is the full amount at and after the end', () => {
    expect(vestedAmount(total, start, cliff, end, 2_000n)).toBe(1_000n)
    expect(vestedAmount(total, start, cliff, end, 9_000n)).toBe(1_000n)
  })

  it('rounds down', () => {
    expect(vestedAmount(10n, 0n, 0n, 3n, 1n)).toBe(3n)
    expect(vestedAmount(10n, 0n, 0n, 3n, 2n)).toBe(6n)
  })
})

describe('assertVestingClaimXdr', () => {
  const beneficiary = Keypair.random()
  const other = Keypair.random()

  it('accepts a claim for the beneficiary on the vesting contract', () => {
    const tx = assertVestingClaimXdr(
      signedClaim(beneficiary, beneficiary.publicKey()),
      VESTING_ID,
      PASSPHRASE,
      beneficiary.publicKey(),
    )
    expect(tx.operations).toHaveLength(1)
  })

  it('rejects a claim for a different beneficiary', () => {
    expect(() =>
      assertVestingClaimXdr(
        signedClaim(other, other.publicKey()),
        VESTING_ID,
        PASSPHRASE,
        beneficiary.publicKey(),
      ),
    ).toThrow('claim is for a different beneficiary')
  })

  it('rejects a call on another contract', () => {
    const otherContract = StrKey.encodeContract(Buffer.alloc(32, 3))
    expect(() =>
      assertVestingClaimXdr(
        signedClaim(beneficiary, beneficiary.publicKey(), otherContract),
        VESTING_ID,
        PASSPHRASE,
        beneficiary.publicKey(),
      ),
    ).toThrow('call is not on the vesting contract')
  })

  it('rejects a function other than claim', () => {
    const revoke = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(VESTING_ID).toScAddress(),
          functionName: 'revoke',
          args: [nativeToScVal(Address.fromString(beneficiary.publicKey()))],
        }),
      ),
      auth: [],
    })
    const tx = new TransactionBuilder(new Account(beneficiary.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(revoke)
      .setTimeout(300)
      .build()
    tx.sign(beneficiary)

    expect(() =>
      assertVestingClaimXdr(tx.toXDR(), VESTING_ID, PASSPHRASE, beneficiary.publicKey()),
    ).toThrow('call is not claim')
  })

  it('rejects input that is not a transaction envelope', () => {
    expect(() =>
      assertVestingClaimXdr('not-xdr', VESTING_ID, PASSPHRASE, beneficiary.publicKey()),
    ).toThrow('not a valid transaction envelope')
  })
})

describe('RealSorobanAdapter vesting bindings', () => {
  const admin = Keypair.random()
  const beneficiary = Keypair.random().publicKey()

  it('creates a schedule through the admin signer with the contract argument order', async () => {
    const adapter = new RealSorobanAdapter(makeConfig(admin.secret()))
    const execute = vi
      .spyOn((adapter as any).adminSigningService, 'executeAdminOperation')
      .mockResolvedValue('hash-create')

    const txHash = await adapter.createVestingSchedule({
      beneficiary,
      totalAmount: 1_000n,
      startTime: 100,
      endTime: 200,
      cliffTime: 150,
      revocable: true,
    })

    expect(txHash).toBe('hash-create')
    const call = execute.mock.calls[0][0]
    expect(call.contractId).toBe(VESTING_ID)
    expect(call.operation).toBe('create_vesting_schedule')
    const args = call.args.map((arg: xdr.ScVal) => scValToNative(arg))
    expect(args).toEqual([admin.publicKey(), beneficiary, 1_000n, 100n, 200n, 150n, true])
  })

  it('revokes through the admin signer', async () => {
    const adapter = new RealSorobanAdapter(makeConfig(admin.secret()))
    const execute = vi
      .spyOn((adapter as any).adminSigningService, 'executeAdminOperation')
      .mockResolvedValue('hash-revoke')

    await expect(adapter.revokeVesting(beneficiary)).resolves.toBe('hash-revoke')
    const call = execute.mock.calls[0][0]
    expect(call.operation).toBe('revoke')
    expect(call.args.map((arg: xdr.ScVal) => scValToNative(arg))).toEqual([
      admin.publicKey(),
      beneficiary,
    ])
  })

  it('decodes a schedule read from the contract', async () => {
    const adapter = new RealSorobanAdapter(makeConfig(admin.secret()))
    vi.spyOn(adapter as any, 'invokeReadOnly').mockResolvedValue(
      nativeToScVal({
        total_amount: 1_000n,
        claimed_amount: 250n,
        start_time: 100n,
        cliff_time: 150n,
        end_time: 200n,
        revocable: true,
        revoked: false,
      }),
    )

    await expect(adapter.getVestingSchedule(beneficiary)).resolves.toEqual({
      beneficiary,
      totalAmount: 1_000n,
      claimedAmount: 250n,
      startTime: 100,
      cliffTime: 150,
      endTime: 200,
      revocable: true,
      revoked: false,
    })
  })

  it('returns null when the contract has no schedule', async () => {
    const adapter = new RealSorobanAdapter(makeConfig(admin.secret()))
    vi.spyOn(adapter as any, 'invokeReadOnly').mockResolvedValue(xdr.ScVal.scvVoid())

    await expect(adapter.getVestingSchedule(beneficiary)).resolves.toBeNull()
  })

  it('reads the claimable amount as an i128', async () => {
    const adapter = new RealSorobanAdapter(makeConfig(admin.secret()))
    const read = vi
      .spyOn(adapter as any, 'invokeReadOnly')
      .mockResolvedValue(nativeToScVal(250n, { type: 'i128' }))

    await expect(adapter.getClaimableVested(beneficiary)).resolves.toBe(250n)
    expect(read.mock.calls[0][1]).toBe('get_claimable_amount')
  })

  it('prepares an unsigned claim that the beneficiary can sign and submit', async () => {
    const wallet = Keypair.random()
    const adapter = new RealSorobanAdapter(makeConfig(admin.secret()))
    const server = (adapter as any).server
    vi.spyOn(server, 'getAccount').mockResolvedValue(new Account(wallet.publicKey(), '1'))
    // Simulation is stubbed to return the transaction unchanged.
    vi.spyOn(server, 'prepareTransaction').mockImplementation(async (tx: any) => tx)

    const unsignedXdr = await adapter.prepareVestingClaim(wallet.publicKey())
    const tx = assertVestingClaimXdr(unsignedXdr, VESTING_ID, PASSPHRASE, wallet.publicKey())
    expect(tx.signatures).toHaveLength(0)
  })

  it('submits only claims that pass validation', async () => {
    const wallet = Keypair.random()
    const adapter = new RealSorobanAdapter(makeConfig(admin.secret()))
    const send = vi
      .spyOn((adapter as any).server, 'sendTransaction')
      .mockResolvedValue({ status: 'PENDING', hash: 'hash-claim' })

    await expect(
      adapter.submitVestingClaim(signedClaim(wallet, wallet.publicKey()), wallet.publicKey()),
    ).resolves.toBe('hash-claim')
    expect(send).toHaveBeenCalledTimes(1)

    const someoneElse = Keypair.random().publicKey()
    await expect(
      adapter.submitVestingClaim(signedClaim(wallet, wallet.publicKey()), someoneElse),
    ).rejects.toThrow('different beneficiary')
    expect(send).toHaveBeenCalledTimes(1)
  })
})
