import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateSummary, evaluateHarvesters, gateByApiHealth } from '../src/harvesters.js';

const NOW = new Date('2026-10-20T14:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const EARLIER = '2026-10-20T13:00:00.000Z';

/** 取得に成功した観測を作る。 */
const seen = (accounts, over = {}) => ({
  key: 'n1::harvesters', node: 'n1', label: 'harvesters',
  ok: true, reason: null, detail: `harvester ${accounts.length} 件`, accounts, ...over,
});

/** 取得に失敗した観測を作る。 */
const missed = (over = {}) => ({
  key: 'n1::harvesters', node: 'n1', label: 'harvesters',
  ok: false, reason: 'unreachable', detail: '接続できません', accounts: null, ...over,
});

/** 前回の記録を作る。 */
const record = (accounts, observedAt = EARLIER) => ({ accounts, observedAt });

const run = (prevHarvesters, observations) => evaluateHarvesters({ prevHarvesters, observations, now: NOW });

/** 既定で「正常な api-https の検査結果」を作る。 */
const apiResult = (over = {}) => ({
  key: 'n1::api-https', node: 'n1', label: 'api-https',
  ok: true, reason: null, detail: '正常', height: '200', ...over,
});

// --- evaluateHarvesters ---

test('初回の観測ではイベントを出さず一覧を記録する', () => {
  const { nextHarvesters, events } = run({}, [seen(['BB', 'AA'])]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters, { n1: { accounts: ['AA', 'BB'], observedAt: NOW_ISO } });
});

test('一覧が同じならイベントを出さず observedAt だけ更新する', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA', 'BB']) }, [seen(['AA', 'BB'])]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters.n1, { accounts: ['AA', 'BB'], observedAt: NOW_ISO });
});

test('並び順だけが違う一覧ではイベントを出さない', () => {
  const { events } = run({ n1: record(['AA', 'BB']) }, [seen(['BB', 'AA'])]);
  assert.deepEqual(events, []);
});

test('参加だけなら added に載せたイベントを 1 件出す', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA']) }, [seen(['AA', 'BB'])]);
  assert.deepEqual(events, [{
    type: 'harvesters',
    key: 'n1::harvesters',
    node: 'n1',
    target: 'harvesters',
    reason: null,
    detail: '1 → 2 件',
    hint: null,
    downSince: null,
    occurredAt: NOW_ISO,
    snapshot: null,
    added: ['BB'],
    removed: [],
    before: 1,
    after: 2,
  }]);
  assert.deepEqual(nextHarvesters.n1.accounts, ['AA', 'BB']);
});

test('離脱だけなら removed に載せたイベントを 1 件出す', () => {
  const { events } = run({ n1: record(['AA', 'BB']) }, [seen(['AA'])]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].added, []);
  assert.deepEqual(events[0].removed, ['BB']);
  assert.equal(events[0].detail, '2 → 1 件');
});

test('入れ替わりは参加と離脱を 1 つのイベントにまとめる', () => {
  const { events } = run({ n1: record(['AA', 'BB']) }, [seen(['AA', 'CC'])]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].added, ['CC']);
  assert.deepEqual(events[0].removed, ['BB']);
  assert.equal(events[0].detail, '2 → 2 件');
});

test('一覧が空になれば全員の離脱として通知する', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA', 'BB']) }, [seen([])]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].removed, ['AA', 'BB']);
  assert.equal(events[0].detail, '2 → 0 件');
  assert.deepEqual(nextHarvesters.n1.accounts, []);
});

test('観測に重複があっても件数は重複を除いて数える', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA']) }, [seen(['AA', 'BB', 'BB'])]);
  assert.equal(events[0].detail, '1 → 2 件');
  assert.deepEqual(nextHarvesters.n1.accounts, ['AA', 'BB']);
});

test('観測に失敗したら前回の一覧を保持しイベントを出さない', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA', 'BB']) }, [missed()]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters, { n1: { accounts: ['AA', 'BB'], observedAt: EARLIER } });
});

test('観測に失敗し前回の記録も無ければ何も記録しない', () => {
  const { nextHarvesters, events } = run({}, [missed()]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters, {});
});

test('観測の無いノード（設定から外したノード）の記録は除去する', () => {
  const { nextHarvesters } = run(
    { n1: record(['AA']), retired: record(['ZZ']) },
    [seen(['AA'])],
  );
  assert.deepEqual(Object.keys(nextHarvesters), ['n1']);
});

test('ノードごとに独立して判定する', () => {
  const { events } = run(
    { n1: record(['AA']), n2: record(['XX']) },
    [seen(['AA', 'BB']), seen(['XX'], { key: 'n2::harvesters', node: 'n2' })],
  );
  assert.deepEqual(events.map((e) => e.node), ['n1']);
});

test('prevHarvesters を変更しない', () => {
  const prev = { n1: record(['AA', 'BB']), n2: record(['XX']) };
  const snapshot = structuredClone(prev);
  const { nextHarvesters } = run(prev, [
    seen(['AA', 'CC']),
    missed({ key: 'n2::harvesters', node: 'n2' }),
  ]);
  // 返した記録を書き換えても前回の記録に波及しないこと（配列を共有していないこと）
  nextHarvesters.n1.accounts.push('MUTATED');
  nextHarvesters.n2.accounts.push('MUTATED');
  assert.deepEqual(prev, snapshot);
});

