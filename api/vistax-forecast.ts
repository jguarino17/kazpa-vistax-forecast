import type { VercelRequest, VercelResponse } from "@vercel/node";

type CalendarEvent = {
  title: string;
  currency?: string;      // e.g. "USD"
  impact?: string;        // e.g. "High", "Medium", "Low"
  datetimeUtc: string;    // ISO UTC
  source?: string;
};

type DayStatus = "GOOD" | "CAUTION" | "NO_RUN";

type DayForecast = {
  date: string; // YYYY-MM-DD (UTC bucket)
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

const ROUTINE = {
  // VistaX routine window in GMT (your standard reference)
  startGmt: "09:35",
  endGmt: "10:50",
};

function toYmdUTC(d: Date) {
  return d.toISOString().slice(0, 10);
}

function weekdayUTC(d: Date) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(d);
}

function addDaysUTC(d: Date, days: number) {
  const nd = new Date(d);
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}

function normalizeImpact(val: any): string {
  if (val == null) return "";
  const s = String(val).trim();

  // Common representations: "High", "Medium", "Low"
  if (/^high$/i.test(s)) return "High";
  if (/^medium$/i.test(s) || /^med$/i.test(s)) return "Medium";
  if (/^low$/i.test(s)) return "Low";

  // Sometimes numeric 1/2/3 is used by other sources
  if (s === "3") return "High";
  if (s === "2") return "Medium";
  if (s === "1") return "Low";

  // Fallback
  return s;
}

function isHighImpact(ev: CalendarEvent) {
  const imp = (ev.impact || "").toLowerCase();
  return imp.includes("high") || imp === "3";
}

function isUSD(ev: CalendarEvent) {
  return (ev.currency || "").toUpperCase() === "USD";
}

function isFomc(ev: CalendarEvent) {
  const t = (ev.title || "").toLowerCase();
  return (
    t.includes("fomc") ||
    t.includes("federal open market") ||
    t.includes("fed funds") ||
    t.includes("interest rate decision") && t.includes("fed")
  );
}

/**
 * ForexFactory Weekly Export (JSON) - Free source.
 * Endpoint used widely for FF calendar export:
 * https://nfs.faireconomy.media/ff_calendar_thisweek.json
 *
 * NOTE: We are NOT scraping HTML — we are consuming an export feed.
 */
async function fetchForexFactoryThisWeek(): Promise<CalendarEvent[]> {
  const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

  const r = await fetch(url, {
    headers: { "User-Agent": "kazpa-vistax-forecast/1.0" },
  });

  if (!r.ok) throw new Error(`ForexFactory error: ${r.status}`);

  const data = await r.json();

  // The feed is typically an array; still handle variants defensively.
  const arr = Array.isArray(data) ? data : (data?.events ?? data?.data ?? []);
  if (!Array.isArray(arr)) return [];

  // Map ForexFactory fields as best-effort. Their schema can change,
  // so we try multiple possible keys.
  const mapped: CalendarEvent[] = arr.map((it: any) => {
    const title =
      String(it.title ?? it.event ?? it.name ?? it.Event ?? "Economic Event").trim();

    const currency =
      String(it.currency ?? it.ccy ?? it.Currency ?? it.country ?? it.Country ?? "")
        .trim()
        .toUpperCase();

    const impact = normalizeImpact(
      it.impact ?? it.Impact ?? it.importance ?? it.Importance ?? it.impactLabel
    );

    // Time keys vary. Prefer explicit timestamps / ISO if present.
    const dtRaw =
      it.datetime ??
      it.dateTime ??
      it.DateTime ??
      it.timestamp ??
      it.time ??
      it.date ??
      it.Date ??
      it.iso ??
      it.isoDate;

    const dt = new Date(dtRaw || Date.now());

    return {
      title,
      currency: currency || undefined,
      impact: impact || undefined,
      datetimeUtc: dt.toISOString(),
      source: "ForexFactory",
    };
  });

  return mapped;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS (so Webflow/kazpa.io can call this endpoint)
  const allowed = process.env.ALLOWED_ORIGIN || "https://kazpa.io";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    // Build next 7 days UTC buckets
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const end = addDaysUTC(start, 7);

    // Fetch weekly FF calendar export, then filter to "Red folder USD only"
    const rawEvents = await fetchForexFactoryThisWeek();

    const redUsdEvents = rawEvents.filter((e) => isUSD(e) && isHighImpact(e));

    // Bucket events by UTC date (YYYY-MM-DD)
    const byDay = new Map<string, CalendarEvent[]>();
    for (const ev of redUsdEvents) {
      const dt = new Date(ev.datetimeUtc);
      const key = toYmdUTC(dt);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(ev);
    }

    // Identify FOMC days (UTC bucket days)
    const fomcDays = new Set<string>();
    for (const [day, list] of byDay.entries()) {
      if (list.some(isFomc)) fomcDays.add(day);
    }

    // Build 7-day forecast
    const days: DayForecast[] = [];
    for (let i = 0; i < 7; i++) {
      const d = addDaysUTC(start, i);
      const ymd = toYmdUTC(d);
      const weekday = weekdayUTC(d);

      const dayEvents = (byDay.get(ymd) || []).sort((a, b) =>
        a.datetimeUtc.localeCompare(b.datetimeUtc)
      );

      const isFriday = weekday.toLowerCase() === "friday";
      const hasHighUsd = dayEvents.length > 0; // already filtered to high USD
      const hasFomc = fomcDays.has(ymd);

      // Day after FOMC: if previous day bucket is FOMC
      const prev = toYmdUTC(addDaysUTC(d, -1));
      const isDayAfterFomc = fomcDays.has(prev);

      const reasons: string[] = [];
      if (isFriday) reasons.push("NO trade Fridays");
      if (hasFomc) reasons.push("FOMC day");
      if (isDayAfterFomc) reasons.push("Day after FOMC");
      if (hasHighUsd) reasons.push("High-impact USD news day (red folder routine)");

      // Status rules
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

    // Cache to reduce load (safe for a forecast)
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

    return res.status(200).send({
      ok: true,
      routine: ROUTINE,
      generatedAtUtc: new Date().toISOString(),
      rangeUtc: { start: start.toISOString(), end: end.toISOString() },
      days,
      disclaimer: [
        "This forecast is based on one commonly used VistaX routine many kazpa members have seen success with.",
        "You are free to use VistaX however you want.",
        "Not financial advice. No guarantees. You are responsible for all trading decisions.",
        "Always confirm your own news filters and trading plan before running any automation.",
      ],
      sources: {
        calendar: "ForexFactory weekly export (USD + High impact filtered)",
        tools: {
          gmtConverter: "https://www.worldtimebuddy.com/",
          newsCalendar: "https://www.forexfactory.com/",
        },
      },
    });
  } catch (err: any) {
    return res.status(500).send({
      ok: false,
      error: err?.message || "Unknown error",
    });
  }
}
