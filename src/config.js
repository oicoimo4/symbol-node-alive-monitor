import { readFile } from 'node:fs/promises';

/**
 * 設定オブジェクトを検証し、フラットな監視対象リストに展開する。
 * 検証に失敗した場合は Error を throw する（設定ミスで監視が無言で止まるのを防ぐため）。
 */
export function parseConfig(raw) {
  if (!raw || !Array.isArray(raw.nodes)) {
    throw new Error('config: トップレベルに "nodes" 配列が必要です');
  }

  const targets = [];
  const seenNames = new Set();

  for (const [index, node] of raw.nodes.entries()) {
    const where = `nodes[${index}]`;

    if (typeof node?.name !== 'string' || node.name === '') {
      throw new Error(`${where}: "name" は空でない文字列が必要です`);
    }
    if (seenNames.has(node.name)) {
      throw new Error(`${where}: "name" が重複しています: ${node.name}`);
    }
    seenNames.add(node.name);

    if (typeof node.host !== 'string' || node.host === '') {
      throw new Error(`${where}: "host" は空でない文字列が必要です`);
    }
    if (!node.api && !node.peer) {
      throw new Error(`${where}: "api" か "peer" の少なくとも一方が必要です`);
    }

    const before = targets.length;

    for (const scheme of ['http', 'https']) {
      const port = node.api?.[scheme];
      if (port === undefined) continue;
      assertPort(port, `${where}.api.${scheme}`);
      targets.push({
        key: `${node.name}::api-${scheme}`,
        node: node.name,
        kind: 'api',
        label: `api-${scheme}`,
        url: `${scheme}://${node.host}:${port}`,
      });
    }

    if (node.peer) {
      assertPort(node.peer.port, `${where}.peer.port`);
      targets.push({
        key: `${node.name}::peer`,
        node: node.name,
        kind: 'peer',
        label: 'peer',
        host: node.host,
        port: node.peer.port,
      });
    }

    if (node.harvesters !== undefined && typeof node.harvesters !== 'boolean') {
      throw new Error(
        `${where}.harvesters: true か false が必要です (受け取った値: ${JSON.stringify(node.harvesters)})`,
      );
    }
    if (node.harvesters) {
      targets.push(harvesterTarget(node, where));
    }

    if (targets.length === before) {
      throw new Error(`${where}: 監視対象が1件も展開されませんでした`);
    }
  }

  if (targets.length === 0) {
    throw new Error('config: 監視対象が1件もありません');
  }

  return targets;
}

export async function loadConfig(path) {
  const text = await readFile(path, 'utf8');
  return parseConfig(JSON.parse(text));
}

/**
 * harvester 一覧の取得先を作る。一覧はノード単位の値なので、http と https の両方から
 * 取ると二重計上になる。https を優先し、無ければ http から 1 回だけ取得する。
 * ポート番号は api の展開時に検証済み。
 */
function harvesterTarget(node, where) {
  const scheme = node.api?.https !== undefined ? 'https' : 'http';
  const port = node.api?.[scheme];
  if (port === undefined) {
    throw new Error(`${where}.harvesters: harvester の一覧は REST から取得するため "api" の http か https が必要です`);
  }
  return {
    key: `${node.name}::harvesters`,
    node: node.name,
    kind: 'harvesters',
    label: 'harvesters',
    url: `${scheme}://${node.host}:${port}`,
  };
}

function assertPort(port, where) {
  if (!Number.isInteger(port)) {
    throw new Error(`${where}: ポート番号は整数が必要です (受け取った値: ${JSON.stringify(port)})`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(`${where}: ポート番号は 1〜65535 の範囲が必要です (受け取った値: ${port})`);
  }
}
