/**
 * Checks if an item should be excluded based on its title.
 * @param {string | null | undefined} title - The title of the issue or pull request
 * @param {object} exclusionsConfig - `exclusions` from rules.yml (required by the schema)
 * @returns {boolean} True if the item should be excluded, false otherwise
 */
export function isTitleExcluded(title, exclusionsConfig) {
  if (!exclusionsConfig) {
    throw new Error('exclusions from rules.yml is required');
  }
  if (typeof title !== 'string') {
    return false;
  }
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) {
    return false;
  }

  const exactTitles = exclusionsConfig.exact_titles || [];
  const titleSubstrings = exclusionsConfig.title_substrings || [];
  const titlePrefixes = exclusionsConfig.title_prefixes || [];

  const exactSet = new Set(exactTitles);

  if (exactSet.has(trimmedTitle)) {
    return true;
  }
  if (titlePrefixes.some((prefix) => trimmedTitle.startsWith(prefix))) {
    return true;
  }
  return titleSubstrings.some((substring) => trimmedTitle.includes(substring));
}

/**
 * Checks if an item should be excluded based on its labels.
 * GitHub label names are unique per repository regardless of case, so matching ignores case.
 * @param {Array<string>} labels - Label names on the issue or pull request
 * @param {object} exclusionsConfig - `exclusions` from rules.yml (required by the schema)
 * @returns {string | null} The first matching excluded label, or null when none match
 */
export function findExcludedLabel(labels, exclusionsConfig) {
  if (!exclusionsConfig || !Array.isArray(exclusionsConfig.exclude_labels)) {
    throw new Error('exclusions.exclude_labels from rules.yml is required');
  }
  const excluded = new Set(exclusionsConfig.exclude_labels.map((name) => name.toLowerCase()));
  return labels.find((name) => excluded.has(name.toLowerCase())) || null;
}

// Up to 100 labels per item, the GraphQL page limit; labelNames fails on more
export const LABELS_FRAGMENT = 'labels(first: 100) { totalCount nodes { name } }';

/**
 * Label names from a GraphQL `labels` connection, fetched with LABELS_FRAGMENT.
 * Fails when the item has more labels than were fetched, since an excluded label could be missed.
 * @param {{ totalCount: number, nodes: Array<{ name: string }> }} labels
 * @returns {Array<string>}
 */
export function labelNames(labels) {
  if (!labels || !Array.isArray(labels.nodes)) {
    throw new Error('Labels were not fetched for this item');
  }
  if (labels.totalCount > labels.nodes.length) {
    throw new Error(
      `Item has ${labels.totalCount} labels but only ${labels.nodes.length} were fetched; label exclusions can't be checked`
    );
  }
  return labels.nodes.map((label) => label.name);
}

/**
 * GitHub login of a GraphQL author: a Bot's login comes back without the "[bot]" suffix.
 * @param {{ __typename?: string, login?: string } | null | undefined} author
 * @returns {string | null}
 */
export function authorLogin(author) {
  if (!author?.login) return null;
  return author.__typename === 'Bot' ? `${author.login}[bot]` : author.login;
}

/**
 * Checks if an item is excluded by its author (`exclusions.authors`, case-insensitive).
 * With `exclusions.unless_review_requested`, a PR that requests review from a monitored
 * user is still added.
 * @param {{ author: string | null, isReviewRequested: boolean }} item
 * @param {object} exclusionsConfig - `exclusions` from rules.yml
 * @returns {string | null} The excluded author login, or null when the item isn't excluded
 */
export function findExcludedAuthor({ author, isReviewRequested }, exclusionsConfig) {
  if (
    !exclusionsConfig ||
    !Array.isArray(exclusionsConfig.authors) ||
    typeof exclusionsConfig.unless_review_requested !== 'boolean'
  ) {
    throw new Error('exclusions.authors and exclusions.unless_review_requested are required');
  }
  if (!author) return null;
  const excluded = new Set(exclusionsConfig.authors.map((name) => name.toLowerCase()));
  if (!excluded.has(author.toLowerCase())) return null;
  if (exclusionsConfig.unless_review_requested && isReviewRequested) return null;
  return author;
}

/**
 * Checks whether any monitored user is a requested reviewer on a PullRequest.
 * @param {object} item - Issue or PullRequest with `__typename` (or `type`) and `reviewRequests`
 * @param {Array<string>} monitoredUsers
 * @returns {boolean}
 */
export function isReviewRequestedBy(item, monitoredUsers = []) {
  return (
    (item?.__typename || item?.type) === 'PullRequest' &&
    (item?.reviewRequests?.nodes || []).some((req) =>
      monitoredUsers.includes(req.requestedReviewer?.login)
    )
  );
}

/**
 * Evaluate title, label, and author exclusions uniformly for an item.
 * Draft issues only have titles; issues and PRs also check labels and authors.
 * @param {object} item
 * @param {object} exclusionsConfig - `exclusions` from rules.yml
 * @param {Array<string>} [monitoredUsers]
 * @returns {string | null} Human-readable exclusion reason, or null when not excluded
 */
export function findExclusion(item, exclusionsConfig, monitoredUsers = []) {
  if (isTitleExcluded(item?.title, exclusionsConfig)) {
    return `Automated item excluded based on title ("${item.title}").`;
  }
  const kind = item?.__typename || item?.type;
  if (!kind || kind === 'DraftIssue') return null;

  const excludedLabel = findExcludedLabel(
    Array.isArray(item.labels) ? item.labels : labelNames(item.labels),
    exclusionsConfig
  );
  if (excludedLabel) {
    return `Item excluded based on label ("${excludedLabel}").`;
  }

  const author = typeof item.author === 'string' ? item.author : authorLogin(item.author);
  const excludedAuthor = findExcludedAuthor(
    {
      author,
      isReviewRequested: item.isReviewRequested ?? isReviewRequestedBy(item, monitoredUsers),
    },
    exclusionsConfig
  );
  if (excludedAuthor) {
    return `Item excluded based on author ("${excludedAuthor}").`;
  }
  return null;
}
