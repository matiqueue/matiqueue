import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveAccounts, runGraphql } from "./github-client.mjs";

function buildCalendarQuery(useViewer) {
  const root = useViewer ? "viewer" : "user(login: $login)";
  const params = useViewer ? "" : "($login: String!)";
  return `
    query ${params} {
      account: ${root} {
        contributionsCollection {
          hasAnyRestrictedContributions
          restrictedContributionsCount
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
                contributionLevel
                weekday
                date
              }
            }
          }
        }
      }
    }
  `;
}

/**
 * Compute GitHub-style quartile thresholds over non-zero daily contribution counts.
 *
 * @param {Array<number>} positiveCounts Non-zero daily counts.
 * @returns {(count: number) => "NONE" | "FIRST_QUARTILE" | "SECOND_QUARTILE" | "THIRD_QUARTILE" | "FOURTH_QUARTILE"}
 */
export function createLevelClassifier(positiveCounts) {
  if (positiveCounts.length === 0) {
    return () => "NONE";
  }

  const sorted = [...positiveCounts].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1];
  const atPercentile = (p) => sorted[Math.floor((sorted.length - 1) * p)];
  const q1 = atPercentile(0.25);
  const q2 = atPercentile(0.5);
  const q3 = atPercentile(0.75);

  return (count) => {
    if (count <= 0) return "NONE";
    if (count === max && max >= 4) return "FOURTH_QUARTILE";
    if (count <= q1) return "FIRST_QUARTILE";
    if (count <= q2) return "SECOND_QUARTILE";
    if (count <= q3) return "THIRD_QUARTILE";
    return "FOURTH_QUARTILE";
  };
}

/**
 * Merge multiple GitHub `contributionCalendar` payloads by date and recompute quartile levels.
 *
 * @param {Array<{ totalContributions: number, weeks: Array<{ contributionDays: Array<{ date: string, weekday: number, contributionCount: number, contributionLevel: string }> }> }>} calendars
 */
export function mergeContributionCalendars(calendars) {
  if (calendars.length === 0) {
    throw new Error("At least one contribution calendar is required.");
  }

  const countsByDate = new Map();
  for (const calendar of calendars) {
    for (const week of calendar.weeks ?? []) {
      for (const day of week.contributionDays ?? []) {
        if (!day?.date) continue;
        countsByDate.set(
          day.date,
          (countsByDate.get(day.date) ?? 0) + (day.contributionCount ?? 0),
        );
      }
    }
  }

  const baseWeeks = calendars[0].weeks ?? [];
  const positiveCounts = [];
  for (const week of baseWeeks) {
    for (const day of week.contributionDays ?? []) {
      const mergedCount = countsByDate.get(day.date) ?? 0;
      if (mergedCount > 0) {
        positiveCounts.push(mergedCount);
      }
    }
  }

  const classify = createLevelClassifier(positiveCounts);
  let totalContributions = 0;

  const weeks = baseWeeks.map((week) => ({
    contributionDays: (week.contributionDays ?? []).map((day) => {
      const contributionCount = countsByDate.get(day.date) ?? 0;
      totalContributions += contributionCount;
      return {
        date: day.date,
        weekday: day.weekday,
        contributionCount,
        contributionLevel: classify(contributionCount),
      };
    }),
  }));

  return { totalContributions, weeks };
}

/**
 * Fetch an account's contribution calendar via GitHub GraphQL.
 */
async function fetchAccountCalendar(account) {
  const query = buildCalendarQuery(account.isViewerToken);
  const variables = account.isViewerToken ? {} : { login: account.username };
  const data = await runGraphql(query, variables, account.token);
  const collection = data?.account?.contributionsCollection;
  const calendar = collection?.contributionCalendar;
  if (!calendar) {
    throw new Error(
      `Could not fetch contributionCalendar for "${account.username}".`,
    );
  }

  console.log(
    `Calendar for "${account.username}" (viewer=${account.isViewerToken}): totalContributions=${calendar.totalContributions}, restricted=${collection.restrictedContributionsCount ?? 0}`,
  );
  return calendar;
}

/**
 * Fetch and merge calendars across configured accounts, then run Platane/snk's SVG generator.
 */
async function main() {
  const snkEntry = process.env.SNK_ENTRY?.trim();
  if (!snkEntry) {
    throw new Error("SNK_ENTRY environment variable is required.");
  }

  const accounts = await resolveAccounts(process.env);
  const calendars = [];
  for (const account of accounts) {
    calendars.push(await fetchAccountCalendar(account));
  }

  const mergedCalendar = mergeContributionCalendars(calendars);
  console.log(
    `Merged contribution calendar across ${accounts.length} account(s): totalContributions=${mergedCalendar.totalContributions}`,
  );

  // Intercept Platane/snk's single-user GraphQL calendar fetch and supply the merged calendar.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const urlStr = typeof url === "string" ? url : url?.url ?? "";
    const body = typeof init?.body === "string" ? init.body : "";
    if (
      urlStr === "https://api.github.com/graphql" &&
      body.includes("contributionCalendar")
    ) {
      return new Response(
        JSON.stringify({
          data: {
            user: {
              contributionsCollection: {
                contributionCalendar: mergedCalendar,
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    return originalFetch(url, init);
  };

  process.env.GITHUB_TOKEN ||= accounts[0].token;
  process.env.INPUT_GITHUB_USER_NAME ||= accounts[0].username;

  const require = createRequire(import.meta.url);
  require(path.resolve(snkEntry));
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