test('Object.prototype と同じ名前のノードでも前回の記録と取り違えない', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    const key = `${name}::harvesters`;

    // 前回の記録が無いまま観測に失敗しても、例外を投げず何も記録しない
    const failed = run({}, [missed({ key, node: name })]);
    assert.deepEqual(failed.events, [], `${name}: 失敗時のイベント`);
    assert.deepEqual(Object.keys(failed.nextHarvesters), [], `${name}: 失敗時の記録`);

    // 初回の観測は、そのノード名のまま自分自身のキーとして記録される
    const first = run({}, [seen(['AA'], { key, node: name })]);
    assert.deepEqual(first.events, [], `${name}: 初回のイベント`);
    assert.equal(Object.hasOwn(first.nextHarvesters, name), true, `${name}: 記録が自分自身のキーで残る`);
    assert.deepEqual(first.nextHarvesters[name].accounts, ['AA'], `${name}: 記録した一覧`);

    // 前回の記録があれば、通常のノードと同じように差分を出す
    const prev = Object.fromEntries([[name, record(['AA'])]]);
    const changed = run(prev, [seen(['AA', 'BB'], { key, node: name })]);
    assert.equal(changed.events.length, 1, `${name}: 差分のイベント数`);
    assert.deepEqual(changed.events[0].added, ['BB'], `${name}: 参加`);
  }
});

test('ok でも accounts が配列でない観測は失敗として扱う', () => {
  const { nextHarvesters, events } = run({ n1: record(['AA']) }, [seen([], { accounts: null })]);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters, { n1: { accounts: ['AA'], observedAt: EARLIER } });
});

// --- gateByApiHealth ---

test('api-https が成功しているノードの観測はそのまま通す', () => {
  const observation = seen(['AA']);
  const [gated] = gateByApiHealth([observation], [apiResult()]);
  assert.equal(gated, observation);
});

test('api-http だけが成功していても観測を通す', () => {
  const [gated] = gateByApiHealth(
    [seen(['AA'])],
    [apiResult({ ok: false, reason: 'unreachable' }), apiResult({ key: 'n1::api-http', label: 'api-http' })],
  );
  assert.equal(gated.ok, true);
});

test('api が失敗しているノードの観測は失敗に置き換える', () => {
  const [gated] = gateByApiHealth([seen(['AA'])], [apiResult({ ok: false, reason: 'chain-stalled' })]);
  assert.equal(gated.ok, false);
  assert.equal(gated.accounts, null);
  assert.match(gated.detail, /api/);
});

test('peer だけが成功していても観測を通さない', () => {
  const [gated] = gateByApiHealth(
    [seen(['AA'])],
    [{ key: 'n1::peer', node: 'n1', label: 'peer', ok: true, reason: null, detail: '正常', height: null }],
  );
  assert.equal(gated.ok, false);
});

test('別のノードの api が成功していても観測を通さない', () => {
  const [gated] = gateByApiHealth([seen(['AA'])], [apiResult({ key: 'n2::api-https', node: 'n2' })]);
  assert.equal(gated.ok, false);
});

test('gateByApiHealth は受け取った観測を変更しない', () => {
  const observation = seen(['AA']);
  gateByApiHealth([observation], []);
  assert.equal(observation.ok, true);
  assert.deepEqual(observation.accounts, ['AA']);
});

test('api が落ちている回に空の一覧が返っても全員離脱の誤報を出さない', () => {
  const observations = gateByApiHealth([seen([])], [apiResult({ ok: false, reason: 'health-down' })]);
  const { nextHarvesters, events } = run({ n1: record(['AA', 'BB']) }, observations);
  assert.deepEqual(events, []);
  assert.deepEqual(nextHarvesters.n1.accounts, ['AA', 'BB']);
});

// --- annotateSummary ---

const summaryEvent = () => ({
  type: 'summary', key: null, node: null, target: null, reason: null,
  detail: '監視対象 1 件', hint: null, downSince: null, occurredAt: NOW_ISO, snapshot: [],
});

const downEvent = () => ({
  type: 'down', key: 'n1::peer', node: 'n1', target: 'peer', reason: 'unreachable',
  detail: '接続できません', hint: null, downSince: EARLIER, occurredAt: NOW_ISO, snapshot: null,
});

test('サマリにだけ harvester の件数を付ける', () => {
  const down = downEvent();
  const result = annotateSummary([down, summaryEvent()], { n1: record(['AA', 'BB'], NOW_ISO) }, ['n1']);
  assert.equal(result[0], down);
  assert.deepEqual(result[1].harvesters, [{ node: 'n1', count: 2, observedAt: NOW_ISO }]);
});

test('harvester を設定したノードが無ければサマリに何も付けない', () => {
  const [summary] = annotateSummary([summaryEvent()], {}, []);
  assert.equal('harvesters' in summary, false);
});

test('harvester を設定したのに記録が無いノードは未取得として載せる', () => {
  const [summary] = annotateSummary([summaryEvent()], { n1: record(['AA'], NOW_ISO) }, ['n1', 'n2']);
  assert.deepEqual(summary.harvesters, [
    { node: 'n1', count: 1, observedAt: NOW_ISO },
    { node: 'n2', count: null, observedAt: null },
  ]);
});

test('annotateSummary は受け取ったイベントを変更しない', () => {
  const events = [summaryEvent()];
  annotateSummary(events, { n1: record(['AA']) }, ['n1']);
  assert.equal('harvesters' in events[0], false);
});
