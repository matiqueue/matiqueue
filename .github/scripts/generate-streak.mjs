import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveAccounts, runGraphql } from "./github-client.mjs";

const DEFAULT_TIMEZONE = "Europe/Warsaw";

function buildMetaQuery(useViewer) {
  const root = useViewer ? "viewer" : "user(login: $login)";
  const params = useViewer ? "" : "($login: String!)";
  return `
    query ${params} {
      account: ${root} {
        createdAt
        contributionsCollection {
          contributionYears
        }
      }
    }
  `;
}

function buildMultiYearCalendarQuery(years, useViewer) {
  const root = useViewer ? "viewer" : "user(login: $login)";
  const params = useViewer ? "" : "($login: String!)";
  const blocks = years
    .map(
      (year, index) => `
        year_${index}: contributionsCollection(
          from: "${year}-01-01T00:00:00Z"
          to: "${year}-12-31T23:59:59Z"
        ) {
          contributionCalendar {
            weeks {
              contributionDays {
                contributionCount
                date
              }
            }
          }
        }
      `,
    )
    .join("\n");

  return `
    query ${params} {
      account: ${root} {
        ${blocks}
      }
    }
  `;
}

/**
 * Return `YYYY-MM-DD` for `now` in the specified IANA timezone (plus next calendar day).
 *
 * @param {string} [timezone] IANA timezone identifier.
 * @param {Date} [now] Reference date.
 * @returns {{ today: string, tomorrow: string, currentYear: number }}
 */
export function getDateWindow(timezone = DEFAULT_TIMEZONE, now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = formatter.format(now);
  const [yearStr, monthStr, dayStr] = today.split("-");
  const tomorrowDate = new Date(
    Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr) + 1),
  );
  return {
    today,
    tomorrow: tomorrowDate.toISOString().slice(0, 10),
    currentYear: Number(yearStr),
  };
}

/**
 * Fetch all daily contribution counts from account creation through today.
 */
async function fetchAccountDailyCounts(account, currentYear) {
  const variables = account.isViewerToken ? {} : { login: account.username };
  const meta = await runGraphql(
    buildMetaQuery(account.isViewerToken),
    variables,
    account.token,
  );
  const accountNode = meta?.account;
  if (!accountNode?.createdAt) {
    throw new Error(
      `Could not retrieve createdAt for "${account.username}".`,
    );
  }

  const createdYear = Number(accountNode.createdAt.slice(0, 4));
  const contribYears =
    accountNode.contributionsCollection?.contributionYears ?? [];
  const earliestYear = Math.max(
    1970,
    Math.min(createdYear, ...contribYears, currentYear),
  );

  const years = [];
  for (let y = earliestYear; y <= currentYear; y++) {
    years.push(y);
  }

  const counts = new Map();
  // 4 years per query (~1,460 days) keeps GraphQL node cost tiny.
  for (let i = 0; i < years.length; i += 4) {
    const chunk = years.slice(i, i + 4);
    const data = await runGraphql(
      buildMultiYearCalendarQuery(chunk, account.isViewerToken),
      variables,
      account.token,
    );
    const node = data?.account;
    if (!node) {
      continue;
    }
    for (let idx = 0; idx < chunk.length; idx++) {
      const weeks =
        node[`year_${idx}`]?.contributionCalendar?.weeks ?? [];
      for (const week of weeks) {
        for (const day of week.contributionDays ?? []) {
          if (day?.date) {
            // Multiple weeks across year boundaries can emit the same boundary date; keep max.
            const prev = counts.get(day.date) ?? 0;
            counts.set(day.date, Math.max(prev, day.contributionCount ?? 0));
          }
        }
      }
    }
  }

  return counts;
}

/**
 * Merge daily contribution maps across accounts and compute Total Contributions,
 * Current Streak, and Longest Streak matching github-readme-streak-stats rules.
 *
 * @param {Array<Map<string, number>>} accountMaps Daily `YYYY-MM-DD -> count` maps.
 * @param {{ today: string, tomorrow: string }} window Active date bounds.
 */
export function computeMergedStreakStats(accountMaps, { today, tomorrow }) {
  const merged = new Map();

  for (const map of accountMaps) {
    for (const [date, count] of map.entries()) {
      if (date <= today || (date === tomorrow && count > 0)) {
        merged.set(date, (merged.get(date) ?? 0) + count);
      }
    }
  }

  const sortedKeys = [...merged.keys()].sort();
  if (sortedKeys.length === 0) {
    throw new Error("No contribution dates found across accounts.");
  }

  const firstDate = sortedKeys[0];
  const lastDate = sortedKeys[sortedKeys.length - 1];

  const parseUtcDate = (ymd) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };

  let totalContributions = 0;
  let firstContribution = "";
  const currentStreak = { start: firstDate, end: firstDate, length: 0 };
  const longestStreak = { start: firstDate, end: firstDate, length: 0 };

  const endMs = parseUtcDate(lastDate).getTime();
  for (
    let cursor = parseUtcDate(firstDate);
    cursor.getTime() <= endMs;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    const count = merged.get(date) ?? 0;
    totalContributions += count;

    if (count > 0) {
      currentStreak.length += 1;
      currentStreak.end = date;
      if (currentStreak.length === 1) {
        currentStreak.start = date;
      }
      if (!firstContribution) {
        firstContribution = date;
      }
      if (currentStreak.length > longestStreak.length) {
        longestStreak.start = currentStreak.start;
        longestStreak.end = currentStreak.end;
        longestStreak.length = currentStreak.length;
      }
    } else if (date !== lastDate) {
      // Allow today to have 0 contributions so far without prematurely breaking an active streak.
      currentStreak.length = 0;
      currentStreak.start = lastDate;
      currentStreak.end = lastDate;
    }
  }

  return {
    totalContributions,
    firstContribution: firstContribution || firstDate,
    currentStreak,
    longestStreak,
  };
}

