import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseCsv, resolveAccounts, runGraphql } from "./github-client.mjs";

const ROLE_AFFILIATIONS = ["OWNER", "ORGANIZATION_MEMBER", "COLLABORATOR"];

const CARD_THEME_OPTIONS = {
  theme: "tokyonight",
  hide_border: true,
  bg_color: "0d1117",
  title_color: "70a5fd",
  text_color: "c0caf5",
};

const STATS_CARD_OPTIONS = {
  ...CARD_THEME_OPTIONS,
  icon_color: "bb9af7",
  show_icons: true,
  include_all_commits: true,
  hide: [],
  show: [],
};

const TOP_LANGS_OPTIONS = {
  ...CARD_THEME_OPTIONS,
  layout: "compact",
  langs_count: 8,
};

const REPO_LANG_FIELDS = `
  name
  nameWithOwner
  isFork
  isPrivate
  stargazerCount
  languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
    edges {
      size
      node {
        color
        name
      }
    }
  }
`;

function buildStarReposQuery(useViewer) {
  const root = useViewer ? "viewer" : "user(login: $login)";
  const params = useViewer ? "($after: String)" : "($login: String!, $after: String)";
  const args = useViewer
    ? `first: 100, after: $after, affiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], orderBy: { direction: DESC, field: STARGAZERS }`
    : `first: 100, after: $after, ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], orderBy: { direction: DESC, field: STARGAZERS }`;

  return `
    query ${params} {
      account: ${root} {
        followers {
          totalCount
        }
        contributionsCollection {
          contributionYears
        }
        repositories(${args}) {
          nodes {
            name
            nameWithOwner
            stargazerCount
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;
}

function buildLangReposQuery(useViewer) {
  const root = useViewer ? "viewer" : "user(login: $login)";
  const params = useViewer ? "($after: String)" : "($login: String!, $after: String)";
  const args = useViewer
    ? `first: 100, after: $after, isFork: false, affiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR], ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]`
    : `first: 100, after: $after, isFork: false, ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]`;

  return `
    query ${params} {
      account: ${root} {
        repositories(${args}) {
          nodes {
            ${REPO_LANG_FIELDS}
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;
}

function buildContributedReposQuery(useViewer) {
  const root = useViewer ? "viewer" : "user(login: $login)";
  const params = useViewer ? "($after: String)" : "($login: String!, $after: String)";
  return `
    query ${params} {
      account: ${root} {
        repositoriesContributedTo(
          first: 100
          after: $after
          contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
          includeUserRepositories: true
        ) {
          nodes {
            ${REPO_LANG_FIELDS}
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;
}

function buildYearlyContribReposQuery(years, useViewer) {
  const root = useViewer ? "viewer" : "user(login: $login)";
  const params = useViewer ? "" : "($login: String!)";
  const yearBlocks = years
    .map(
      (year, index) => `
        year_${index}: contributionsCollection(
          from: "${year}-01-01T00:00:00Z"
          to: "${year}-12-31T23:59:59Z"
        ) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              ${REPO_LANG_FIELDS}
            }
          }
          pullRequestContributionsByRepository(maxRepositories: 100) {
            repository {
              ${REPO_LANG_FIELDS}
            }
          }
        }
      `,
    )
    .join("\n");

  return `
    query ${params} {
      account: ${root} {
        ${yearBlocks}
      }
    }
  `;
}

/**
 * Resolve the build directory of `@stats-organization/github-readme-stats-core`.
 *
 * @param {string | undefined} explicitBuildDir Optional explicit path override.
 * @returns {string} Absolute path to the core package `build` directory.
 */
export function resolveCoreBuildDir(
  explicitBuildDir = process.env.CORE_BUILD_DIR,
) {
  if (explicitBuildDir) {
    return path.resolve(explicitBuildDir);
  }
  const require = createRequire(import.meta.url);
  const entryPath = require.resolve(
    "@stats-organization/github-readme-stats-core",
  );
  return path.dirname(entryPath);
}

/**
 * Dynamically import the internal modules from `@stats-organization/github-readme-stats-core`.
 *
 * @param {string} buildDir Path to the core package `build` directory.
 */
export async function loadCoreModules(buildDir = resolveCoreBuildDir()) {
  const importCore = (relPath) =>
    import(pathToFileURL(path.join(buildDir, relPath)).href);

  const [rankMod, statsCardMod, langsCardMod, statsFetcherMod, configMod] =
    await Promise.all([
      importCore("calculateRank.js"),
      importCore("cards/stats.js"),
      importCore("cards/top-languages.js"),
      importCore("fetchers/stats.js"),
      importCore("common/config.js"),
    ]);

  return {
    calculateRank: rankMod.calculateRank,
    renderStatsCard: statsCardMod.renderStatsCard,
    renderTopLanguages: langsCardMod.renderTopLanguages,
    fetchStats: statsFetcherMod.fetchStats,
    loadConfigFromEnv: configMod.loadConfigFromEnv,
  };
}

/**
 * Paginate a GraphQL `account` connection up to `maxPages`.
 */
async function paginateAccountConnection(
  query,
  username,
  token,
  useViewer,
  selectConnection,
  { maxPages = 10, shouldStop } = {},
) {
  const items = [];
  let after = null;
  let firstAccount = null;

  for (let page = 0; page < maxPages; page++) {
    const variables = useViewer ? { after } : { login: username, after };
    const data = await runGraphql(query, variables, token);
    const account = data?.account;
    if (!account) {
      throw new Error(`GitHub user "${username}" not found.`);
    }
    firstAccount ??= account;

    const connection = selectConnection(account);
    const nodes = (connection?.nodes ?? []).filter(Boolean);
    items.push(...nodes);

    if (shouldStop?.(nodes, account)) {
      break;
    }

    const pageInfo = connection?.pageInfo;
    if (
      !pageInfo?.hasNextPage ||
      !pageInfo.endCursor ||
      pageInfo.endCursor === after
    ) {
      break;
    }
    after = pageInfo.endCursor;
  }

  return { items, firstAccount };
}

/**
 * Fetch repositories touched across all contribution years via `contributionsCollection`.
 * This catches organization repos or private template forks that `User.repositories` may omit.
 */
async function fetchYearlyContributedRepos(
  username,
  years,
  token,
  useViewer,
) {
  const repos = [];
  for (let i = 0; i < years.length; i += 2) {
    const chunk = years.slice(i, i + 2);
    const query = buildYearlyContribReposQuery(chunk, useViewer);
    const variables = useViewer ? {} : { login: username };
    const data = await runGraphql(query, variables, token);
    const account = data?.account;
    if (!account) {
      continue;
    }
    for (let idx = 0; idx < chunk.length; idx++) {
      const yearBlock = account[`year_${idx}`];
      const lists = [
        ...(yearBlock?.commitContributionsByRepository ?? []),
        ...(yearBlock?.pullRequestContributionsByRepository ?? []),
      ];
      for (const entry of lists) {
        if (entry?.repository) {
          repos.push(entry.repository);
        }
      }
    }
  }
  return repos;
}

/**
 * Fetch repository stars, language sizes, followers, and contributed-to repositories for one account.
 */
async function fetchAccountExtras(username, token, isViewerToken) {
  const [
    { items: starRepos, firstAccount },
    { items: directLangRepos },
    { items: contributedRepos },
  ] = await Promise.all([
    paginateAccountConnection(
      buildStarReposQuery(isViewerToken),
      username,
      token,
      isViewerToken,
      (account) => account.repositories,
      {
        maxPages: 10,
        shouldStop: (nodes) =>
          nodes.some((repo) => (repo.stargazerCount ?? 0) === 0),
      },
    ),
    paginateAccountConnection(
      buildLangReposQuery(isViewerToken),
      username,
      token,
      isViewerToken,
      (account) => account.repositories,
      { maxPages: 10 },
    ),
    paginateAccountConnection(
      buildContributedReposQuery(isViewerToken),
      username,
      token,
      isViewerToken,
      (account) => account.repositoriesContributedTo,
      { maxPages: 5 },
    ),
  ]);

  const contributionYears =
    firstAccount?.contributionsCollection?.contributionYears ?? [];
  const yearlyRepos =
    contributionYears.length > 0
      ? await fetchYearlyContributedRepos(
          username,
          contributionYears,
          token,
          isViewerToken,
        )
      : [];

  // Combine direct non-fork repos with non-fork or private repos contributed to.
  const langReposByName = new Map();
  for (const repo of directLangRepos) {
    if (repo?.nameWithOwner) {
      langReposByName.set(repo.nameWithOwner, repo);
    }
  }
  for (const repo of [...contributedRepos, ...yearlyRepos]) {
    if (!repo?.nameWithOwner) {
      continue;
    }
    // Keep public forks excluded to match github-stats-extended behavior, while including private org repos.
    if (repo.isFork && !repo.isPrivate) {
      continue;
    }
    if (!langReposByName.has(repo.nameWithOwner)) {
      langReposByName.set(repo.nameWithOwner, repo);
    }
  }

  const allStarRepos = [...starRepos];
  for (const repo of [...contributedRepos, ...yearlyRepos]) {
    if (repo?.nameWithOwner && (repo.stargazerCount ?? 0) > 0) {
      allStarRepos.push(repo);
    }
  }

  const langRepos = [...langReposByName.values()];
  console.log(
    `Fetched extras for "${username}" (viewer=${isViewerToken}): starRepos=${starRepos.length}, directLangRepos=${directLangRepos.length}, totalLangRepos=${langRepos.length}, contributedRepos=${contributedRepos.length}`,
  );

  return {
    followers: firstAccount?.followers?.totalCount ?? 0,
    starRepos: allStarRepos,
    langRepos,
    contributedRepos,
  };
}

/**
 * Determine whether a repository should be excluded by short name or `owner/name`.
 */
function isExcludedRepo(repo, excludeSet) {
  if (repo.name && excludeSet.has(repo.name)) {
    return true;
  }
  if (repo.nameWithOwner && excludeSet.has(repo.nameWithOwner)) {
    return true;
  }
  return false;
}

/**
 * Merge statistics and language breakdowns across one or more GitHub accounts,
 * deduplicating shared repositories by `nameWithOwner`.
 *
 * @param {Array<{ username: string, stats: any, extras: { followers: number, starRepos: Array<any>, langRepos: Array<any>, contributedRepos: Array<any> } }>} accountResults
 * @param {Array<string>} excludeRepo Repositories to exclude from stars and top-langs.
 * @param {(params: any) => { level: string, percentile: number }} calculateRank
 */
export function mergeAccountMetrics(
  accountResults,
  excludeRepo,
  calculateRank,
) {
  if (accountResults.length === 0) {
    throw new Error("At least one GitHub account is required.");
  }

  const excludeSet = new Set(excludeRepo);
  const starReposByOwner = new Map();
  const langReposByOwner = new Map();
  const contributedReposSet = new Set();

  let totalCommits = 0;
  let totalPRs = 0;
  let totalIssues = 0;
  let totalReviews = 0;
  let followers = 0;

  for (const { stats, extras } of accountResults) {
    totalCommits += stats.totalCommits ?? 0;
    totalPRs += stats.totalPRs ?? 0;
    totalIssues += stats.totalIssues ?? 0;
    totalReviews += stats.totalReviews ?? 0;
    followers += extras.followers ?? 0;

    for (const repo of extras.starRepos ?? []) {
      if (!repo?.nameWithOwner || isExcludedRepo(repo, excludeSet)) {
        continue;
      }
      const prevStars = starReposByOwner.get(repo.nameWithOwner) ?? 0;
      starReposByOwner.set(
        repo.nameWithOwner,
        Math.max(prevStars, repo.stargazerCount ?? 0),
      );
    }

    for (const repo of extras.langRepos ?? []) {
      if (!repo?.nameWithOwner || isExcludedRepo(repo, excludeSet)) {
        continue;
      }
      if (!langReposByOwner.has(repo.nameWithOwner)) {
        langReposByOwner.set(
          repo.nameWithOwner,
          (repo.languages?.edges ?? []).filter(Boolean),
        );
      }
    }

    for (const repo of extras.contributedRepos ?? []) {
      if (repo?.nameWithOwner) {
        contributedReposSet.add(repo.nameWithOwner);
      }
    }
  }

  let totalStars = 0;
  for (const stars of starReposByOwner.values()) {
    totalStars += stars;
  }

  const languageMap = {};
  for (const edges of langReposByOwner.values()) {
    for (const edge of edges) {
      const langName = edge?.node?.name;
      if (!langName) {
        continue;
      }
      const existing = languageMap[langName];
      languageMap[langName] = existing
        ? {
            name: langName,
            color: edge.node.color,
            size: existing.size + edge.size,
            count: existing.count + 1,
          }
        : {
            name: langName,
            color: edge.node.color,
            size: edge.size,
            count: 1,
          };
    }
  }

  const topLangData = Object.fromEntries(
    Object.entries(languageMap).sort(([, a], [, b]) => b.size - a.size),
  );

  // Never drop below a single account's reported totalCount if GraphQL pagination hit maxPages.
  const contributedTo = Math.max(
    contributedReposSet.size,
    ...accountResults.map((a) => a.stats.contributedTo ?? 0),
  );

  const rank = calculateRank({
    all_commits: true,
    commits: totalCommits,
    prs: totalPRs,
    reviews: totalReviews,
    issues: totalIssues,
    repos: langReposByOwner.size,
    stars: totalStars,
    followers,
  });

  const statsData = {
    ...accountResults[0].stats,
    totalCommits,
    totalPRs,
    totalIssues,
    totalReviews,
    totalStars,
    contributedTo,
    rank,
  };

  return {
    statsData,
    topLangData,
    summary: {
      accounts: accountResults.map((a) => a.username),
      totalStars,
      totalCommits,
      totalPRs,
      totalIssues,
      totalReviews,
      contributedTo,
      uniqueReposCount: langReposByOwner.size,
      rank: rank.level,
      topLanguages: Object.keys(topLangData).slice(0, 8),
    },
  };
}

/**
 * Generate merged `stats.svg` and `top-langs.svg` files in `OUTPUT_DIR`.
 */
async function main() {
  const excludeRepo = parseCsv(process.env.EXCLUDE_REPO);
  const outputDir = process.env.OUTPUT_DIR?.trim() || "dist";

  const {
    calculateRank,
    renderStatsCard,
    renderTopLanguages,
    fetchStats,
    loadConfigFromEnv,
  } = await loadCoreModules();

  loadConfigFromEnv(process.env);
  const accounts = await resolveAccounts(process.env);

  const accountResults = [];
  for (const account of accounts) {
    const [stats, extras] = await Promise.all([
      fetchStats(
        account.username,
        true,
        excludeRepo,
        false,
        false,
        false,
        undefined,
        [],
        [],
        false,
        false,
        false,
        false,
        false,
        ROLE_AFFILIATIONS,
        false,
        false,
        true,
        account.token,
      ),
      fetchAccountExtras(account.username, account.token, account.isViewerToken),
    ]);
    accountResults.push({ username: account.username, stats, extras });
  }

  const { statsData, topLangData, summary } = mergeAccountMetrics(
    accountResults,
    excludeRepo,
    calculateRank,
  );

  const statsSvg = renderStatsCard(
    statsData,
    STATS_CARD_OPTIONS,
    accounts[0].username,
    [],
    [],
  );
  const topLangsSvg = renderTopLanguages(topLangData, TOP_LANGS_OPTIONS);

  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "stats.svg"), statsSvg, "utf8"),
    writeFile(path.join(outputDir, "top-langs.svg"), topLangsSvg, "utf8"),
  ]);

  console.log("Generated stats SVGs:", JSON.stringify(summary, null, 2));
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
