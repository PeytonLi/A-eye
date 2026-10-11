import { existsSync } from "node:fs";
import { Client, Wallet } from "xrpl";
import {
  XRPL_TESTNET_WSS,
  XrplError,
  acceptObserverCredential,
  createPotEscrow,
  finishEscrow,
  issueObserverCredential,
  payoutRlusd,
} from "../apps/web/lib/xrpl.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printTx(label: string, result: { hash: string; explorer_url: string }): void {
  console.log(`${label}: ${result.hash} ${result.explorer_url}`);
}

async function waitForValidatedCloseTime(finishAfter: Date): Promise<void> {
  const client = new Client(process.env.XRPL_WSS_URL ?? XRPL_TESTNET_WSS);
  await client.connect();
  try {
    const deadline = Date.now() + 3 * 60_000;
    while (Date.now() < deadline) {
      const response = await client.request({
        command: "ledger",
        ledger_index: "validated",
        transactions: false,
      });
      const ledger = response.result.ledger as { close_time_iso?: string };
      if (ledger.close_time_iso && Date.parse(ledger.close_time_iso) > finishAfter.getTime()) return;
      await delay(1_000);
    }
    throw new Error("validated_ledger_timeout");
  } finally {
    await client.disconnect();
  }
}

async function main(): Promise<void> {
  const envFile = `${process.cwd()}/.env.xrpl.local`;
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const observerSeed = process.env.XRPL_TEST_OBSERVER_SEED;
  if (!observerSeed) throw new XrplError("not_configured");
  const observer = Wallet.fromSeed(observerSeed);

  printTx("RLUSD payout", await payoutRlusd(observer.address, "1.25"));

  const finishAfter = new Date(Date.now() + 15_000);
  const escrow = await createPotEscrow("2", finishAfter);
  printTx("Escrow create", escrow);
  await waitForValidatedCloseTime(finishAfter);

  const finished = await finishEscrow({
    offerSequence: escrow.offer_sequence,
    winner: observer.address,
  });
  printTx("Escrow finish", finished.finish);
  if (finished.payout) printTx("XRP winner payout", finished.payout);

  const credential = await issueObserverCredential(observer.address);
  if (credential.hash && credential.explorer_url) {
    printTx("Observer credential create", credential);
  } else {
    console.log("Observer credential create: already issued");
  }
  printTx("Observer credential accept", await acceptObserverCredential(observer));

  const client = new Client(process.env.XRPL_WSS_URL ?? XRPL_TESTNET_WSS);
  await client.connect();
  let freshAddress = "";
  try {
    const funded = await client.fundWallet();
    freshAddress = funded.wallet.address;
  } finally {
    await client.disconnect();
  }
  try {
    await payoutRlusd(freshAddress, "0.1");
    throw new Error("expected_no_trustline");
  } catch (error) {
    if (!(error instanceof XrplError) || error.code !== "no_trustline") throw error;
    console.log(`No-trustline fallback: ${error.code}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof XrplError ? error.code : error instanceof Error ? error.message : "demo_failed";
  console.error(`XRPL demo failed: ${message.replace(/[^A-Za-z0-9_-]/g, "_")}`);
  process.exitCode = 1;
});
