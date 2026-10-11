import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_TYPE_HEX,
  RLUSD_TESTNET,
  XrplError,
  buildCredentialAccept,
  buildCredentialCreate,
  buildEscrowCancel,
  buildEscrowCreate,
  buildEscrowFinish,
  buildRlusdPayment,
  buildTrustSet,
  credentialCreateOutcome,
  explorerTx,
  hasRlusdTrustLine,
  unixTimestampToRippleTime,
} from "./xrpl.js";

const TREASURY = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const SUBJECT = "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH";

describe("XRPL builders", () => {
  it("builds an RLUSD payment and trust set with the testnet issue", () => {
    expect(buildRlusdPayment(TREASURY, SUBJECT, "1.25")).toMatchObject({
      TransactionType: "Payment",
      Account: TREASURY,
      Destination: SUBJECT,
      Amount: { currency: RLUSD_TESTNET.currency, issuer: RLUSD_TESTNET.issuer, value: "1.25" },
    });
    expect(buildTrustSet(SUBJECT, "1000000")).toMatchObject({
      TransactionType: "TrustSet",
      LimitAmount: { currency: RLUSD_TESTNET.currency, issuer: RLUSD_TESTNET.issuer, value: "1000000" },
    });
  });

  it("builds XRP escrows with Ripple-time fields and the requested destination", () => {
    const finishAfter = new Date("2026-10-11T20:00:00.000Z");
    const cancelAfter = new Date("2026-10-18T20:00:00.000Z");
    expect(buildEscrowCreate(TREASURY, "2", finishAfter, { destination: SUBJECT, cancelAfter })).toMatchObject({
      TransactionType: "EscrowCreate",
      Account: TREASURY,
      Destination: SUBJECT,
      Amount: "2000000",
      FinishAfter: 845_064_000,
    });
    expect(buildEscrowFinish(TREASURY, TREASURY, 12)).toMatchObject({
      TransactionType: "EscrowFinish",
      Owner: TREASURY,
      OfferSequence: 12,
    });
    expect(buildEscrowCancel(TREASURY, TREASURY, 12)).toMatchObject({
      TransactionType: "EscrowCancel",
      Owner: TREASURY,
      OfferSequence: 12,
    });
  });

  it("builds issuer credentials and observer acceptance", () => {
    expect(
      buildCredentialCreate(TREASURY, SUBJECT, {
        uri: "https://a-eye.example/observers/1",
        expiration: new Date("2026-10-11T20:00:00.000Z"),
      }),
    ).toMatchObject({
      TransactionType: "CredentialCreate",
      Account: TREASURY,
      Subject: SUBJECT,
      CredentialType: CREDENTIAL_TYPE_HEX,
      URI: "68747470733A2F2F612D6579652E6578616D706C652F6F62736572766572732F31",
      Expiration: 1_791_748_800,
    });
    expect(buildCredentialAccept(SUBJECT, TREASURY)).toMatchObject({
      TransactionType: "CredentialAccept",
      Account: SUBJECT,
      Issuer: TREASURY,
      CredentialType: CREDENTIAL_TYPE_HEX,
    });
  });

  it("rejects invalid addresses and amounts", () => {
    expect(() => buildRlusdPayment("not-an-address", SUBJECT, "1")).toThrow(XrplError);
    expect(() => buildTrustSet(SUBJECT, "0")).toThrow(/invalid_amount/);
    expect(() => buildRlusdPayment(TREASURY, SUBJECT, "1.0000001")).toThrow(/invalid_amount/);
    expect(() => buildRlusdPayment(TREASURY, SUBJECT, "1234567890123456")).toThrow(/invalid_amount/);
    expect(() => buildEscrowFinish(TREASURY, TREASURY, -1)).toThrow(/invalid_sequence/);
  });
});

describe("XRPL helpers", () => {
  it("converts Unix milliseconds to Ripple epoch seconds", () => {
    expect(unixTimestampToRippleTime(Date.parse("2000-01-01T00:00:00.000Z"))).toBe(0);
    expect(unixTimestampToRippleTime(Date.parse("2026-10-11T20:00:00.000Z"))).toBe(845_064_000);
  });

  it("detects an RLUSD trust line and rejects unrelated lines", () => {
    expect(
      hasRlusdTrustLine([{ account: RLUSD_TESTNET.issuer, currency: RLUSD_TESTNET.currency }]),
    ).toBe(true);
    expect(hasRlusdTrustLine([{ account: SUBJECT, currency: RLUSD_TESTNET.currency }])).toBe(false);
    expect(hasRlusdTrustLine([{ account: RLUSD_TESTNET.issuer, currency: "USD" }])).toBe(false);
    expect(hasRlusdTrustLine([])).toBe(false);
  });

  it("maps duplicate observer credentials to an already-issued result", () => {
    expect(
      credentialCreateOutcome("tecDUPLICATE", {
        hash: "ABC",
        explorer_url: explorerTx("ABC"),
        ledger_index: 100,
      }),
    ).toEqual({ hash: null, explorer_url: null, ledger_index: null, already_issued: true });
    expect(() =>
      credentialCreateOutcome("tecNO_PERMISSION", {
        hash: "ABC",
        explorer_url: explorerTx("ABC"),
        ledger_index: 100,
      }),
    ).toThrow(/tecNO_PERMISSION/);
  });
});
