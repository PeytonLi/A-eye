import {
  Client,
  Wallet,
  convertStringToHex,
  isValidClassicAddress,
  isoTimeToRippleTime,
  xrpToDrops,
} from "xrpl";
import type {
  CredentialAccept,
  CredentialCreate,
  EscrowCancel,
  EscrowCreate,
  EscrowFinish,
  IssuedCurrencyAmount,
  Payment,
  TrustSet,
  TxResponse,
} from "xrpl";

export const RLUSD_TESTNET = {
  issuer: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  currency: "524C555344000000000000000000000000000000",
} as const;
export const XRPL_TESTNET_WSS = "wss://s.altnet.rippletest.net:51233";
export const CREDENTIAL_TYPE_HEX = convertStringToHex("A-eye Verified Observer");
const RIPPLE_EPOCH_UNIX_SECONDS = 946_684_800;

export class XrplError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "XrplError";
    this.code = code;
  }
}

export function explorerTx(hash: string): string {
  return `https://testnet.xrpl.org/transactions/${hash}`;
}

export function isXrplConfigured(): boolean {
  return Boolean(process.env.XRPL_TREASURY_SEED && process.env.XRPL_ISSUER_SEED);
}

function assertAddress(address: string): void {
  if (!isValidClassicAddress(address)) throw new XrplError("invalid_address");
}

function amountString(amount: string | number, maxDecimals = 6): string {
  const value = String(amount);
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match || (match[1]?.length ?? 0) > maxDecimals) throw new XrplError("invalid_amount");
  const significantDigits = value.replace(".", "").replace(/^0+/, "");
  if (!significantDigits || significantDigits.length > 15) throw new XrplError("invalid_amount");
  if (Number(value) <= 0) throw new XrplError("invalid_amount");
  return value;
}

function rippleTime(date: Date): number {
  if (!Number.isFinite(date.getTime())) throw new XrplError("invalid_time");
  return isoTimeToRippleTime(date);
}

export function buildRlusdPayment(from: string, to: string, amount: string | number): Payment {
  assertAddress(from);
  assertAddress(to);
  const value = amountString(amount);
  const issuedAmount: IssuedCurrencyAmount = {
    currency: RLUSD_TESTNET.currency,
    issuer: RLUSD_TESTNET.issuer,
    value,
  };
  return { TransactionType: "Payment", Account: from, Destination: to, Amount: issuedAmount };
}

export function buildTrustSet(account: string, limit: string | number): TrustSet {
  assertAddress(account);
  return {
    TransactionType: "TrustSet",
    Account: account,
    LimitAmount: {
      currency: RLUSD_TESTNET.currency,
      issuer: RLUSD_TESTNET.issuer,
      value: amountString(limit),
    },
  };
}

export function buildEscrowCreate(
  account: string,
  amountXrp: string | number,
  finishAfter: Date,
  opts: { destination?: string; cancelAfter?: Date } = {},
): EscrowCreate {
  assertAddress(account);
  if (opts.destination) assertAddress(opts.destination);
  const cancelAfter = opts.cancelAfter ?? new Date(finishAfter.getTime() + 7 * 24 * 60 * 60 * 1000);
  const finishRippleTime = rippleTime(finishAfter);
  const cancelRippleTime = rippleTime(cancelAfter);
  if (cancelRippleTime <= finishRippleTime) throw new XrplError("invalid_time");
  // RLUSD's issuer does not enable trust-line locking, so the pot escrow uses XRP.
  return {
    TransactionType: "EscrowCreate",
    Account: account,
    Destination: opts.destination ?? account,
    Amount: xrpToDrops(amountString(amountXrp)),
    FinishAfter: finishRippleTime,
    CancelAfter: cancelRippleTime,
  };
}

export function buildEscrowFinish(account: string, owner: string, offerSequence: number): EscrowFinish {
  assertAddress(account);
  assertAddress(owner);
  if (!Number.isSafeInteger(offerSequence) || offerSequence < 0) throw new XrplError("invalid_sequence");
  return { TransactionType: "EscrowFinish", Account: account, Owner: owner, OfferSequence: offerSequence };
}

export function buildEscrowCancel(account: string, owner: string, offerSequence: number): EscrowCancel {
  assertAddress(account);
  assertAddress(owner);
  if (!Number.isSafeInteger(offerSequence) || offerSequence < 0) throw new XrplError("invalid_sequence");
  return { TransactionType: "EscrowCancel", Account: account, Owner: owner, OfferSequence: offerSequence };
}

