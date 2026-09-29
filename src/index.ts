#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = (process.env.SELECTARANK_BASE_URL ?? "https://selectarank-data.vercel.app").replace(/\/$/, "");
// Safety cap: refuse to auto-pay more than this many USDC per call.
const MAX_PRICE_USDC = Number(process.env.SELECTARANK_MAX_PRICE_USDC ?? "0.05");

interface Param { name: string; in: "path" | "query"; required: boolean; description: string }
interface Endpoint { operationId: string; path: string; summary: string; price: string; params: Param[] }

// Fallback used only if /openapi.json cannot be fetched at startup.
const FALLBACK: Endpoint[] = [
  { operationId: "preflight", path: "/v1/preflight", summary: "Check that an x402 endpoint's 402 challenge is well-formed before paying it", price: "0.010000",
    params: [{ name: "url", in: "query", required: true, description: "https URL (port 443, public host) of the x402 endpoint to check" }] },
  { operationId: "earthquakes", path: "/v1/earthquakes/{feed}", summary: "USGS earthquake feed", price: "0.002000",
    params: [{ name: "feed", in: "path", required: true, description: "significant_week, significant_day, 4.5_week, 2.5_week, all_day, all_hour" }] },
  { operationId: "weather", path: "/v1/weather/{lat}/{lon}", summary: "NOAA/NWS forecast for a US point", price: "0.003000",
    params: [{ name: "lat", in: "path", required: true, description: "Latitude (US locations only)" }, { name: "lon", in: "path", required: true, description: "Longitude (US locations only)" }] },
  { operationId: "worldbank", path: "/v1/worldbank/{country}/{indicator}", summary: "World Bank indicator", price: "0.002000",
    params: [{ name: "country", in: "path", required: true, description: "Country code, e.g. JP" }, { name: "indicator", in: "path", required: true, description: "Indicator code, e.g. NY.GDP.MKTP.CD" }] },
];

async function loadEndpoints(): Promise<Endpoint[]> {
  try {
    const res = await fetch(`${BASE_URL}/openapi.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const spec: any = await res.json();
    const out: Endpoint[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths ?? {})) {
      const op = item?.get;
      const price = op?.["x-payment-info"]?.price?.amount;
      if (!op || price === undefined) continue; // only paid endpoints
      out.push({
        operationId: op.operationId ?? path.replace(/\W+/g, "_").replace(/^_|_$/g, ""),
        path,
        summary: op.summary ?? path,
        price: String(price),
        params: (op.parameters ?? [])
          .filter((p: any) => p.in === "path" || p.in === "query")
          .map((p: any) => ({ name: p.name, in: p.in, required: !!p.required, description: p.description ?? "" })),
      });
    }
    if (out.length === 0) throw new Error("no paid endpoints in spec");
    return out;
  } catch (e) {
    console.error(`[selectarank-mcp] openapi fetch failed (${(e as Error).message}); using built-in endpoint list`);
    return FALLBACK;
  }
}

function buildUrl(ep: Endpoint, args: Record<string, string | undefined>): string {
  let p = ep.path;
  const q = new URLSearchParams();
  for (const prm of ep.params) {
    const v = args[prm.name];
    if (v === undefined) continue;
    if (prm.in === "path") p = p.replace(`{${prm.name}}`, encodeURIComponent(v));
    else q.set(prm.name, v);
  }
  const qs = q.toString();
  return `${BASE_URL}${p}${qs ? `?${qs}` : ""}`;
}

function decodeRequirements(res: Response, bodyText: string): any {
  const h = res.headers.get("payment-required");
  if (h) {
    try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { /* fall through */ }
  }
  try { const b = JSON.parse(bodyText); if (b && b.accepts) return b; } catch { /* ignore */ }
  return null;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

// Payment client only if a key is present. The key is read from the environment and never logged or written.
let paidFetch: typeof fetch | null = null;
let payerAddress: string | null = null;
const rawKey = process.env.EVM_PRIVATE_KEY?.trim();
if (rawKey) {
  try {
    const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account });
    paidFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
    payerAddress = account.address;
  } catch {
    console.error("[selectarank-mcp] EVM_PRIVATE_KEY is set but invalid; running in 402-info-only mode.");
  }
}

function howToPay(reqs: any): string {
  const a = reqs?.accepts?.[0];
  const usdc = a?.amount ? (Number(a.amount) / 1e6).toString() : "?";
  return [
    "Payment required (HTTP 402, x402 protocol). No payment was made.",
    a ? `Amount: ${a.amount} base units of the asset (${usdc} USDC, 6 decimals)\nAsset: ${a.asset}\nPay to: ${a.payTo}\nNetwork: ${a.network} (Base mainnet)\nScheme: ${a.scheme}` : "(could not parse PaymentRequirements)",
    "",
    "How to pay: either (a) set EVM_PRIVATE_KEY (a wallet holding USDC on Base) in this MCP server's environment and call the tool again, and it will sign and pay automatically; or (b) use any x402 client (e.g. @x402/fetch) to call the same URL with your own wallet.",
    "",
    "Raw PaymentRequirements:",
    JSON.stringify(reqs, null, 2),
  ].join("\n");
}

async function callEndpoint(ep: Endpoint, args: Record<string, string | undefined>) {
  const url = buildUrl(ep, args);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return text(`Network error calling ${url}: ${(e as Error).message}`, true);
  }
  const body = await res.text();
  if (res.status !== 402) return text(body, !res.ok);

  const reqs = decodeRequirements(res, body);
  if (!paidFetch) return text(howToPay(reqs));

  const amt = reqs?.accepts?.[0]?.amount;
  const usdc = amt ? Number(amt) / 1e6 : NaN;
  if (!Number.isFinite(usdc) || usdc > MAX_PRICE_USDC) {
    return text(`Not paying: price ${Number.isFinite(usdc) ? usdc : "unknown"} USDC exceeds SELECTARANK_MAX_PRICE_USDC (${MAX_PRICE_USDC}).\n\n${howToPay(reqs)}`, true);
  }
  try {
    const paid = await paidFetch(url, { signal: AbortSignal.timeout(60000) });
    const pbody = await paid.text();
    if (paid.status === 402) return text(`Payment attempted (payer ${payerAddress}) but the server still returned 402. Check that the wallet holds enough USDC on Base.\n\n${pbody}`, true);
    return text(pbody, !paid.ok);
  } catch (e) {
    return text(`Payment flow failed: ${(e as Error).message}`, true);
  }
}

async function main() {
  const endpoints = await loadEndpoints();
  const server = new McpServer({ name: "selectarank-mcp", version: "0.1.0" });
  for (const ep of endpoints) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const p of ep.params) {
      const s = z.string().describe(p.description);
      shape[p.name] = p.required ? s : s.optional();
    }
    server.registerTool(
      `selectarank_${ep.operationId}`,
      {
        title: ep.summary,
        description: `${ep.summary}. Paid x402 endpoint: ${ep.price} USDC per call on Base (GET ${ep.path}). With EVM_PRIVATE_KEY set the call is paid automatically; otherwise the 402 payment requirements are returned.`,
        inputSchema: shape,
      },
      async (args: Record<string, unknown>) => callEndpoint(ep, args as Record<string, string | undefined>),
    );
  }
  await server.connect(new StdioServerTransport());
  console.error(`[selectarank-mcp] ready: ${endpoints.length} tools, payments ${paidFetch ? "ENABLED for " + payerAddress : "disabled (no EVM_PRIVATE_KEY)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
