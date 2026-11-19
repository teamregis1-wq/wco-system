"use client";

/**
 * Decorative, animated background for the landing page.
 *
 * Layers (back to front): drifting green glows, a slowly panning map-contour
 * pattern, a dashed "collection route" flowing between pulsing hotspot rings,
 * and warm oil droplets floating upward. Pure CSS animations on transforms and
 * opacity (GPU-friendly), pointer-events disabled, hidden from screen readers,
 * and frozen when the user prefers reduced motion.
 *
 * Positions are fixed lists (no Math.random) so server and client render the
 * same markup.
 */

// left %, size px, duration s, delay s (negative = already mid-flight on load)
const DROPS = [
  [4, 10, 22, -3], [11, 16, 28, -14], [18, 8, 19, -8], [26, 13, 25, -20],
  [33, 9, 21, -2], [41, 18, 31, -11], [49, 11, 24, -17], [56, 8, 18, -6],
  [63, 15, 27, -22], [70, 10, 23, -9], [77, 13, 29, -1], [84, 9, 20, -15],
  [90, 17, 30, -24], [96, 11, 26, -5],
] as const;

// top %, left %, colour, delay s — "hotspots" the route passes through. Kept to the
// edges and bottom so the route loops AROUND the centred headline, never through it.
const PINGS = [
  [18, 8, "#7ef0c8", 0], [58, 13, "#f5c451", 1.2], [90, 32, "#ff8a65", 2.1],
  [88, 70, "#7ef0c8", 0.6], [55, 88, "#f5c451", 1.7], [16, 91, "#7ef0c8", 2.6],
] as const;

const ROUTE = PINGS.map(([top, left]) => `${left},${top}`).join(" ");

