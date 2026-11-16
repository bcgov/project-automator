import { findExclusion } from './exclusions.js';

/**
 * Decide the sprint change for an item from `rules.yml` `sprints`.
 * @param {string|null} column - The item's column after column moves
 * @param {{id: string}|null} currentSprint - The item's sprint
 * @param {string|null} currentSprintId - The project's current iteration
 * @param {object} sprints - `sprints` from rules.yml
 * @param {Array<string>} sprints.assign_current - Columns that always get the current sprint
 * @param {Array<string>} sprints.assign_current_if_empty - Columns that get it only when unset
 * @returns {'assign'|null}
 */
export function sprintAction(column, currentSprint, currentSprintId, sprints) {
  if (!sprints?.assign_current || !sprints.assign_current_if_empty) {
    throw new Error('sprints from rules.yml is required');
  }
  if (!column || !currentSprintId) return null;
  if (sprints.assign_current.includes(column)) {
    return currentSprint?.id === currentSprintId ? null : 'assign';
  }
  if (sprints.assign_current_if_empty.includes(column)) {
    return currentSprint ? null : 'assign';
  }
  return null;
}

/**
 * Build a GitHub Projects v2 search query filtering items to the given Status column values.
 * @param {string} statusFieldName - Configured status field name (e.g. "Status")
 * @param {Array<string>} columns - Status column names
 * @returns {string|null} Query string, or null when columns is empty
 */
export function buildBoardSprintQuery(statusFieldName, columns) {
  if (!Array.isArray(columns) || columns.length === 0) return null;
  const field = String(statusFieldName || 'Status').trim();
  const qualifier = field.toLowerCase() === 'status' ? 'status' : `field.${JSON.stringify(field)}`;
  const values = columns.map((col) => JSON.stringify(String(col))).join(',');
  return `${qualifier}:${values}`;
}

/**
 * Reconcile sprints for existing board items in `sprints.assign_current` columns.
 * @param {object} options
 * @param {Array<object>} options.items - Board items from `getBoardItemsInColumns`
 * @param {string|null} options.currentSprintId
 * @param {string|null} options.currentSprintTitle
 * @param {object} options.sprints - `sprints` from rules.yml
 * @param {object} [options.exclusions] - `exclusions` from rules.yml
 * @param {Array<string>} [options.monitoredUsers]
 * @param {Set<string>} [options.skipIds] - Project item IDs already updated earlier in this run
 * @param {(projectItemId: string) => Promise<void>} options.updateSprint
 * @param {{info: Function, error: Function}} [options.log]
 * @returns {Promise<Array<object>>} Summary rows for items updated or failed during the sweep
 */
export async function reconcileBoardSprints({
  items,
  currentSprintId,
  currentSprintTitle,
  sprints,
  exclusions,
  monitoredUsers = [],
  skipIds,
  updateSprint,
  log,
}) {
  if (!currentSprintId || !sprints?.assign_current?.length) return [];
  const report = [];
  for (const item of items || []) {
    if (item.isArchived || skipIds?.has(item.projectItemId)) continue;
    if (sprintAction(item.column, item.sprint, currentSprintId, sprints) !== 'assign') continue;

    const label =
      item.repo && item.number != null
        ? `${item.type} ${item.repo}#${item.number}`
        : `${item.type || 'Item'} "${item.title || item.projectItemId}"`;
    try {
      if (exclusions) {
        const exclusionReason = findExclusion(item, exclusions, monitoredUsers);
        if (exclusionReason) {
          log?.info(`Skipping board sprint sweep for ${label}: ${exclusionReason}`);
          continue;
        }
      }
      log?.info(
        `Board sprint sweep: assigning "${currentSprintTitle || currentSprintId}" to ${label} (column "${item.column}")...`
      );
      await updateSprint(item.projectItemId);
      report.push({
        type: item.type || 'Item',
        number: item.number ?? item.projectItemId,
        repo: item.repo || 'board',
        title: item.title || item.projectItemId,
        status: 'Success',
        action: `Sprint set to "${currentSprintTitle || currentSprintId}" (column "${item.column}")`,
      });
    } catch (err) {
      log?.error(`Board sprint sweep failed for ${label}: ${err.message}`);
      report.push({
        type: item.type || 'Item',
        number: item.number ?? item.projectItemId,
        repo: item.repo || 'board',
        title: item.title || item.projectItemId,
        status: 'Failed',
        action: err.message,
      });
    }
  }
  return report;
}
