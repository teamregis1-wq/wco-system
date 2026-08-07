/**
 * WCO Atlas brand mark — an oil droplet with a location-pin core,
 * representing waste cooking oil mapped across the city.
 */
import { brandFont } from "@/lib/fonts";

interface LogoProps {
  size?: number;
}

export function LogoMark({ size = 32 }: LogoProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="wco-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#14b789" />
          <stop offset="55%" stopColor="#0f6e56" />
          <stop offset="100%" stopColor="#0a4a38" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="url(#wco-logo-bg)" />
      {/* droplet */}
      <path
        d="M24 8.5c6.2 7.6 10.3 12.9 10.3 18.4C34.3 32.9 29.7 37.5 24 37.5s-10.3-4.6-10.3-10.6c0-5.5 4.1-10.8 10.3-18.4z"
        fill="white"
        fillOpacity="0.96"
      />
      {/* pin core */}
      <circle cx="24" cy="26.5" r="4.6" fill="#0f6e56" />
      <circle cx="24" cy="26.5" r="1.8" fill="white" />
    </svg>
  );
}

interface WordmarkProps {
  size?: number;
  /** Colour of the "WCO Atlas" text */
  color?: string;
  /** Colour of the small subtitle; omit to hide it */
  subtitle?: string | null;
  subtitleColor?: string;
}

export function LogoWordmark({
  size = 34,
  color = "#0f3d30",
  subtitle = "Predictive WCO Mapping",
  subtitleColor = "#94a3b8",
}: WordmarkProps) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <LogoMark size={size} />
      <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.05 }}>
        <span className={brandFont.className} style={{ fontWeight: 700, fontSize: size * 0.52, letterSpacing: "-0.02em", color }}>
          WCO&nbsp;Atlas
        </span>
        {subtitle && (
          <span className={brandFont.className} style={{ fontSize: size * 0.24, fontWeight: 500, letterSpacing: "0.14em", textTransform: "uppercase", color: subtitleColor }}>
            {subtitle}
          </span>
        )}
      </span>
    </span>
  );
}
