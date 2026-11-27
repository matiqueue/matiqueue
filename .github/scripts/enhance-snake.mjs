import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const distDir = process.argv[2] || "dist";

const LEGEND_COLORS = ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"];

function stripProgressBar(svg) {
  return svg.replace(/<rect class="u [^"]*"[^>]*\/>/g, "");
}

function enhanceLightSvg(svg) {
  return stripProgressBar(svg)
    .replace(/viewBox="-16 -32 880 192"/g, 'viewBox="-16 0 880 114"')
    .replace(/height="192"/g, 'height="114"');
}

function enhanceDarkSvg(svg, meta) {
  const cleaned = stripProgressBar(svg);
  const styleMatch = cleaned.match(/<style>([\s\S]*?)<\/style>/);
  const bodyMatch = cleaned.match(/<\/style>([\s\S]*?)<\/svg>/);
  if (!styleMatch || !bodyMatch) {
    throw new Error("Unexpected Platane/snk SVG structure.");
  }

  const snkStyle = styleMatch[1];
  const snkBody = bodyMatch[1];

  const totalText = Number(meta.totalContributions || 0).toLocaleString("en-US");
  const weeksCount = Number(meta.weeks || 53);
  const accountLabel =
    meta.accountCount > 1 ? ` · ${meta.accountCount} ACCOUNTS` : "";

  const legendRects = LEGEND_COLORS.map(
    (color, idx) =>
      `<rect x="${778 + idx * 13}" y="160" width="9" height="9" rx="2" fill="${color}" stroke="#ffffff" stroke-opacity="0.06" stroke-width="0.6"/>`,
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 182" width="900" height="182" fill="none">
  <desc>Generated with https://github.com/Platane/snk</desc>
  <defs>
    <linearGradient id="snk-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#080c14"/>
      <stop offset="50%" stop-color="#0d1322"/>
      <stop offset="100%" stop-color="#060911"/>
    </linearGradient>
    <linearGradient id="snk-border" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45"/>
      <stop offset="50%" stop-color="#1e293b" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#34d399" stop-opacity="0.4"/>
    </linearGradient>
    <radialGradient id="snk-glow-l" cx="18%" cy="40%" r="50%">
      <stop offset="0%" stop-color="#0ea5e9" stop-opacity="0.09"/>
      <stop offset="100%" stop-color="#0ea5e9" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="snk-glow-r" cx="84%" cy="60%" r="48%">
      <stop offset="0%" stop-color="#10b981" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="snk-card-clip">
      <rect x="1" y="1" width="898" height="180" rx="14"/>
    </clipPath>
    <clipPath id="snk-grid-clip">
      <rect x="-2" y="-2" width="852" height="114" rx="4"/>
    </clipPath>
  </defs>
  <style>
    ${snkStyle}
    .s { filter: drop-shadow(0 0 4px rgba(97, 218, 251, 0.55)); }
    .snk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    @keyframes snk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .snk-dot { animation: snk-pulse 2.2s ease-in-out infinite; }
  </style>
  <g clip-path="url(#snk-card-clip)">
    <rect x="1" y="1" width="898" height="180" rx="14" fill="url(#snk-bg)"/>
    <rect x="1" y="1" width="898" height="180" rx="14" fill="url(#snk-glow-l)"/>
    <rect x="1" y="1" width="898" height="180" rx="14" fill="url(#snk-glow-r)"/>
    <g>
      <circle cx="32" cy="23" r="3.5" fill="#34d399" class="snk-dot"/>
      <text x="43" y="26.5" fill="#94a3b8" class="snk-mono" font-size="10.5" font-weight="600" letter-spacing="0.08em">CONTRIBUTION FLOW · ${weeksCount} WEEKS</text>
      <text x="872" y="26.5" fill="#cbd5e1" text-anchor="end" class="snk-mono" font-size="10.5" font-weight="600" letter-spacing="0.04em">${totalText} CONTRIBUTIONS${accountLabel}</text>
    </g>
    <line x1="28" y1="36" x2="872" y2="36" stroke="#1e293b" stroke-width="1" stroke-opacity="0.7"/>
    <g transform="translate(26, 42)" clip-path="url(#snk-grid-clip)">${snkBody}</g>
    <g>
      <text x="771" y="168" fill="#64748b" text-anchor="end" class="snk-mono" font-size="9.5">Less</text>
      ${legendRects}
      <text x="872" y="168" fill="#64748b" text-anchor="end" class="snk-mono" font-size="9.5">More</text>
    </g>
  </g>
  <rect x="1" y="1" width="898" height="180" rx="14" stroke="url(#snk-border)" stroke-width="1" fill="none"/>
</svg>
`;
}

async function main() {
  const metaPath = path.join(distDir, ".snake-meta.json");
  let meta = { totalContributions: 0, accountCount: 1, weeks: 53 };
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8"));
  } catch {
    // fallback defaults if metadata file is absent
  }

  const lightPath = path.join(distDir, "github-contribution-grid-snake.svg");
  const darkPath = path.join(distDir, "github-contribution-grid-snake-dark.svg");

  const [lightSvg, darkSvg] = await Promise.all([
    readFile(lightPath, "utf8"),
    readFile(darkPath, "utf8"),
  ]);

  await Promise.all([
    writeFile(lightPath, enhanceLightSvg(lightSvg), "utf8"),
    writeFile(darkPath, enhanceDarkSvg(darkSvg, meta), "utf8"),
  ]);

  await rm(metaPath, { force: true });
  console.log("Enhanced snake SVGs:", { totalContributions: meta.totalContributions, weeks: meta.weeks });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