export function buildCredentialCreate(
  issuer: string,
  subject: string,
  opts: { uri?: string; expiration?: Date } = {},
): CredentialCreate {
  assertAddress(issuer);
  assertAddress(subject);
  const transaction: CredentialCreate = {
    TransactionType: "CredentialCreate",
    Account: issuer,
    Subject: subject,
    CredentialType: CREDENTIAL_TYPE_HEX,
  };
  if (opts.uri !== undefined) transaction.URI = convertStringToHex(opts.uri);
  if (opts.expiration !== undefined) {
    if (!Number.isFinite(opts.expiration.getTime())) throw new XrplError("invalid_time");
    transaction.Expiration = Math.floor(opts.expiration.getTime() / 1000);
  }
  return transaction;
}

export function buildCredentialAccept(subject: string, issuer: string): CredentialAccept {
  assertAddress(subject);
  assertAddress(issuer);
  return {
    TransactionType: "CredentialAccept",
    Account: subject,
    Issuer: issuer,
    CredentialType: CREDENTIAL_TYPE_HEX,
  };
}

function walletFromSeed(seed: string | undefined, role: string): Wallet {
  if (!seed) throw new XrplError("not_configured");
  try {
    return Wallet.fromSeed(seed);
  } catch {
    throw new XrplError(`invalid_${role}_seed`);
  }
}

function treasuryWallet(): Wallet {
  return walletFromSeed(process.env.XRPL_TREASURY_SEED, "treasury");
}

function issuerWallet(): Wallet {
  return walletFromSeed(process.env.XRPL_ISSUER_SEED, "issuer");
}

export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(process.env.XRPL_WSS_URL ?? XRPL_TESTNET_WSS);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    if (client.isConnected()) await client.disconnect();
  }
}

type SubmitResult = {
  hash: string;
  explorer_url: string;
  ledger_index: number | null;
};

export type CredentialOutcome = {
  hash: string | null;
  explorer_url: string | null;
  ledger_index: number | null;
  already_issued: boolean;
};

function txResultCode(result: TxResponse): string | null {
  const meta = result.result.meta;
  if (typeof meta === "string") {
    try {
      const parsed = JSON.parse(meta) as { TransactionResult?: unknown };
      return typeof parsed.TransactionResult === "string" ? parsed.TransactionResult : null;
    } catch {
      return null;
    }
  }
  const value = meta as { TransactionResult?: unknown } | undefined;
  return typeof value?.TransactionResult === "string" ? value.TransactionResult : null;
}

async function submit(
  client: Client,
  wallet: Wallet,
  transaction: Payment | TrustSet | EscrowCreate | EscrowFinish | EscrowCancel | CredentialCreate | CredentialAccept,
  allowDuplicateCredential = false,
): Promise<{ response: TxResponse; resultCode: string }> {
  let response: TxResponse;
  try {
    response = await client.submitAndWait(transaction, { autofill: true, wallet });
  } catch (error) {
    const errorCode =
      typeof error === "object" && error !== null && "data" in error &&
      typeof error.data === "object" && error.data !== null && "error" in error.data
        ? String(error.data.error)
        : "submit_failed";
    throw new XrplError(errorCode);
  }
  const resultCode = txResultCode(response);
  if (resultCode !== "tesSUCCESS" && !(allowDuplicateCredential && resultCode === "tecDUPLICATE")) {
    throw new XrplError(resultCode ?? "submit_failed");
  }
  return { response, resultCode };
}

function submitResult(response: TxResponse): SubmitResult {
  return {
    hash: response.result.hash,
    explorer_url: explorerTx(response.result.hash),
    ledger_index: response.result.ledger_index ?? null,
  };
}

export function credentialCreateOutcome(
  resultCode: string,
  result: SubmitResult,
): CredentialOutcome {
  if (resultCode === "tecDUPLICATE") {
    return { hash: null, explorer_url: null, ledger_index: null, already_issued: true };
  }
  if (resultCode !== "tesSUCCESS") throw new XrplError(resultCode);
  return { ...result, already_issued: false };
}

export async function payoutRlusd(destination: string, amount: string | number): Promise<SubmitResult> {
  assertAddress(destination);
  amountString(amount);
  const wallet = treasuryWallet();
  return withClient(async (client) => {
    const response = await client.request({
      command: "account_lines",
      account: destination,
      peer: RLUSD_TESTNET.issuer,
    });
    if (!hasRlusdTrustLine(response.result.lines)) throw new XrplError("no_trustline");
    const submitted = await submit(client, wallet, buildRlusdPayment(wallet.address, destination, amount));
    return submitResult(submitted.response);
  });
}

