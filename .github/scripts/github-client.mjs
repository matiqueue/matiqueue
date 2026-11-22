const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500, 3000];

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
export async function githubFetchJson(url, token, init = {}) {
  let lastError;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "matiqueue-profile-automation",
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
 * Execute a GitHub GraphQL query.
 *
 * @param {string} query GraphQL query text.
 * @param {Record<string, unknown>} variables Query variables.
 * @param {string} token GitHub token.
 * @returns {Promise<any>} GraphQL `data` payload.
 */
export async function runGraphql(query, variables, token) {
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
 * Check whether a token belongs to `expectedUsername` (returns false for integration/bot tokens).
 *
 * @param {string} expectedUsername Expected GitHub login.
 * @param {string} token GitHub token.
 * @returns {Promise<boolean>} True if `viewer.login` matches `expectedUsername`.
 */
export async function isTokenForUser(expectedUsername, token) {
  try {
    const data = await runGraphql("query { viewer { login } }", {}, token);
    const viewerLogin = data?.viewer?.login;
    return (
      typeof viewerLogin === "string" &&
      viewerLogin.toLowerCase() === expectedUsername.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Resolve primary and optional work GitHub accounts from workflow environment variables.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment map.
 * @returns {Promise<Array<{ username: string, token: string, isViewerToken: boolean }>>}
 */
export async function resolveAccounts(env = process.env) {
  const primaryUsername =
    env.PRIMARY_USERNAME?.trim() || env.GITHUB_REPOSITORY_OWNER?.trim();
  const primaryToken = env.PRIMARY_TOKEN?.trim();
  const workToken = env.WORK_STATS_TOKEN?.trim();
  const workUsernameOverride = env.WORK_USERNAME?.trim();

  if (!primaryUsername || !primaryToken) {
    throw new Error("PRIMARY_USERNAME and PRIMARY_TOKEN are required.");
  }

  const primaryIsViewer = await isTokenForUser(primaryUsername, primaryToken);
  const accounts = [
    {
      username: primaryUsername,
      token: primaryToken,
      isViewerToken: primaryIsViewer,
    },
  ];

  if (workToken) {
    const authUser = await resolveAuthenticatedUser(workToken);
    const workUsername = workUsernameOverride || authUser.login;
    if (workUsername.toLowerCase() !== primaryUsername.toLowerCase()) {
      accounts.push({
        username: workUsername,
        token: workToken,
        isViewerToken:
          authUser.login.toLowerCase() === workUsername.toLowerCase(),
      });
    } else {
      console.log(
        `WORK_STATS_TOKEN resolved to primary account "${primaryUsername}"; skipping duplicate fetch.`,
      );
    }
  }

  return accounts;
}
