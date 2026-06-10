import type { ReactNode, CSSProperties } from "react";

interface Props {
  title:      string;
  subtitle?:  string;
  action?:    ReactNode;
  children:   ReactNode;
  maxWidth?:  number;
  noPadding?: boolean;
}

export default function PageShell({ title, subtitle, action, children, maxWidth = 1280, noPadding }: Props) {
  return (
    <div style={{ background: "#f3f4f6", minHeight: "100%", padding: noPadding ? 0 : 24 }}>
      <div style={{ maxWidth, margin: "0 auto" }}>
        {!noPadding && (
          <div style={H.header}>
            <div>
              <h1 style={H.title}>{title}</h1>
              {subtitle && <p style={H.subtitle}>{subtitle}</p>}
            </div>
            {action && <div style={{ flexShrink: 0 }}>{action}</div>}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export const card: CSSProperties = {
  background: "white", borderRadius: 14, padding: 20,
  boxShadow: "0 1px 3px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.05)",
  border: "1px solid rgba(0,0,0,0.06)",
};

export const primaryBtn: CSSProperties = {
  padding: "8px 18px", borderRadius: 9, border: "none",
  background: "#0f6e56", color: "white",
  fontWeight: 700, fontSize: 13, cursor: "pointer",
  boxShadow: "0 2px 8px rgba(15,110,86,0.25)",
};

export const ghostBtn: CSSProperties = {
  padding: "7px 14px", borderRadius: 9,
  border: "1px solid #e2e8f0", background: "white",
  color: "#64748b", fontWeight: 600, fontSize: 12, cursor: "pointer",
};

export const input: CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 9,
  border: "1.5px solid #e2e8f0", fontSize: 13,
  outline: "none", boxSizing: "border-box",
  fontFamily: "inherit", color: "#1a202c",
};

export const label: CSSProperties = {
  display: "block", fontSize: 12, fontWeight: 700,
  color: "#374151", marginBottom: 5, letterSpacing: "0.02em",
};

const H: Record<string, CSSProperties> = {
  header: {
    display: "flex", alignItems: "flex-start",
    justifyContent: "space-between", marginBottom: 24, gap: 16,
  },
  title: {
    fontSize: 24, fontWeight: 900, color: "#111827",
    margin: "0 0 4px", letterSpacing: "-0.02em",
  },
  subtitle: { fontSize: 13, color: "#6b7280", margin: 0, lineHeight: 1.5 },
};
