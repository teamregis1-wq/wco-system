"use client";

/**
 * Floating "live preview" minimap card for the landing page.
 *
 * An illustrative (not data-driven) mini map of Batangas City: the bay, roads,
 * the Calumpang river, KDE-style density glows, pulsing Gi* hotspots, and a
 * collection vehicle travelling along a route — plus a 13-week forecast
 * sparkline that draws itself. Glass card with a gentle float. All motion is
 * dropped for users who prefer reduced motion.
 */
import { useEffect, useState } from "react";

const HOTSPOTS = [
  { x: 268, y: 150, r: 7, c: "#ff8a65", d: 0 },    // SM City / Pallocan
  { x: 196, y: 172, r: 6, c: "#f5c451", d: 0.8 },  // Poblacion
  { x: 330, y: 92,  r: 6, c: "#f5c451", d: 1.6 },  // Kumintang
  { x: 408, y: 58,  r: 5, c: "#7ef0c8", d: 2.2 },  // Alangilan
  { x: 150, y: 118, r: 4, c: "#7ef0c8", d: 1.1 },  // Bolbok
];
const ROUTE = "M 120 196 L 196 172 L 230 160 L 268 150 L 300 122 L 330 92 L 372 76 L 408 58";
const FORECAST = [32, 34, 33, 37, 36, 40, 42, 41, 45, 47, 46, 50, 52]; // illustrative shape

