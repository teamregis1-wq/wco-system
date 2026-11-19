"use client";

import { useState, type CSSProperties, type InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** Style for the <input> itself (the eye button sits inside its right edge). */
  style?: CSSProperties;
};

/** Password field with a show/hide toggle. Hidden by default. */
export default function PasswordInput({ style, ...rest }: Props) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: "relative", width: "100%" }}>
      <input
        {...rest}
        type={visible ? "text" : "password"}
        style={{ ...style, paddingRight: 40 }}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        title={visible ? "Hide password" : "Show password"}
        style={S.toggle}
      >
        {visible ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 3l18 18" />
            <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
            <path d="M9.9 5.2A9.8 9.8 0 0 1 12 5c5 0 9 4.5 10 7a12.6 12.6 0 0 1-3.1 4.3M6.6 6.6C4.4 8 2.8 10.1 2 12c1 2.5 5 7 10 7a9.6 9.6 0 0 0 4.4-1.1" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  toggle: {
    position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)",
    width: 30, height: 30, display: "inline-flex", alignItems: "center", justifyContent: "center",
    border: "none", background: "transparent", borderRadius: 8, cursor: "pointer",
    color: "#64748b", padding: 0,
  },
};