export default function LandingBackground() {
  return (
    <div aria-hidden="true" className="wco-bg">
      <div className="wco-glow wco-glow-a" />
      <div className="wco-glow wco-glow-b" />
      <div className="wco-glow wco-glow-c" />

      {/* Map contours: two identical tiles side by side, panned by -50% for a seamless loop. */}
      <div className="wco-contours">
        {[0, 1].map(k => (
          <svg key={k} viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
            {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => (
              <path
                key={i}
                d={`M -50 ${90 + i * 80} C 200 ${40 + i * 80}, 380 ${160 + i * 80}, 600 ${100 + i * 80}
                    S 1000 ${30 + i * 80}, 1250 ${110 + i * 80}`}
                fill="none" stroke="rgba(126,240,200,0.07)" strokeWidth="1.2"
              />
            ))}
            {[0, 1, 2].map(i => (
              <ellipse key={`e${i}`} cx={300 + i * 330} cy={260 + (i % 2) * 260}
                       rx={70 + i * 18} ry={44 + i * 10}
                       fill="none" stroke="rgba(126,240,200,0.06)" strokeWidth="1" />
            ))}
          </svg>
        ))}
      </div>

      {/* Collection route through the hotspots. */}
      <svg className="wco-route" viewBox="0 0 100 100" preserveAspectRatio="none">
        <polyline points={ROUTE} fill="none" stroke="rgba(126,240,200,0.28)" strokeWidth="1.6"
                  strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 10"
                  vectorEffect="non-scaling-stroke" className="wco-route-line" />
      </svg>

      {PINGS.map(([top, left, color, delay], i) => (
        <span key={i} className="wco-ping"
              style={{ top: `${top}%`, left: `${left}%`, ["--c" as string]: color,
                       ["--d" as string]: `${delay}s` }}>
          <i /><i /><b />
        </span>
      ))}

      {DROPS.map(([left, size, dur, delay], i) => (
        <svg key={i} className="wco-drop" viewBox="0 0 24 32"
             style={{ left: `${left}%`, width: size, height: size * 1.33,
                      animationDuration: `${dur}s`, animationDelay: `${delay}s` }}>
          <path d="M12 1 C12 1 1 14.5 1 21 a11 11 0 0 0 22 0 C23 14.5 12 1 12 1Z"
                fill="rgba(245,196,81,0.30)" stroke="rgba(255,224,150,0.45)" strokeWidth="1" />
          <ellipse cx="8.5" cy="20" rx="2.4" ry="3.6" fill="rgba(255,255,255,0.35)" />
        </svg>
      ))}

      <style>{`
        .wco-bg { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
        .wco-glow { position: absolute; border-radius: 50%; will-change: transform; }
        .wco-glow-a { width: 62vmax; height: 62vmax; left: -18vmax; top: -22vmax;
          background: radial-gradient(circle, rgba(62,207,154,0.22), transparent 62%);
          animation: wco-drift-a 26s ease-in-out infinite; }
        .wco-glow-b { width: 54vmax; height: 54vmax; right: -20vmax; top: 18vh;
          background: radial-gradient(circle, rgba(126,240,200,0.14), transparent 60%);
          animation: wco-drift-b 32s ease-in-out infinite; }
        .wco-glow-c { width: 46vmax; height: 46vmax; left: 22vw; bottom: -26vmax;
          background: radial-gradient(circle, rgba(245,196,81,0.10), transparent 60%);
          animation: wco-drift-a 38s ease-in-out infinite reverse; }
        @keyframes wco-drift-a { 0%,100% { transform: translate(0,0) scale(1); }
                                 50% { transform: translate(7vw,5vh) scale(1.12); } }
        @keyframes wco-drift-b { 0%,100% { transform: translate(0,0) scale(1); }
                                 50% { transform: translate(-6vw,-4vh) scale(1.08); } }

        .wco-contours { position: absolute; top: 0; left: 0; height: 100%; width: 200%;
          display: flex; animation: wco-pan 140s linear infinite; will-change: transform; }
        .wco-contours svg { width: 50%; height: 100%; flex: none; }
        @keyframes wco-pan { from { transform: translateX(0); } to { transform: translateX(-50%); } }

        .wco-route { position: absolute; inset: 0; width: 100%; height: 100%; }
        .wco-route-line { animation: wco-dash 6s linear infinite; }
        @keyframes wco-dash { to { stroke-dashoffset: -120; } }

        .wco-ping { position: absolute; width: 0; height: 0; }
        .wco-ping i, .wco-ping b { position: absolute; left: 0; top: 0; border-radius: 50%;
          transform: translate(-50%, -50%); }
        .wco-ping b { width: 9px; height: 9px; background: var(--c);
          box-shadow: 0 0 14px var(--c); opacity: 0.85; }
        .wco-ping i { width: 64px; height: 64px; border: 1.5px solid var(--c); opacity: 0;
          animation: wco-ring 3.6s ease-out infinite; animation-delay: var(--d); }
        .wco-ping i + i { animation-delay: calc(var(--d) + 1.8s); }
        @keyframes wco-ring { 0% { transform: translate(-50%,-50%) scale(0.15); opacity: 0.7; }
                              100% { transform: translate(-50%,-50%) scale(1.6); opacity: 0; } }

        .wco-drop { position: absolute; top: 0; opacity: 0; will-change: transform, opacity;
          animation-name: wco-rise; animation-timing-function: linear; animation-iteration-count: infinite; }
        @keyframes wco-rise {
          0%   { transform: translate3d(0, 105vh, 0) rotate(-8deg); opacity: 0; }
          10%  { opacity: 0.9; }
          50%  { transform: translate3d(18px, 50vh, 0) rotate(6deg); }
          90%  { opacity: 0.8; }
          100% { transform: translate3d(-10px, -12vh, 0) rotate(-4deg); opacity: 0; }
        }

        /* Phones: the text column is narrow, so keep the background quieter. */
        @media (max-width: 640px) {
          .wco-route, .wco-ping { opacity: 0.45; }
          .wco-drop:nth-of-type(2n) { display: none; }
        }

        @media (prefers-reduced-motion: reduce) {
          .wco-bg *, .wco-bg *::before, .wco-bg *::after { animation: none !important; }
          .wco-drop { display: none; }
          .wco-ping i { opacity: 0.25; transform: translate(-50%,-50%) scale(0.8); }
        }
      `}</style>
    </div>
  );
}
