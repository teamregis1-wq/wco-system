/**
 * Shared "green glass" design tokens.
 *
 * Glass = translucent white over the green-tinted app background, with a
 * backdrop blur and a soft green shadow. Print rules in globals.css turn any
 * element with an inline backdrop-filter back into a crisp white card, so
 * PDF exports stay clean and legible.
 */
import type { CSSProperties } from "react";

export const GREEN = {
  deep: "#06281e",
  brand: "#0f6e56",
  mid: "#1f9d78",
  bright: "#3ecf9a",
  mint: "#7ef0c8",
};

/** Standard glass card. */
export const glass: CSSProperties = {
  background: "rgba(255,255,255,0.62)",
  backdropFilter: "blur(16px) saturate(160%)",
  WebkitBackdropFilter: "blur(16px) saturate(160%)",
  border: "1px solid rgba(255,255,255,0.72)",
  boxShadow: "0 10px 30px rgba(15,110,86,0.10), 0 1px 2px rgba(15,110,86,0.06), inset 0 1px 0 rgba(255,255,255,0.7)",
};

/** More opaque glass for dense content (modals, tables, forms). */
export const glassStrong: CSSProperties = {
  ...glass,
  background: "rgba(255,255,255,0.86)",
};

/** Subtle inner glass tile (inside a glass card). */
export const glassTile: CSSProperties = {
  background: "rgba(255,255,255,0.55)",
  border: "1px solid rgba(255,255,255,0.8)",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6)",
};

/** Green primary-button gradient. */
export const greenGradient = "linear-gradient(135deg, #0f6e56 0%, #1f9d78 100%)";
