import { Space_Grotesk } from "next/font/google";

/**
 * Brand typeface for the WCO Atlas wordmark and display headings.
 * Self-hosted by next/font at build time — no runtime external requests.
 */
export const brandFont = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  display: "swap",
});
