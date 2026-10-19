/**
 * Helpers for the beneficiary-signed `claim` call on the vesting_schedule
 * contract (#1911). The claim needs the beneficiary's signature, so the backend
 * builds an unsigned transaction, the wallet signs it, and the backend checks
 * the signed XDR before submitting it.
 */

import {
  Address,
  nativeToScVal,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { AppError } from '../errors/AppError.js'
import { ErrorCode } from '../errors/errorCodes.js'

export const VESTING_CLAIM_FUNCTION = 'claim'

/** The `claim(beneficiary)` invocation on the vesting contract. */
export function buildVestingClaimOperation(contractId: string, beneficiary: string): xdr.Operation {
  return Operation.invokeHostFunction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
        functionName: VESTING_CLAIM_FUNCTION,
        args: [nativeToScVal(Address.fromString(beneficiary))],
      }),
    ),
    auth: [],
  })
}

/**
 * Accepts a signed envelope only if it contains exactly one `claim(beneficiary)`
 * call on `contractId`, for the given beneficiary. Anything else is rejected
 * with a 400, so the backend cannot be used to submit arbitrary contract calls.
 */
export function assertVestingClaimXdr(
  signedXdr: string,
  contractId: string,
  networkPassphrase: string,
  beneficiary: string,
): Transaction {
  const reject = (reason: string) =>
    new AppError(ErrorCode.VALIDATION_ERROR, 400, `Invalid vesting claim transaction: ${reason}`)

  let parsed: ReturnType<typeof TransactionBuilder.fromXDR>
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
  } catch {
    throw reject('not a valid transaction envelope')
  }
  if (!(parsed instanceof Transaction)) {
    throw reject('fee-bump transactions are not accepted')
  }

  const operations = parsed.operations
  if (operations.length !== 1) {
    throw reject('expected exactly one operation')
  }
  const op = operations[0] as any
  if (op.type !== 'invokeHostFunction') {
    throw reject('expected an invokeHostFunction operation')
  }

  const func: xdr.HostFunction = op.func
  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    throw reject('expected a contract invocation')
  }
  const invoke = func.invokeContract()

  if (Address.fromScAddress(invoke.contractAddress()).toString() !== contractId) {
    throw reject('call is not on the vesting contract')
  }
  if (invoke.functionName().toString() !== VESTING_CLAIM_FUNCTION) {
    throw reject('call is not claim')
  }
  const args = invoke.args()
  if (args.length !== 1 || args[0].switch() !== xdr.ScValType.scvAddress()) {
    throw reject('claim must take a single address argument')
  }
  if (Address.fromScAddress(args[0].address()).toString() !== beneficiary) {
    throw reject('claim is for a different beneficiary')
  }

  return parsed
}