function sparkPath(vals: number[], w: number, h: number) {
  const min = Math.min(...vals), max = Math.max(...vals);
  return vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * (h - 4) - 2;
    return `${i ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(" ");
}

export default function MiniMapCard() {
  const [motion, setMotion] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setMotion(!mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  const spark = sparkPath(FORECAST, 150, 34);

  return (
    <div className="wco-mm-wrap" aria-label="Illustrative preview of the WCO Atlas map" role="img">
      <div className="wco-mm-card">
        {/* Header */}
        <div className="wco-mm-head">
          <span className="wco-mm-live"><i />Map preview</span>
          <span className="wco-mm-title">Batangas City</span>
          <span className="wco-mm-chips">
            <b style={{ color: "#ff8a65" }}>● Hotspots</b>
            <b style={{ color: "#7ef0c8" }}>◍ Density</b>
            <b style={{ color: "#f5c451" }}>— Route</b>
          </span>
        </div>

        {/* Map */}
        <svg className="wco-mm-map" viewBox="0 0 480 230" preserveAspectRatio="xMidYMid slice">
          <defs>
            <radialGradient id="wco-mm-kde-hot"><stop offset="0" stopColor="#ff8a65" stopOpacity="0.55" /><stop offset="1" stopColor="#ff8a65" stopOpacity="0" /></radialGradient>
            <radialGradient id="wco-mm-kde-warm"><stop offset="0" stopColor="#f5c451" stopOpacity="0.45" /><stop offset="1" stopColor="#f5c451" stopOpacity="0" /></radialGradient>
            <radialGradient id="wco-mm-kde-cool"><stop offset="0" stopColor="#7ef0c8" stopOpacity="0.35" /><stop offset="1" stopColor="#7ef0c8" stopOpacity="0" /></radialGradient>
            <pattern id="wco-mm-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(126,240,200,0.07)" strokeWidth="1" />
            </pattern>
            <linearGradient id="wco-mm-sea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#0b5a7a" stopOpacity="0.55" /><stop offset="1" stopColor="#083b55" stopOpacity="0.75" />
            </linearGradient>
          </defs>

          <rect width="480" height="230" fill="#0a3a2d" />
          <rect width="480" height="230" fill="url(#wco-mm-grid)" />

          {/* Batangas Bay (south-west) */}
          <path d="M 0 150 C 40 160, 70 190, 110 200 C 150 212, 170 230, 180 230 L 0 230 Z" fill="url(#wco-mm-sea)" />
          <path d="M 0 150 C 40 160, 70 190, 110 200 C 150 212, 170 230, 180 230" fill="none"
                stroke="rgba(126,220,255,0.35)" strokeWidth="1.2" />
          {/* Calumpang river */}
          <path d="M 480 160 C 420 150, 380 175, 330 172 C 290 170, 250 190, 214 214 L 205 230"
                fill="none" stroke="rgba(110,190,230,0.45)" strokeWidth="2.2" />
          {/* Roads */}
          <g fill="none" stroke="rgba(255,255,255,0.13)" strokeLinecap="round">
            <path d="M 60 120 L 200 170 L 300 120 L 470 30" strokeWidth="3" />
            <path d="M 196 172 L 230 60 L 250 0" strokeWidth="2" />
            <path d="M 268 150 L 340 230" strokeWidth="2" />
            <path d="M 120 60 L 330 92 L 480 110" strokeWidth="1.6" />
            <path d="M 150 118 L 160 0" strokeWidth="1.4" />
          </g>

          {/* KDE density glows */}
          <circle cx="262" cy="150" r="70" fill="url(#wco-mm-kde-hot)" />
          <circle cx="200" cy="170" r="52" fill="url(#wco-mm-kde-warm)" />
          <circle cx="330" cy="95" r="50" fill="url(#wco-mm-kde-warm)" />
          <circle cx="405" cy="60" r="44" fill="url(#wco-mm-kde-cool)" />

          {/* Collection route */}
          <path id="wco-mm-route" d={ROUTE} fill="none" stroke="#f5c451" strokeOpacity="0.85" strokeWidth="2"
                strokeDasharray="5 6" strokeLinecap="round" className={motion ? "wco-mm-flow" : undefined} />
          {/* Depot */}
          <rect x="113" y="189" width="14" height="14" rx="4" fill="#0f6e56" stroke="#7ef0c8" strokeWidth="1.5" />

          {/* Hotspots */}
          {HOTSPOTS.map((h, i) => (
            <g key={i}>
              {motion && (
                <circle cx={h.x} cy={h.y} r={h.r} fill="none" stroke={h.c} strokeWidth="1.5">
                  <animate attributeName="r" from={h.r} to={h.r * 4} dur="2.8s" begin={`${h.d}s`} repeatCount="indefinite" />
                  <animate attributeName="opacity" from="0.8" to="0" dur="2.8s" begin={`${h.d}s`} repeatCount="indefinite" />
                </circle>
              )}
              <circle cx={h.x} cy={h.y} r={h.r} fill={h.c} fillOpacity="0.9" stroke="rgba(255,255,255,0.75)" strokeWidth="1.2" />
            </g>
          ))}

          {/* Collection vehicle travelling the route */}
          <g>
            <circle r="7" fill="#ffffff" fillOpacity="0.95" stroke="#0f6e56" strokeWidth="2.5" cx={motion ? 0 : 120} cy={motion ? 0 : 196}>
              {motion && (
                <animateMotion dur="9s" repeatCount="indefinite" rotate="auto" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear">
                  <mpath href="#wco-mm-route" />
                </animateMotion>
              )}
            </circle>
          </g>

          {/* Place labels */}
          <g fontFamily="system-ui, sans-serif" fontSize="9.5" fontWeight="700" fill="rgba(255,255,255,0.62)" letterSpacing="0.04em">
            <text x="168" y="194">POBLACION</text>
            <text x="276" y="166">SM CITY</text>
            <text x="338" y="84">KUMINTANG</text>
            <text x="398" y="44">ALANGILAN</text>
            <text x="22" y="214" fill="rgba(170,220,255,0.6)">BATANGAS BAY</text>
          </g>
        </svg>

        {/* Footer */}
        <div className="wco-mm-foot">
          <div className="wco-mm-stat"><b>120</b><span>establishments</span></div>
          <div className="wco-mm-stat"><b>Gi*</b><span>hotspot z-scores</span></div>
          <div className="wco-mm-spark">
            <span>13-week forecast</span>
            <svg viewBox="0 0 150 34" width="150" height="34">
              <path d={spark} fill="none" stroke="#7ef0c8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                    pathLength={1} className={motion ? "wco-mm-draw" : undefined} />
            </svg>
          </div>
        </div>
        <div className="wco-mm-note">Illustrative preview — open the app for the live map.</div>
      </div>

      <style>{`
        .wco-mm-wrap { perspective: 1200px; max-width: 760px; margin: 0 auto 46px; padding: 0 4px; }
        .wco-mm-card {
          position: relative; border-radius: 22px; padding: 14px 14px 10px; text-align: left;
          background: linear-gradient(160deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04));
          backdrop-filter: blur(18px) saturate(160%); -webkit-backdrop-filter: blur(18px) saturate(160%);
          border: 1px solid rgba(126,240,200,0.22);
          box-shadow: 0 30px 80px rgba(0,0,0,0.35), 0 0 0 1px rgba(255,255,255,0.04) inset,
                      0 0 60px rgba(62,207,154,0.12);
          transform-style: preserve-3d;
          animation: wco-mm-float 7s ease-in-out infinite;
        }
        @keyframes wco-mm-float {
          0%, 100% { transform: rotateX(5deg) translateY(0); }
          50%      { transform: rotateX(3deg) translateY(-10px); }
        }
        .wco-mm-head { display: flex; align-items: center; gap: 10px; margin: 2px 4px 10px; flex-wrap: wrap; }
        .wco-mm-live { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; font-weight: 900;
          letter-spacing: 0.14em; text-transform: uppercase; color: #7ef0c8; }
        .wco-mm-live i { width: 7px; height: 7px; border-radius: 50%; background: #7ef0c8;
          box-shadow: 0 0 10px #7ef0c8; animation: wco-mm-blink 1.6s ease-in-out infinite; }
        @keyframes wco-mm-blink { 50% { opacity: 0.3; } }
        .wco-mm-title { font-size: 13px; font-weight: 800; color: rgba(255,255,255,0.9); }
        .wco-mm-chips { margin-left: auto; display: inline-flex; gap: 10px; font-size: 10.5px; }
        .wco-mm-chips b { font-weight: 700; opacity: 0.9; }
        .wco-mm-map { display: block; width: 100%; aspect-ratio: 480 / 230; border-radius: 14px;
          border: 1px solid rgba(255,255,255,0.08); }
        .wco-mm-flow { animation: wco-mm-dash 1.4s linear infinite; }
        @keyframes wco-mm-dash { to { stroke-dashoffset: -22; } }
        .wco-mm-foot { display: flex; align-items: center; gap: 18px; margin: 10px 6px 2px; flex-wrap: wrap; }
        .wco-mm-stat { display: flex; flex-direction: column; line-height: 1.15; }
        .wco-mm-stat b { font-size: 17px; font-weight: 900; color: #fff; }
        .wco-mm-stat span { font-size: 10.5px; color: rgba(255,255,255,0.55); }
        .wco-mm-spark { margin-left: auto; display: flex; align-items: center; gap: 10px;
          font-size: 10.5px; color: rgba(255,255,255,0.55); }
        .wco-mm-draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: wco-mm-drawline 6s ease-in-out infinite; }
        @keyframes wco-mm-drawline { 0% { stroke-dashoffset: 1; } 45%, 85% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: 0; opacity: 0; } }
        .wco-mm-note { margin: 6px 6px 0; font-size: 10px; color: rgba(255,255,255,0.38); }

        @media (max-width: 640px) {
          .wco-mm-wrap { margin-bottom: 34px; }
          .wco-mm-card { padding: 10px 10px 8px; border-radius: 18px; }
          .wco-mm-chips { display: none; }
          .wco-mm-spark { margin-left: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .wco-mm-card, .wco-mm-live i { animation: none !important; transform: none !important; }
        }
      `}</style>
    </div>
  );
}
