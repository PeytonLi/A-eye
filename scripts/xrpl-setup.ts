import { appendFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, xrpToDrops } from "xrpl";
import {
  RLUSD_TESTNET,
  XRPL_TESTNET_WSS,
  buildTrustSet,
} from "../apps/web/lib/xrpl.ts";

const ENV_FILE = resolve(process.cwd(), ".env.xrpl.local");
const ROLE_ENV_KEYS = {
  treasury: "XRPL_TREASURY_SEED",
  issuer: "XRPL_ISSUER_SEED",
  observer: "XRPL_TEST_OBSERVER_SEED",
} as const;

type Role = keyof typeof ROLE_ENV_KEYS;

function parseArgs(): { role: Role; rlusd: string } {
  const roleIndex = process.argv.indexOf("--role");
  const role = roleIndex >= 0 ? process.argv[roleIndex + 1] : "treasury";
  if (role !== "treasury" && role !== "issuer" && role !== "observer") {
    throw new Error("invalid_role");
  }
  const amountIndex = process.argv.indexOf("--rlusd");
  const rlusd = amountIndex >= 0 ? process.argv[amountIndex + 1] : "5";
  if (!rlusd || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(rlusd) || Number(rlusd) <= 0) {
    throw new Error("invalid_rlusd");
  }
  return { role, rlusd };
}

function ensureRoleKeyCanBeAdded(key: string): void {
  if (!existsSync(ENV_FILE)) return;
  const content = readFileSync(ENV_FILE, "utf8");
  if (content.split(/\r?\n/).some((line) => line.startsWith(`${key}=`))) {
    throw new Error("role_already_configured");
  }
}

function saveSeed(key: string, seed: string): void {
  appendFileSync(ENV_FILE, `${key}=${seed}\n`, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

function checkedTxResult(response: { result: { meta?: unknown } }): void {
  const meta = response.result.meta as { TransactionResult?: string } | undefined;
  if (meta?.TransactionResult !== "tesSUCCESS") throw new Error("transaction_failed");
}

async function main(): Promise<void> {
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const { role, rlusd } = parseArgs();
  const roleKey = ROLE_ENV_KEYS[role];
  ensureRoleKeyCanBeAdded(roleKey);

  const client = new Client(process.env.XRPL_WSS_URL ?? XRPL_TESTNET_WSS);
  await client.connect();
  try {
    const { wallet } = await client.fundWallet();
    const seed = wallet.seed;
    if (!seed) throw new Error("wallet_seed_missing");
    saveSeed(roleKey, seed);

    if (role === "treasury" || role === "observer") {
      const trustSet = await client.submitAndWait(buildTrustSet(wallet.address, "1000000"), {
        autofill: true,
        wallet,
      });
      checkedTxResult(trustSet);
    }

    console.log(`Address: ${wallet.address}`);
    console.log(`Explorer: https://testnet.xrpl.org/accounts/${wallet.address}`);

    if (role === "treasury") {
      const offer = await client.submitAndWait(
        {
          TransactionType: "OfferCreate",
          Account: wallet.address,
          TakerPays: { currency: RLUSD_TESTNET.currency, issuer: RLUSD_TESTNET.issuer, value: rlusd },
          TakerGets: xrpToDrops(String(Number(rlusd) * 5)),
          Flags: 131072,
        },
        { autofill: true, wallet },
      );
      checkedTxResult(offer);
      const lines = await client.request({
        command: "account_lines",
        account: wallet.address,
        peer: RLUSD_TESTNET.issuer,
      });
      const rlusdLine = lines.result.lines.find((line) => line.currency === RLUSD_TESTNET.currency);
      console.log(`RLUSD balance: ${rlusdLine?.balance ?? "0"}`);
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "setup_failed";
  console.error(`XRPL setup failed: ${message.replace(/[^A-Za-z0-9_-]/g, "_")}`);
  process.exitCode = 1;
});
