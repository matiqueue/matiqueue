import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROLE_AFFILIATIONS = ["OWNER", "ORGANIZATION_MEMBER", "COLLABORATOR"];
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500, 3000];

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

const STAR_REPOS_QUERY = `
query userStarRepos($login: String!, $after: String) {
  user(login: $login) {
    followers {
      totalCount
    }
    repositories(
      first: 100
      after: $after
      ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]
      orderBy: { direction: DESC, field: STARGAZERS }
    ) {
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

const LANG_REPOS_QUERY = `
query userLangRepos($login: String!, $after: String) {
  user(login: $login) {
    repositories(
      first: 100
      after: $after
      isFork: false
      ownerAffiliations: [OWNER, ORGANIZATION_MEMBER, COLLABORATOR]
    ) {
      nodes {
        name
        nameWithOwner
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges {
            size
            node {
              color
              name
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`;

const CONTRIBUTED_REPOS_QUERY = `
query userContributedRepos($login: String!, $after: String) {
  user(login: $login) {
    repositoriesContributedTo(
      first: 100
      after: $after
      contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
      includeUserRepositories: true
    ) {
      nodes {
        nameWithOwner
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
`;

/**
 * Parse a comma-separated environment value into trimmed non-empty entries.
 *
 * @param {string | undefined} value Raw comma-separated string.
 * @returns {Array<string>} Parsed list of values.
 */
export function parseCsv(value) {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Resolve the build directory of `@stats-organization/github-readme-stats-core`.
 *
 * @param {string | undefined} explicitBuildDir Optional explicit path override.
 * @returns {string} Absolute path to the core package's `build` directory.
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
 * Sleep for `ms` milliseconds.
 *
 * @param {number} ms Delay in milliseconds.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform a GitHub API JSON request with retries for transient gateway/network failures.
 *
 * @param {string} url Target API URL.
 * @param {string} token GitHub token.
 * @param {RequestInit} [init] Optional fetch init overrides.
 * @returns {Promise<{ data: any, headers: Headers }>} Parsed JSON body and headers.
 */
async function githubFetchJson(url, token, init = {}) {
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "matiqueue-profile-stats",
          ...init.headers,
        },
      });

      if (
        TRANSIENT_STATUSES.has(response.status) &&
        attempt < RETRY_DELAYS_MS.length
      ) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      const data = await response.json();
      if (!response.ok) {
        const message = data?.message || `HTTP ${response.status}`;
        throw new Error(`GitHub API error (${response.status}): ${message}`);
      }

      return { data, headers: response.headers };
    } catch (err) {
      lastError = err;
      const isNetworkError = err instanceof TypeError;
      if (isNetworkError && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

/**
 * Resolve the GitHub login belonging to a Personal Access Token.
 *
 * @param {string} token GitHub PAT.
 * @returns {Promise<{ login: string, scopes: Array<string> }>} Authenticated user login and OAuth scopes.
 */
export async function resolveAuthenticatedUser(token) {
  const { data, headers } = await githubFetchJson(
    "https://api.github.com/user",
    token,
  );
  if (!data?.login) {
    throw new Error(
      "Could not resolve GitHub username from WORK_STATS_TOKEN.",
    );
  }
  const rawScopes = headers.get("x-oauth-scopes");
  const scopes = rawScopes ? parseCsv(rawScopes) : [];
  if (rawScopes !== null && !scopes.includes("repo")) {
    console.warn(
      `Warning: token for "${data.login}" does not list the "repo" scope; private repositories may be omitted.`,
    );
  }
  return { login: data.login, scopes };
}

/**
 * Execute a GitHub GraphQL query.
 *
 * @param {string} query GraphQL query text.
 * @param {Record<string, unknown>} variables Query variables.
 * @param {string} token GitHub token.
 * @returns {Promise<any>} GraphQL `data` payload.
 */
async function runGraphql(query, variables, token) {
  const { data } = await githubFetchJson(
    "https://api.github.com/graphql",
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    const firstMsg = data.errors[0]?.message || "Unknown GraphQL error";
    throw new Error(`GitHub GraphQL error: ${firstMsg}`);
  }

  return data?.data;
}

/**
 * Paginate a GraphQL user connection up to `maxPages`.
 *
 * @param {string} query GraphQL query string accepting `$login` and `$after`.
 * @param {string} username GitHub username.
 * @param {string} token GitHub token.
 * @param {(user: any) => { nodes?: Array<any>, pageInfo?: { hasNextPage: boolean, endCursor: string | null } } | undefined} selectConnection
 * @param {object} [options]
 * @param {number} [options.maxPages] Maximum number of pages to fetch.
 * @param {(pageNodes: Array<any>, user: any) => boolean} [options.shouldStop] Optional early-stop predicate.
 * @returns {Promise<{ items: Array<any>, firstUser: any }>}
 */
async function paginateGraphql(
  query,
  username,
  token,
  selectConnection,
  { maxPages = 10, shouldStop } = {},
) {
  const items = [];
  let after = null;
  let firstUser = null;

  for (let page = 0; page < maxPages; page++) {
    const data = await runGraphql(query, { login: username, after }, token);
    const user = data?.user;
    if (!user) {
      throw new Error(`GitHub user "${username}" not found.`);
    }
    firstUser ??= user;

    const connection = selectConnection(user);
    const nodes = (connection?.nodes ?? []).filter(Boolean);
    items.push(...nodes);

    if (shouldStop?.(nodes, user)) {
      break;
    }

    const pageInfo = connection?.pageInfo;
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor || pageInfo.endCursor === after) {
      break;
    }
    after = pageInfo.endCursor;
  }

  return { items, firstUser };
}

/**
 * Fetch repository stars, language sizes, followers, and contributed-to repositories for one account.
 *
 * @param {string} username GitHub username.
 * @param {string} token GitHub token.
 */
async function fetchAccountExtras(username, token) {
  const [{ items: starRepos, firstUser }, { items: langRepos }, { items: contributedRepos }] =
    await Promise.all([
      paginateGraphql(
        STAR_REPOS_QUERY,
        username,
        token,
        (user) => user.repositories,
        {
          maxPages: 10,
          shouldStop: (nodes) =>
            nodes.some((repo) => (repo.stargazerCount ?? 0) === 0),
        },
      ),
      paginateGraphql(
        LANG_REPOS_QUERY,
        username,
        token,
        (user) => user.repositories,
        { maxPages: 5 },
      ),
      paginateGraphql(
        CONTRIBUTED_REPOS_QUERY,
        username,
        token,
        (user) => user.repositoriesContributedTo,
        { maxPages: 5 },
      ),
    ]);

  return {
    followers: firstUser?.followers?.totalCount ?? 0,
    starRepos,
    langRepos,
    contributedRepos,
  };
}

/**
 * Determine whether a repository should be excluded by short name or `owner/name`.
 *
 * @param {{ name?: string, nameWithOwner?: string }} repo Repository node.
 * @param {Set<string>} excludeSet Excluded repository identifiers.
 * @returns {boolean} True when excluded.
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
  const primaryUsername =
    process.env.PRIMARY_USERNAME?.trim() ||
    process.env.GITHUB_REPOSITORY_OWNER?.trim();
  const primaryToken = process.env.PRIMARY_TOKEN?.trim();
  const workToken = process.env.WORK_STATS_TOKEN?.trim();
  const workUsernameOverride = process.env.WORK_USERNAME?.trim();
  const excludeRepo = parseCsv(process.env.EXCLUDE_REPO);
  const outputDir = process.env.OUTPUT_DIR?.trim() || "dist";

  if (!primaryUsername || !primaryToken) {
    throw new Error("PRIMARY_USERNAME and PRIMARY_TOKEN are required.");
  }

  const {
    calculateRank,
    renderStatsCard,
    renderTopLanguages,
    fetchStats,
    loadConfigFromEnv,
  } = await loadCoreModules();

  loadConfigFromEnv(process.env);

  const accounts = [{ username: primaryUsername, token: primaryToken }];

  if (workToken) {
    const resolvedWorkLogin =
      workUsernameOverride || (await resolveAuthenticatedUser(workToken)).login;
    if (resolvedWorkLogin.toLowerCase() !== primaryUsername.toLowerCase()) {
      accounts.push({ username: resolvedWorkLogin, token: workToken });
    } else {
      console.log(
        `WORK_STATS_TOKEN resolved to primary account "${primaryUsername}"; skipping duplicate fetch.`,
      );
    }
  }

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
      fetchAccountExtras(account.username, account.token),
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
    primaryUsername,
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
