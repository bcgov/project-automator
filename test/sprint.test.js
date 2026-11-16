import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { loadBoardRules } from '../src/config/board-rules.js';
import { buildBoardSprintQuery, reconcileBoardSprints, sprintAction } from '../src/utils/sprint.js';

const { sprints } = loadBoardRules();

test('a Done item synced after a rollover keeps its old sprint', () => {
  assert.strictEqual(sprintAction('Done', { id: 'sprint-90' }, 'sprint-91', sprints), null);
});

test('a Done item with no sprint gets the current one', () => {
  assert.strictEqual(sprintAction('Done', null, 'sprint-91', sprints), 'assign');
});

test('Active, Next, and Waiting move to the current sprint after a rollover', () => {
  for (const col of ['Active', 'Next', 'Waiting']) {
    assert.strictEqual(sprintAction(col, { id: 'sprint-90' }, 'sprint-91', sprints), 'assign', col);
    assert.strictEqual(sprintAction(col, null, 'sprint-91', sprints), 'assign', col);
    assert.strictEqual(sprintAction(col, { id: 'sprint-91' }, 'sprint-91', sprints), null, col);
  }
});

test('New, Parked, and Backlog do not get assigned a sprint', () => {
  for (const col of ['New', 'Parked', 'Backlog']) {
    assert.strictEqual(sprintAction(col, null, 'sprint-91', sprints), null, col);
    assert.strictEqual(sprintAction(col, { id: 'sprint-90' }, 'sprint-91', sprints), null, col);
  }
});

test('buildBoardSprintQuery builds quoted server-side status queries', () => {
  assert.strictEqual(
    buildBoardSprintQuery('Status', sprints.assign_current),
    'status:"Active","Next","Waiting"'
  );
  assert.strictEqual(
    buildBoardSprintQuery('Board Status', ['In Progress', 'Ready']),
    'field."Board Status":"In Progress","Ready"'
  );
  assert.strictEqual(buildBoardSprintQuery('Status', []), null);
});

test('reconcileBoardSprints updates stale/unset items and skips current, archived, and already-updated items', async () => {
  const updated = [];
  const logs = [];
  const items = [
    {
      projectItemId: 'item-stale-active',
      column: 'Active',
      sprint: { id: 'sprint-91', title: 'Sprint 91' },
      isArchived: false,
      type: 'PullRequest',
      number: 10,
      repo: 'bcgov/actions',
      title: 'Stale PR',
    },
    {
      projectItemId: 'item-empty-next',
      column: 'Next',
      sprint: null,
      isArchived: false,
      type: 'Issue',
      number: 20,
      repo: 'bcgov/actions',
      title: 'Unset Next issue',
    },
    {
      projectItemId: 'item-waiting-draft',
      column: 'Waiting',
      sprint: { id: 'sprint-91', title: 'Sprint 91' },
      isArchived: false,
      type: 'DraftIssue',
      number: null,
      repo: null,
      title: 'Draft card',
    },
    {
      projectItemId: 'item-already-current',
      column: 'Active',
      sprint: { id: 'sprint-92', title: 'Sprint 92' },
      isArchived: false,
      type: 'PullRequest',
      number: 30,
      repo: 'bcgov/actions',
      title: 'Already current',
    },
    {
      projectItemId: 'item-archived',
      column: 'Active',
      sprint: { id: 'sprint-91', title: 'Sprint 91' },
      isArchived: true,
      type: 'Issue',
      number: 40,
      repo: 'bcgov/actions',
      title: 'Archived',
    },
    {
      projectItemId: 'item-updated-earlier',
      column: 'Active',
      sprint: { id: 'sprint-91', title: 'Sprint 91' },
      isArchived: false,
      type: 'Issue',
      number: 50,
      repo: 'bcgov/actions',
      title: 'Updated in recentItems',
    },
  ];

  const report = await reconcileBoardSprints({
    items,
    currentSprintId: 'sprint-92',
    currentSprintTitle: 'Sprint 92',
    sprints,
    skipIds: new Set(['item-updated-earlier']),
    updateSprint: async (id) => {
      updated.push(id);
    },
    log: { info: (m) => logs.push(m), error: () => {} },
  });

  assert.deepStrictEqual(updated, ['item-stale-active', 'item-empty-next', 'item-waiting-draft']);
  assert.strictEqual(report.length, 3);
  assert.ok(report.every((r) => r.status === 'Success'));
  assert.strictEqual(report[2].repo, 'board');
  assert.strictEqual(report[2].number, 'item-waiting-draft');
  assert.strictEqual(logs.length, 3);
});

test('reconcileBoardSprints records per-item failures without aborting remaining items', async () => {
  const errors = [];
  const updated = [];
  const report = await reconcileBoardSprints({
    items: [
      {
        projectItemId: 'item-fail',
        column: 'Active',
        sprint: null,
        isArchived: false,
        type: 'Issue',
        number: 1,
        repo: 'bcgov/actions',
        title: 'Broken',
      },
      {
        projectItemId: 'item-ok',
        column: 'Next',
        sprint: null,
        isArchived: false,
        type: 'Issue',
        number: 2,
        repo: 'bcgov/actions',
        title: 'Healthy',
      },
    ],
    currentSprintId: 'sprint-92',
    currentSprintTitle: 'Sprint 92',
    sprints,
    updateSprint: async (id) => {
      if (id === 'item-fail') throw new Error('mutation rejected');
      updated.push(id);
    },
    log: { info: () => {}, error: (m) => errors.push(m) },
  });

  assert.deepStrictEqual(updated, ['item-ok']);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /mutation rejected/);
  assert.deepStrictEqual(
    report.map((r) => r.status),
    ['Failed', 'Success']
  );
});

test('normal runs reconcile board sprints only when not backfilling', () => {
  const index = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(
    index,
    /!backfill[\s\S]*getBoardItemsInColumns\(projectId, config\.sprints\.assign_current\)/
  );
});
