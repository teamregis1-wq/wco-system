"use client";

import {
  LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import type { ForecastPoint } from "@/lib/api";

interface HistoricalRecord {
  week_date: string;
  quantity_liters: number;
}

function fmtWeek(iso: string) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-PH", { month: "short", day: "numeric" });
}

export default function ForecastChart({
  points,
  historical = [],
}: {
  points: ForecastPoint[];
  historical?: HistoricalRecord[];
}) {
  // Last 12 actual records sorted ascending
  const actual = [...historical]
    .sort((a, b) => a.week_date.localeCompare(b.week_date))
    .slice(-12);

  const actualMap   = new Map(actual.map(r => [r.week_date, r.quantity_liters]));
  const forecastMap = new Map(points.map(p => [p.week_date, p.predicted_liters]));

  // Bridge: last actual point anchors the start of the forecast line
  const lastActual = actual[actual.length - 1];
  if (lastActual) forecastMap.set(lastActual.week_date, lastActual.quantity_liters);

  const weekSet = new Set([...actualMap.keys(), ...forecastMap.keys()]);
  const data = [...weekSet].sort().map(week => ({
    week,
    actual:    actualMap.get(week)   ?? null,
    predicted: forecastMap.get(week) ?? null,
  }));

  const hasActual  = actual.length > 0;
  const bridgeWeek = lastActual?.week_date;

  return (
    <div style={{ fontFamily: "system-ui,-apple-system,sans-serif" }}>
      {/* Legend */}
      <div style={{ display: "flex", gap: 14, marginBottom: 8, fontSize: 11, color: "#6b7280", paddingLeft: 4 }}>
        {hasActual && (
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke="#1d4ed8" strokeWidth="2.5" /></svg>
            Actual ({actual.length} wks)
          </span>
        )}
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <svg width="20" height="4"><line x1="0" y1="2" x2="20" y2="2" stroke="#0f6e56" strokeWidth="2.5" strokeDasharray={hasActual ? "5 3" : undefined} /></svg>
          12-wk Forecast
        </span>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis
            dataKey="week"
            tick={{ fontSize: 9, fill: "#9ca3af" }}
            tickFormatter={fmtWeek}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#9ca3af" }}
            tickFormatter={v => `${v}L`}
            width={38}
          />
          <Tooltip
            formatter={(v: unknown, name: string) =>
              [`${Number(v).toFixed(1)} L`, name === "actual" ? "Actual WCO" : "Forecast"]
            }
            labelFormatter={fmtWeek}
            contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }}
          />

          {hasActual && (
            <Line
              type="monotone"
              dataKey="actual"
              name="actual"
              stroke="#1d4ed8"
              strokeWidth={2.5}
              dot={{ r: 3, fill: "#1d4ed8", strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              connectNulls={false}
            />
          )}

          <Line
            type="monotone"
            dataKey="predicted"
            name="predicted"
            stroke="#0f6e56"
            strokeWidth={2}
            strokeDasharray={hasActual ? "6 3" : undefined}
            dot={{ r: 3, fill: "#0f6e56", strokeWidth: 0 }}
            activeDot={{ r: 5 }}
            connectNulls={false}
          />

          {bridgeWeek && (
            <ReferenceLine
              x={bridgeWeek}
              stroke="#d1d5db"
              strokeDasharray="4 2"
              label={{ value: "Now →", fontSize: 9, fill: "#9ca3af", position: "insideTopRight" }}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
