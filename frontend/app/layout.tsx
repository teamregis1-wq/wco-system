import type { Metadata } from "next";
import "./globals.css";
import Providers from "./providers";

export const metadata: Metadata = {
  title: "WCO Atlas — Waste Cooking Oil Predictive Mapping · Batangas City",
  description:
    "Map, forecast, and collect waste cooking oil across Batangas City — LSTM forecasting, Gi* hotspot analysis, and road-accurate collection routes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