/**
 * Format a `YYYY-MM-DD` date matching github-readme-streak-stats English short style.
 *
 * @param {string} ymd Date in `YYYY-MM-DD` format.
 * @param {number} currentYear Active calendar year.
 * @returns {string} Formatted date string.
 */
export function formatStreakDate(ymd, currentYear) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const options =
    y === currentYear
      ? { month: "short", day: "numeric", timeZone: "UTC" }
      : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" };
  return new Intl.DateTimeFormat("en-US", options).format(dt);
}

/**
 * Format a start..end date range string.
 */
function formatRange(start, end, currentYear) {
  const startLabel = formatStreakDate(start, currentYear);
  const endLabel = formatStreakDate(end, currentYear);
  return startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
}

/**
 * Render the GitHub Streak SVG matching the repository's Tokyo Night borderless theme.
 */
export function renderStreakSvg(stats, currentYear) {
  const totalContribText = stats.totalContributions.toLocaleString("en-US");
  const totalRangeText = `${formatStreakDate(stats.firstContribution, currentYear)} - Present`;

  const currentLengthText = stats.currentStreak.length.toLocaleString("en-US");
  const currentRangeText = formatRange(
    stats.currentStreak.start,
    stats.currentStreak.end,
    currentYear,
  );

  const longestLengthText = stats.longestStreak.length.toLocaleString("en-US");
  const longestRangeText = formatRange(
    stats.longestStreak.start,
    stats.longestStreak.end,
    currentYear,
  );

  return `<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'
                style='isolation: isolate' viewBox='0 0 495 195' width='495px' height='195px' direction='ltr'>
        <style>
            @keyframes currstreak {
                0% { font-size: 3px; opacity: 0.2; }
                80% { font-size: 34px; opacity: 1; }
                100% { font-size: 28px; opacity: 1; }
            }
            @keyframes fadein {
                0% { opacity: 0; }
                100% { opacity: 1; }
            }
        </style>
        <defs>
            <clipPath id='outer_rectangle'>
                <rect width='495' height='195' rx='4.5'/>
            </clipPath>
            <mask id='mask_out_ring_behind_fire'>
                <rect width='495' height='195' fill='white'/>
                <ellipse id='mask-ellipse' cx='247.5' cy='32' rx='13' ry='18' fill='black'/>
            </mask>
        </defs>
        <g clip-path='url(#outer_rectangle)'>
            <g style='isolation: isolate'>
                <rect stroke='#000000' stroke-opacity='0' fill='#0d1117' rx='4.5' x='0.5' y='0.5' width='494' height='194'/>
            </g>
            <g style='isolation: isolate'>
                <line x1='165' y1='28' x2='165' y2='170' vector-effect='non-scaling-stroke' stroke-width='1' stroke='#1e293b' stroke-linejoin='miter' stroke-linecap='square' stroke-miterlimit='3'/>
                <line x1='330' y1='28' x2='330' y2='170' vector-effect='non-scaling-stroke' stroke-width='1' stroke='#1e293b' stroke-linejoin='miter' stroke-linecap='square' stroke-miterlimit='3'/>
            </g>
            <g style='isolation: isolate'>
                <!-- Total Contributions big number -->
                <g transform='translate(82.5, 48)'>
                    <text x='0' y='32' stroke-width='0' text-anchor='middle' fill='#6899cc' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='700' font-size='28px' font-style='normal' style='opacity: 0; animation: fadein 0.5s linear forwards 0.6s'>
                        ${totalContribText}
                    </text>
                </g>

                <!-- Total Contributions label -->
                <g transform='translate(82.5, 84)'>
                    <text x='0' y='32' stroke-width='0' text-anchor='middle' fill='#c9d1d9' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='400' font-size='14px' font-style='normal' style='opacity: 0; animation: fadein 0.5s linear forwards 0.7s'>
                        Total Contributions
                    </text>
                </g>

                <!-- Total Contributions range -->
                <g transform='translate(82.5, 114)'>
                    <text x='0' y='32' stroke-width='0' text-anchor='middle' fill='#8b949e' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='400' font-size='12px' font-style='normal' style='opacity: 0; animation: fadein 0.5s linear forwards 0.8s'>
                        ${totalRangeText}
                    </text>
                </g>
            </g>
            <g style='isolation: isolate'>
                <!-- Current Streak label -->
                <g transform='translate(247.5, 108)'>
                    <text x='0' y='32' stroke-width='0' text-anchor='middle' fill='#6899cc' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='700' font-size='14px' font-style='normal' style='opacity: 0; animation: fadein 0.5s linear forwards 0.9s'>
                        Current Streak
                    </text>
                </g>

                <!-- Current Streak range -->
                <g transform='translate(247.5, 145)'>
                    <text x='0' y='21' stroke-width='0' text-anchor='middle' fill='#8b949e' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='400' font-size='12px' font-style='normal' style='opacity: 0; animation: fadein 0.5s linear forwards 0.9s'>
                        ${currentRangeText}
                    </text>
                </g>

                <!-- Ring around number -->
                <g mask='url(#mask_out_ring_behind_fire)'>
                    <circle cx='247.5' cy='71' r='40' fill='none' stroke='#6899cc' stroke-width='5' style='opacity: 0; animation: fadein 0.5s linear forwards 0.4s'></circle>
                </g>
                <!-- Fire icon -->
                <g transform='translate(247.5, 19.5)' stroke-opacity='0' style='opacity: 0; animation: fadein 0.5s linear forwards 0.6s'>
                    <path d='M -12 -0.5 L 15 -0.5 L 15 23.5 L -12 23.5 L -12 -0.5 Z' fill='none'/>
                    <path d='M 1.5 0.67 C 1.5 0.67 2.24 3.32 2.24 5.47 C 2.24 7.53 0.89 9.2 -1.17 9.2 C -3.23 9.2 -4.79 7.53 -4.79 5.47 L -4.76 5.11 C -6.78 7.51 -8 10.62 -8 13.99 C -8 18.41 -4.42 22 0 22 C 4.42 22 8 18.41 8 13.99 C 8 8.6 5.41 3.79 1.5 0.67 Z M -0.29 19 C -2.07 19 -3.51 17.6 -3.51 15.86 C -3.51 14.24 -2.46 13.1 -0.7 12.74 C 1.07 12.38 2.9 11.53 3.92 10.16 C 4.31 11.45 4.51 12.81 4.51 14.2 C 4.51 16.85 2.36 19 -0.29 19 Z' fill='#d47a5a' stroke-opacity='0'/>
                </g>

                <!-- Current Streak big number -->
                <g transform='translate(247.5, 48)'>
                    <text x='0' y='32' stroke-width='0' text-anchor='middle' fill='#e2e8f0' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='700' font-size='28px' font-style='normal' style='animation: currstreak 0.6s linear forwards'>
                        ${currentLengthText}
                    </text>
                </g>
            </g>
            <g style='isolation: isolate'>
                <!-- Longest Streak big number -->
                <g transform='translate(412.5, 48)'>
                    <text x='0' y='32' stroke-width='0' text-anchor='middle' fill='#6899cc' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='700' font-size='28px' font-style='normal' style='opacity: 0; animation: fadein 0.5s linear forwards 1.2s'>
                        ${longestLengthText}
                    </text>
                </g>

                <!-- Longest Streak label -->
                <g transform='translate(412.5, 84)'>
                    <text x='0' y='32' stroke-width='0' text-anchor='middle' fill='#c9d1d9' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='400' font-size='14px' font-style='normal' style='opacity: 0; animation: fadein 0.5s linear forwards 1.3s'>
                        Longest Streak
                    </text>
                </g>

                <!-- Longest Streak range -->
                <g transform='translate(412.5, 114)'>
                    <text x='0' y='32' stroke-width='0' text-anchor='middle' fill='#8b949e' stroke='none' font-family='"Segoe UI", Ubuntu, sans-serif' font-weight='400' font-size='12px' font-style='normal' style='opacity: 0; animation: fadein 0.5s linear forwards 1.4s'>
                        ${longestRangeText}
                    </text>
                </g>
            </g>
        </g>
    </svg>
`;
}

/**
 * Fetch multi-year contribution histories across accounts and write `streak.svg`.
 */
async function main() {
  const outputDir = process.env.OUTPUT_DIR?.trim() || "dist";
  const timezone = process.env.STREAK_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  const dateWindow = getDateWindow(timezone);

  const accounts = await resolveAccounts(process.env);
  const accountMaps = await Promise.all(
    accounts.map((account) =>
      fetchAccountDailyCounts(account, dateWindow.currentYear),
    ),
  );

  const stats = computeMergedStreakStats(accountMaps, dateWindow);
  const svg = renderStreakSvg(stats, dateWindow.currentYear);

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "streak.svg"), svg, "utf8");

  console.log(
    "Generated streak.svg:",
    JSON.stringify({
      accounts: accounts.map((a) => a.username),
      totalContributions: stats.totalContributions,
      firstContribution: stats.firstContribution,
      currentStreak: stats.currentStreak,
      longestStreak: stats.longestStreak,
    }),
  );
}

const isEntrypoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
