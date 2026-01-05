import type { VercelRequest, VercelResponse } from "@vercel/node";
import { kv } from "@vercel/kv";

type MarketState = {
  symbol: "XAUUSD";
  timeframe: "5";
  state: "RANGE" | "TREND" | "UNKNOWN";
  volatility: "LOW" | "NORMAL" | "HIGH";
  score?: number;
  note?: string;
  ts: number; // ms epoch
};

const KV_KEY = "vistax:market_state";

function setCors(req: VercelRequest, res: VercelResponse) {
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // if you ever need cookies later:
  // res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  return false;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (setCors(req, res)) return;

    // Debug read
    if (req.method === "GET") {
      const value = await kv.get(KV_KEY);
      return res.status(200).json({ ok: true, value });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    // Require secret
    const secret = process.env.TV_WEBHOOK_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, error: "Missing TV_WEBHOOK_SECRET env var" });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    if (body?.secret !== secret) {
      return res.status(401).json({ ok: false, error: "Unauthorized (bad secret)" });
    }

    const payload: MarketState = {
      symbol: "XAUUSD",
      timeframe: "5",
      state: body?.state === "RANGE" || body?.state === "TREND" ? body.state : "UNKNOWN",
      volatility:
        body?.volatility === "LOW" || body?.volatility === "NORMAL" || body?.volatility === "HIGH"
          ? body.volatility
          : "NORMAL",
      score: typeof body?.score === "number" ? body.score : undefined,
      note: typeof body?.note === "string" ? body.note : undefined,
      ts: typeof body?.ts === "number" ? body.ts : Date.now(),
    };

    await kv.set(KV_KEY, payload);

    return res.status(200).json({ ok: true, saved: payload.ts, payload });
  } catch (e: any) {
    return res.status(400).json({ ok: false, error: e?.message || "Bad request" });
  }
}