export function hasRlusdTrustLine(
  lines: Array<{ account?: string; currency?: string }> | null | undefined,
): boolean {
  return Boolean(
    lines?.some(
      (line) =>
        line.currency?.toUpperCase() === RLUSD_TESTNET.currency &&
        line.account === RLUSD_TESTNET.issuer,
    ),
  );
}

export type PotEscrowResult = SubmitResult & {
  owner: string;
  offer_sequence: number;
  amount_drops: string;
};

export async function createPotEscrow(
  amountXrp: string | number,
  finishAfter: Date,
  opts: { destination?: string; cancelAfter?: Date } = {},
): Promise<PotEscrowResult> {
  const wallet = treasuryWallet();
  const transaction = buildEscrowCreate(wallet.address, amountXrp, finishAfter, {
    ...opts,
    destination: opts.destination ?? wallet.address,
  });
  return withClient(async (client) => {
    const { response } = await submit(client, wallet, transaction);
    const sequence = response.result.tx_json.Sequence;
    if (typeof sequence !== "number") throw new XrplError("missing_sequence");
    return {
      ...submitResult(response),
      owner: wallet.address,
      offer_sequence: sequence,
      amount_drops: transaction.Amount as string,
    };
  });
}

export type FinishEscrowResult = {
  finish: SubmitResult;
  payout: SubmitResult | null;
  amount_drops: string;
};

export async function finishEscrow(input: {
  owner?: string;
  offerSequence: number;
  winner?: string;
}): Promise<FinishEscrowResult> {
  const wallet = treasuryWallet();
  const owner = input.owner ?? wallet.address;
  assertAddress(owner);
  if (input.winner) assertAddress(input.winner);
  return withClient(async (client) => {
    const ledgerResult = await client.request({
      command: "ledger_entry",
      escrow: { owner, seq: input.offerSequence },
      ledger_index: "validated",
    });
    const escrow = ledgerResult.result.node as { Amount?: unknown; Destination?: unknown } | undefined;
    if (!escrow || typeof escrow.Amount !== "string" || typeof escrow.Destination !== "string") {
      throw new XrplError("escrow_not_found");
    }
    const finish = await submit(client, wallet, buildEscrowFinish(wallet.address, owner, input.offerSequence));
    let payout: SubmitResult | null = null;
    if (input.winner && escrow.Destination === wallet.address) {
      const payoutResponse = await submit(client, wallet, {
        TransactionType: "Payment",
        Account: wallet.address,
        Destination: input.winner,
        Amount: escrow.Amount,
      });
      payout = submitResult(payoutResponse.response);
    }
    return { finish: submitResult(finish.response), payout, amount_drops: escrow.Amount };
  });
}

export async function cancelEscrow(input: { owner?: string; offerSequence: number }): Promise<SubmitResult> {
  const wallet = treasuryWallet();
  const owner = input.owner ?? wallet.address;
  assertAddress(owner);
  return withClient(async (client) => {
    const result = await submit(client, wallet, buildEscrowCancel(wallet.address, owner, input.offerSequence));
    return submitResult(result.response);
  });
}

export async function issueObserverCredential(
  subject: string,
  opts: { uri?: string; expiration?: Date } = {},
): Promise<CredentialOutcome> {
  const wallet = issuerWallet();
  const transaction = buildCredentialCreate(wallet.address, subject, opts);
  return withClient(async (client) => {
    const { response, resultCode } = await submit(client, wallet, transaction, true);
    return credentialCreateOutcome(resultCode, submitResult(response));
  });
}

export async function acceptObserverCredential(subjectWallet: Wallet): Promise<SubmitResult> {
  const issuer = issuerWallet();
  const transaction = buildCredentialAccept(subjectWallet.address, issuer.address);
  return withClient(async (client) => {
    const result = await submit(client, subjectWallet, transaction);
    return submitResult(result.response);
  });
}

export function unixTimestampToRippleTime(timestampMs: number): number {
  if (!Number.isFinite(timestampMs)) throw new XrplError("invalid_time");
  return Math.floor(timestampMs / 1000) - RIPPLE_EPOCH_UNIX_SECONDS;
}
