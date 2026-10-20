import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';

test('api の http と https を別々の Target に展開する', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { http: 3000, https: 3001 } }],
  });
  assert.deepEqual(targets, [
    { key: 'n1::api-http', node: 'n1', kind: 'api', label: 'api-http', url: 'http://example.com:3000' },
    { key: 'n1::api-https', node: 'n1', kind: 'api', label: 'api-https', url: 'https://example.com:3001' },
  ]);
});

test('api の片方だけでも展開できる', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { https: 3001 } }],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].key, 'n1::api-https');
});

test('peer を Target に展開する', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', peer: { port: 7900 } }],
  });
  assert.deepEqual(targets, [
    { key: 'n1::peer', node: 'n1', kind: 'peer', label: 'peer', host: 'example.com', port: 7900 },
  ]);
});

test('複数ノードをすべて展開する', () => {
  const targets = parseConfig({
    nodes: [
      { name: 'n1', host: 'a.example.com', api: { https: 3001 } },
      { name: 'n2', host: 'b.example.com', peer: { port: 7900 } },
    ],
  });
  assert.deepEqual(targets.map((t) => t.key), ['n1::api-https', 'n2::peer']);
});

test('nodes が配列でなければ失敗する', () => {
  assert.throws(() => parseConfig({}), /nodes/);
});

test('name が重複していれば失敗する', () => {
  assert.throws(
    () => parseConfig({
      nodes: [
        { name: 'dup', host: 'a.example.com', peer: { port: 7900 } },
        { name: 'dup', host: 'b.example.com', peer: { port: 7900 } },
      ],
    }),
    /重複/,
  );
});

test('name が空文字なら失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: '', host: 'a.example.com', peer: { port: 7900 } }] }),
    /name/,
  );
});

test('host が無ければ失敗する', () => {
  assert.throws(() => parseConfig({ nodes: [{ name: 'n1', peer: { port: 7900 } }] }), /host/);
});

test('api も peer も無ければ失敗する', () => {
  assert.throws(() => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com' }] }), /api/);
});

test('api が空オブジェクトで peer も無ければ失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com', api: {} }] }),
    /監視対象/,
  );
});

test('ポート番号が範囲外なら失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com', peer: { port: 70000 } }] }),
    /65535/,
  );
});

test('ポート番号が整数でなければ失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com', api: { http: '3000' } }] }),
    /整数/,
  );
});

test('監視対象が1件も無ければ失敗する', () => {
  assert.throws(() => parseConfig({ nodes: [] }), /監視対象/);
});

test('harvesters: true は https を優先して 1 件だけ展開する', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { http: 3000, https: 3001 }, harvesters: true }],
  });
  assert.deepEqual(targets, [
    { key: 'n1::api-http', node: 'n1', kind: 'api', label: 'api-http', url: 'http://example.com:3000' },
    { key: 'n1::api-https', node: 'n1', kind: 'api', label: 'api-https', url: 'https://example.com:3001' },
    { key: 'n1::harvesters', node: 'n1', kind: 'harvesters', label: 'harvesters', url: 'https://example.com:3001' },
  ]);
});

test('harvesters: true で https が無ければ http から取得する', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { http: 3000 }, peer: { port: 7900 }, harvesters: true }],
  });
  const harvester = targets.find((t) => t.kind === 'harvesters');
  assert.equal(harvester.url, 'http://example.com:3000');
});

test('harvesters: false なら harvester を展開しない', () => {
  const targets = parseConfig({
    nodes: [{ name: 'n1', host: 'example.com', api: { https: 3001 }, harvesters: false }],
  });
  assert.deepEqual(targets.map((t) => t.kind), ['api']);
});

test('harvesters: true で api が無ければ失敗する', () => {
  assert.throws(
    () => parseConfig({ nodes: [{ name: 'n1', host: 'a.example.com', peer: { port: 7900 }, harvesters: true }] }),
    /harvesters/,
  );
});

test('harvesters: true で api にポートが無ければ失敗する', () => {
  assert.throws(
    () => parseConfig({
      nodes: [{ name: 'n1', host: 'a.example.com', api: {}, peer: { port: 7900 }, harvesters: true }],
    }),
    /harvesters/,
  );
});

test('harvesters が真偽値でなければ失敗する', () => {
  // 文字列の "true" を黙って無視すると、監視しているつもりで何も起きない
  assert.throws(
    () => parseConfig({
      nodes: [{ name: 'n1', host: 'a.example.com', api: { https: 3001 }, harvesters: 'true' }],
    }),
    /true か false/,
  );
});
