// Run with: node --test tests/test_latest_scores.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.split('// BEGIN latest-score-data')[1].split('// END latest-score-data')[0];
const context = vm.createContext({});
vm.runInContext(source, context);
const cols = ['Match ID', 'Date', 'Team 1', 'Team 2', 'Team 1 Score', 'Team 2 Score', 'OT', 'Stitched Match IDs', 'Team 1 Result', 'Team 2 Result', 'Pushed Timestamp'];
const row = (id, date, a = '3', b = '1', extra = []) => [id, date, 'DET', 'BUF', a, b, ...extra];
const select = (regular, playoffs = []) => JSON.parse(JSON.stringify(context.latestScoreNight([
  { phase: 'regular', data: { cols, rows: regular } }, { phase: 'playoffs', data: { cols, rows: playoffs } },
])));

test('Monday persists on off days and switches to Tuesday only when results arrive', () => {
  const monday = row('m', '2026-10-19 21:40');
  assert.equal(select([monday]).date, '2026-10-19');
  assert.equal(select([monday, row('t', '2026-10-20 21:40', '', '')]).date, '2026-10-19');
  const tuesday = row('t', '2026-10-20 21:40');
  assert.deepEqual(select([tuesday, monday]).games.map(g => g.id), ['t']);
  assert.deepEqual(select([monday, tuesday, row('m2', '2026-10-26 21:40')]).games.map(g => g.id), ['m2']);
});
test('all games from the latest night join the bar, even when rows arrive out of order', () => {
  const result = select([row('b', '2026-10-20 22:00'), row('old', '2026-10-19'), row('a', '2026-10-20 21:00')]);
  assert.deepEqual(result.games.map(g => g.id), ['a', 'b']);
});
test('upload timestamps and viewer timezone do not change the game night', () => {
  const old = row('old', '2026-10-19 23:59', '1', '0', ['', '', 'Win', 'Loss', '2026-10-25']);
  assert.equal(select([row('new', '2026-10-20 21:40'), old]).games[0].id, 'new');
  assert.equal(context.scoreNightDate('2026-10-19T23:59:00-04:00'), '2026-10-19');
});
test('future blank, tied, malformed and missing-team rows cannot replace finals', () => {
  const badTeam = row('no-team', '2026-10-27'); badTeam[2] = '';
  const result = select([row('valid', '2026-10-20'), row('blank', '2026-10-21', '', ''),
    row('zero', '2026-10-22', '0', '0'), row('bad', '2026-10-23', '#N/A', '1'),
    row('invalid-date', '2026-02-30'), badTeam]);
  assert.deepEqual(result.games.map(g => g.id), ['valid']);
});
test('shutouts, overtime and forfeits retain their scores and labels', () => {
  const result = select([row('ot', '2026-10-20', '1', '0', ['yes']),
    row('ff', '2026-10-20', '', '', ['', 'FORFEIT', 'Loss', 'Win'])]);
  assert.equal(result.games.find(g => g.id === 'ot').overtime, true);
  assert.equal(result.games.find(g => g.id === 'ot').score2, 0);
  assert.equal(result.games.find(g => g.id === 'ff').score2, 1);
  assert.equal(result.games.find(g => g.id === 'ff').forfeit, true);
});
test('regular and playoff finals share one latest-night selection', () => {
  assert.equal(select([row('r', '2026-10-19')], [row('p', '2026-10-20')]).games[0].phase, 'playoffs');
  assert.equal(select([row('r', '2026-10-20')], [row('p', '2026-10-20')]).games.length, 2);
});
test('duplicate and compound match IDs do not duplicate cards', () => {
  const game = row('123+456', '2026-10-20');
  assert.equal(select([game, game]).games.length, 1);
  assert.equal(select([game], [game]).games.length, 1);
  assert.equal(select([game], [game]).games[0].phase, 'regular');
});
test('empty seasons and missing optional playoff tab have no games', () => {
  assert.deepEqual(select([]), { date: '', games: [] });
});
test('dates are validated and normalized across month and year boundaries', () => {
  assert.equal(context.scoreNightDate('1/2/2027 21:00'), '2027-01-02');
  assert.equal(context.scoreNightDate('2026-13-01'), '');
  assert.equal(select([row('a', '2026-12-31'), row('b', '1/2/2027')]).date, '2027-01-02');
});
test('all inline scripts remain valid JavaScript', () => {
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

const loaderSource = html.slice(html.indexOf('  async function readLog('), html.indexOf('  async function refresh()'));
const refreshSource = html.slice(html.indexOf('  async function refresh()'), html.indexOf('  function animate(time)'));
test('missing playoff tab may return another worksheet with HTTP 200', async () => {
  const loader = vm.createContext({ AbortController, setTimeout, clearTimeout,
    publishedLogTab: tab => 'Published ' + tab,
    parseCSV: () => [['Setting', 'Value'], ['Regular Season Start', '2026-10-19']],
    fetch: async () => ({ ok: true, text: async () => '' }) });
  vm.runInContext(loaderSource, loader);
  const result = await loader.readLog('league', 'Playoff Game Log', true);
  assert.equal(result.rows.length, 0);
  await assert.rejects(loader.readLog('league', 'Game Log'), /columns/);
});
test('a failed refresh preserves the last successful bar', async () => {
  const state = vm.createContext({ busy: false, document: { hidden: false }, bar: { hidden: false },
    displayedSheet: 'league', signature: 'previous scores', sourceSheetIdForSelectedSeason: () => 'league',
    readLog: async () => { throw new Error('temporary outage'); }, console: { warn() {} },
    render: () => assert.fail('must not replace existing scores during an outage') });
  vm.runInContext(refreshSource, state);
  await state.refresh();
  assert.equal(state.signature, 'previous scores');
  assert.equal(state.bar.hidden, false);
  assert.equal(state.busy, false);
});

test('score loader requests cleared feeds and rejects a raw-log fallback', async () => {
  let requested;
  const loader = vm.createContext({ AbortController, setTimeout, clearTimeout,
    publishedLogTab: tab => 'Published ' + tab,
    parseCSV: () => [cols, row('unchecked', '2026-10-25')],
    fetch: async url => { requested = url; return { ok: true, text: async () => '' }; } });
  vm.runInContext(loaderSource, loader);
  await assert.rejects(loader.readLog('league', 'Game Log'), /columns/);
  assert.match(requested, /sheet=Published%20Game%20Log/);
});
test('a refresh replaces old scores when the next game night arrives', async () => {
  let displayed;
  const state = vm.createContext({ busy: false, document: { hidden: false }, bar: { hidden: false },
    displayedSheet: 'league', signature: 'Monday', sourceSheetIdForSelectedSeason: () => 'league',
    readLog: async (sheet, tab) => ({ cols, rows: tab === 'Game Log' ? [row('tuesday', '2026-10-20')] : [] }),
    latestScoreNight: context.latestScoreNight, console, render: night => { displayed = night; } });
  vm.runInContext(refreshSource, state);
  await state.refresh();
  assert.equal(displayed.date, '2026-10-20');
  assert.equal(displayed.games[0].id, 'tuesday');
});

const plain = value => JSON.parse(JSON.stringify(value));
const normalize = team => ({ 'Detroit Red Wings': 'DET', 'Buffalo Sabres': 'BUF' }[team] || team).toUpperCase();
test('matchup history includes older nights, normalizes teams and isolates playoffs', () => {
  const older = row('old', '2026-10-19', '1', '2', ['yes']); older[2] = 'Detroit Red Wings';
  const games = context.scoreGames([{ phase: 'regular', data: { cols, rows: [older, row('new', '2026-10-20')] } },
    { phase: 'playoffs', data: { cols, rows: [row('playoff', '2026-10-21')] } }]);
  const history = context.scoreMatchupHistory(games[1], games, normalize);
  assert.equal(history.meetings.length, 2);
  assert.equal(history.wins1, 1);
  assert.equal(history.wins2, 1);
  assert.deepEqual(plain(history.form1.map(g => g.result)), ['W', 'OTL']);
  assert.deepEqual(plain(history.form2.map(g => g.result)), ['L', 'W']);
});
test('recent form is limited to five newest games against any opponent', () => {
  const games = context.scoreGames([{ phase: 'regular', data: { cols,
    rows: Array.from({length: 7}, (_, i) => row(String(i), `2026-10-${10 + i}`)) } }]);
  const history = context.scoreMatchupHistory(games[6], games, normalize);
  assert.equal(history.form1.length, 5);
  assert.equal(history.form1[0].date, '2026-10-16');
});
test('standings support division headings, tied ranks, zero games and missing records', () => {
  const data = { cols: ['East', '', '', '', '', ''], rows: [
    ['TEAM', 'GP', 'W', 'L', 'OTL', 'PTS'], ['DET', '3', '2', '1', '0', '4'],
    ['West'], ['BUF', '3', '2', '0', '1', '5'], ['ANA', '3', '2', '1', '0', '4'], ['PIT', '0', '0', '0', '0', '0']] };
  assert.deepEqual(plain(context.scoreMatchupStanding(data, 'Detroit Red Wings', normalize)), { gp: 3, wins: 2, losses: 1, otl: 0, points: 4, rank: 2 });
  assert.equal(context.scoreMatchupStanding(data, 'ANA', normalize).rank, 2);
  assert.equal(context.scoreMatchupStanding(data, 'PIT', normalize).gp, 0);
  assert.equal(context.scoreMatchupStanding(data, 'VAN', normalize), null);
});
test('leaders select three skaters by points and one goalie by appearances', () => {
  const data = { cols: ['Username', 'Team', 'GP', 'Position', 'G', 'A', 'PTS'], rows: [
    ['A', 'DET', '3', 'C', '2', '4', '6'], ['B', 'DET', '3', 'LW', '4', '4', '8'],
    ['C', 'Detroit Red Wings', '3', 'D', '1', '8', '9'], ['D', 'DET', '3', 'RW', '0', '1', '1'],
    ['No games', 'DET', '0', 'C', '99', '0', '99'], ['Other team', 'BUF', '3', 'C', '99', '0', '99']] };
  assert.deepEqual(plain(context.scoreMatchupLeaders(data, 'DET', normalize).map(p => p.name)), ['C', 'B', 'A']);
  const goalies = { cols: ['Username', 'Team', 'GP', 'Saves', 'Save %', 'GAA'], rows: [
    ['Backup', 'DET', '1', '20', '.95', '1'], ['Starter', 'DET', '4', '70', '87.5%', '2.5']] };
  const keeper = context.scoreMatchupLeaders(goalies, 'DET', normalize, true)[0];
  assert.equal(keeper.name, 'Starter');
  assert.equal(keeper.save, '87.5%');
  assert.equal(context.scoreMatchupLeaders(null, 'DET', normalize).length, 0);
});
test('box scores match exact IDs and stitched components without admitting other games', () => {
  const data = { cols: ['Match ID', 'Username'], rows: [['123', 'a'], ['456', 'b'], ['123+456', 'c'], ['1234', 'wrong'], ['', 'empty']] };
  assert.deepEqual(plain(context.scoreMatchupBoxRows(data, '123+456').map(r => r[1])), ['a', 'b', 'c']);
  assert.equal(context.scoreMatchupBoxRows(data, '').length, 0);
  assert.equal(context.scoreMatchupBoxRows(data, '2026-10-20|DET|BUF').length, 0);
  assert.equal(context.scoreMatchupBoxRows({ cols: ['Other tab'], rows: [['123']] }, '123').length, 0);
});

test('each box-score tab contains only its team and game, including team-name aliases', () => {
  const data = { cols: ['Match ID', 'Username', 'Team'], rows: [
    ['123', 'Detroit skater', 'Detroit Red Wings'], ['456', 'Detroit goalie', 'DET'],
    ['123', 'Buffalo skater', 'BUF'], ['456', 'Buffalo goalie', 'Buffalo Sabres'],
    ['999', 'Different game', 'DET'], ['123', 'Unknown team', '']] };
  const players = team => plain(context.scoreMatchupTeamBoxRows(data, '123+456', team, normalize).map(row => row[1]));
  assert.deepEqual(players('DET'), ['Detroit skater', 'Detroit goalie']);
  assert.deepEqual(players('Buffalo Sabres'), ['Buffalo skater', 'Buffalo goalie']);
  assert.deepEqual(players('ANA'), []);
  assert.equal(context.scoreMatchupTeamBoxRows({ cols: ['Match ID'], rows: [['123']] }, '123', 'DET', normalize).length, 0);
});
