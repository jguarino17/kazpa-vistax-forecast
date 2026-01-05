import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * VistaX Forecast (Vercel Serverless)
 * - Flags: Fridays, High-impact US events, FOMC day, day after FOMC
 * - Returns 7-day forecast + routine window in GMT
 *
 * Data provider: Trading Economics (recommended)
 * Docs: importance=3 is "High" (maps to "red folder") and country filters exist.
 */

type CalendarEvent = {
  title: string;
  currency?: string;
  impact?: string;
  datetimeUtc: string;
  source?: string;
};

type DayStatus = "GOOD" | "CAUTION" | "NO_RUN";

type DayForecast = {
  date: string; // YYYY-MM-DD (UTC)
  weekday: string;
  status: DayStatus;
  reasons: string[];
  events: CalendarEvent[];
  flags: {
    isFriday: boolean;
    hasHighUsd: boolean;
    hasFomc: boolean;
    isDayAfterFomc: boolean;
  };
};

const ROUTINE = { startGmt: "09:35", endGmt: "10:50" };

function toYmdUTC(d: Date) { return d.toISOString().slice(0, 10); }
function weekdayUTC(d: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
}
function addDaysUTC(d: Date, days: number) {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}

function isFomcTitle(title: string) {
  const t = title.toLowerCase();
  return t.includes("fomc") || t.includes("fed funds") || t.includes("federal open market");
}

async function fetchTradingEconomicsHighImpactUS(startYmd: string, endYmd: string): Promise<CalendarEvent[]> {
  const apiKey = process.env.TE_API_KEY;
  if (!apiKey) throw new Error("Missing TE_API_KEY env var");

  // Pull U.S. calendar for date range, filter importance=3 (High)
  const url =
    `https://api.tradingeconomics.com/calendar/country/united%20states/${startYmd}/${endYmd}` +
    `?c=${encodeURIComponent(apiKey)}&importance=3`;

  const r = await fetch(url);
  if (!r.ok) throw new Error(`TradingEconomics error: ${r.status}`);
  const data = await r.json();

  // Map to normalized event format
  return (Array.isArray(data) ? data : []).map((it: any) => {
    const rawDate = it.Date || it.date || it.DateTime || it.datetime;
    const dt = new Date(rawDate || Date.now());

    return {
      title: String(it.Event || it.event || "Economic Event"),
      currency: "USD",
      impact: "High",
      datetimeUtc: dt.toISOString(),
      source: "TradingEconomics",
    } as CalendarEvent;
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (lets Webflow/kazpa.io call this endpoint)
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const end = addDaysUTC(start, 7);

    const startYmd = toYmdUTC(start);
    const endYmd = toYmdUTC(end);

    const events = await fetchTradingEconomicsHighImpactUS(startYmd, endYmd);

    // Bucket by UTC day
    const byDay = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const key = toYmdUTC(new Date(ev.datetimeUtc));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(ev);
    }

    // FOMC days
    const fomcDays = new Set<string>();
    for (const [day, list] of byDay.entries()) {
      if (list.some(e => isFomcTitle(e.title))) fomcDays.add(day);
    }

    const days: DayForecast[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDaysUTC(start, i);
      const ymd = toYmdUTC(d);
      const weekday = weekdayUTC(d);
      const dayEvents = (byDay.get(ymd) || []).sort((a, b) => a.datetimeUtc.localeCompare(b.datetimeUtc));

      const isFriday = weekday.toLowerCase() === "friday";
      const hasHighUsd = dayEvents.length > 0;
      const hasFomc = fomcDays.has(ymd);
      const prev = toYmdUTC(addDaysUTC(d, -1));
      const isDayAfterFomc = fomcDays.has(prev);

      const reasons: string[] = [];
      if (isFriday) reasons.push("NO trade Fridays");
      if (hasFomc) reasons.push("FOMC day");
      if (isDayAfterFomc) reasons.push("Day after FOMC");
      if (hasHighUsd) reasons.push("High-impact USD news day (routine filter)");

      let status: DayStatus = "GOOD";
      if (isFriday || hasHighUsd || hasFomc || isDayAfterFomc) status = "NO_RUN";

      days.push({
        date: ymd,
        weekday,
        status,
        reasons: Array.from(new Set(reasons)),
        events: dayEvents,
        flags: { isFriday, hasHighUsd, hasFomc, isDayAfterFomc },
      });
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    return res.status(200).send({
      ok: true,
      routine: ROUTINE,
      generatedAtUtc: new Date().toISOString(),
      days,
      disclaimer: [
        "This forecast is based on one commonly used VistaX routine many kazpa members have seen success with.",
        "You are free to use VistaX however you want.",
        "Not financial advice. No guarantees. You are responsible for all trading decisions.",
      ],
    });
  } catch (err: any) {
    return res.status(500).send({ ok: false, error: err?.message || "Unknown error" });
  }
}
