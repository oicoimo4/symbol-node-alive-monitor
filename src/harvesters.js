/** そのノードが今回「健全」だと判断する根拠にしてよい検査のラベル。 */
const API_LABELS = new Set(['api-http', 'api-https']);

/**
 * 前回の harvester 記録と今回の観測から、新しい記録と送るべきイベントを求める。
 * evaluate と同じく副作用を持たない純粋関数で、現在時刻も引数で受け取る。
 * 死活監視の state（targets）には一切関与しない。
 *
 * observations は gateByApiHealth を通したものを渡すこと。
 */
export function evaluateHarvesters({ prevHarvesters, observations, now }) {
  const occurredAt = now.toISOString();
  const records = [];
  const events = [];

  for (const observation of observations) {
    const { node } = observation;
    // ノード名は自由な文字列なので、constructor や __proto__ のような名前でも
    // Object.prototype のメンバーを前回の記録と取り違えないようにする。
    const prev = Object.hasOwn(prevHarvesters ?? {}, node) ? prevHarvesters[node] : undefined;

    if (!observation.ok || !Array.isArray(observation.accounts)) {
      // 観測できなかった回は比較せず、前回の記録をそのまま引き継ぐ。
      if (prev) records.push([node, { accounts: [...prev.accounts], observedAt: prev.observedAt }]);
      continue;
    }

    // 並び順や重複に左右されないよう、集合として扱う。
    const current = new Set(observation.accounts);
    records.push([node, { accounts: [...current].sort(), observedAt: occurredAt }]);

    // 初回は比較対象がないので記録だけする。
    if (!prev) continue;

    const previous = new Set(prev.accounts);
    const added = [...current].filter((account) => !previous.has(account)).sort();
    const removed = [...previous].filter((account) => !current.has(account)).sort();
    if (added.length === 0 && removed.length === 0) continue;

    events.push({
      type: 'harvesters',
      key: `${node}::harvesters`,
      node,
      target: 'harvesters',
      reason: null,
      detail: `${previous.size} → ${current.size} 件`,
      hint: null,
      downSince: null,
      occurredAt,
      snapshot: null,
      added,
      removed,
      before: previous.size,
      after: current.size,
    });
  }

  return { nextHarvesters: Object.fromEntries(records), events };
}

/**
 * 同じ実行で api 検査が成功していないノードの観測を、失敗した観測に置き換える。
 *
 * ノードが止まっていたり不調だったりすると、一覧の取得が失敗するか空の一覧が返る。
 * それをそのまま比較すると「全員離脱」の誤報になるため、ノードが健全だと
 * 確認できた回の観測だけを比較に使う。
 */
export function gateByApiHealth(observations, results) {
  const healthyNodes = new Set(
    results.filter((result) => result.ok && API_LABELS.has(result.label)).map((result) => result.node),
  );
  return observations.map((observation) => {
    if (!observation.ok || healthyNodes.has(observation.node)) return observation;
    return {
      ...observation,
      ok: false,
      accounts: null,
      detail: 'api 検査が成功していないため harvester の比較を見送りました',
    };
  });
}

/**
 * 週次サマリに harvester の現在件数を付け加える。
 * サマリは evaluate が作るが、evaluate を変更しないためにここで後から付ける。
 *
 * nodes は harvesters: true に設定したノード名（設定の並び順）。設定したのに記録が無い
 * ノードは、機能を有効にしていないのと見分けがつかなくなるため count が null の項目で
 * 載せる（一覧を一度も取得できていない）。nodes が空なら何も付けない。
 * 受け取った配列もイベントも変更しない。
 */
export function annotateSummary(events, harvesters, nodes) {
  if (nodes.length === 0) return [...events];

  const summary = nodes.map((node) => {
    const entry = Object.hasOwn(harvesters ?? {}, node) ? harvesters[node] : undefined;
    return {
      node,
      count: entry ? entry.accounts.length : null,
      observedAt: entry ? entry.observedAt : null,
    };
  });
  return events.map((event) => (event.type === 'summary' ? { ...event, harvesters: summary } : event));
}
