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
      `<rect x="${38 + idx * 13}" y="160" width="9" height="9" rx="2" fill="${color}" stroke="#ffffff" stroke-opacity="0.06" stroke-width="0.6"/>`,
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 176" width="860" height="176" fill="none">
  <desc>Generated with https://github.com/Platane/snk</desc>
  <defs>
    <clipPath id="snk-grid-clip">
      <rect x="-4" y="-4" width="856" height="118" rx="4"/>
    </clipPath>
  </defs>
  <style>
    ${snkStyle}
    .s { filter: drop-shadow(0 0 4px rgba(97, 218, 251, 0.55)); }
    .snk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    @keyframes snk-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .snk-dot { animation: snk-pulse 2.2s ease-in-out infinite; }
  </style>
  <g>
    <circle cx="12" cy="14" r="3.5" fill="#34d399" class="snk-dot"/>
    <text x="23" y="17.5" fill="#94a3b8" class="snk-mono" font-size="10.5" font-weight="600" letter-spacing="0.08em">CONTRIBUTION FLOW · ${weeksCount} WEEKS</text>
    <text x="852" y="17.5" fill="#cbd5e1" text-anchor="end" class="snk-mono" font-size="10.5" font-weight="600" letter-spacing="0.04em">${totalText} CONTRIBUTIONS${accountLabel}</text>
  </g>
  <line x1="8" y1="27" x2="852" y2="27" stroke="#1e293b" stroke-width="1" stroke-opacity="0.8"/>
  <g transform="translate(6, 35)" clip-path="url(#snk-grid-clip)">${snkBody}</g>
  <g>
    <text x="8" y="168" fill="#64748b" text-anchor="start" class="snk-mono" font-size="9.5">Less</text>
    ${legendRects}
    <text x="106" y="168" fill="#64748b" text-anchor="start" class="snk-mono" font-size="9.5">More</text>
  </g>
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
