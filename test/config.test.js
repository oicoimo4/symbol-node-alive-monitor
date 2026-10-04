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
