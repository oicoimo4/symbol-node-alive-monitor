const TYPE_LABELS = {
  down: '🔴 DOWN',
  recovered: '🟢 復旧',
  summary: '📊 週次サマリ',
  harvesters: '🌾 Harvester 変化',
};
const STATUS_ICONS = { up: '🟢', down: '🔴' };

/** 公開鍵（64 文字）のうち通知に出す先頭の文字数。見分けるにはこれで足りる。 */
const ACCOUNT_PREFIX_LENGTH = 12;

export function titleOf(event) {
  if (event.type === 'summary') return TYPE_LABELS.summary;
  // harvester はノード単位の値なので、監視対象（api-https など）を見出しに出さない。
  if (event.type === 'harvesters') return `${TYPE_LABELS.harvesters}: ${event.node}`;
  return `${TYPE_LABELS[event.type]}: ${event.node} (${event.target})`;
}

export function describeEvent(event) {
  if (event.type === 'summary') return describeSummary(event);
  if (event.type === 'harvesters') return describeHarvesters(event);

  const lines = [event.detail];
  if (event.hint) lines.push('', event.hint);
  if (event.downSince) lines.push('', `障害開始: ${event.downSince}`);
  lines.push(`確認時刻: ${event.occurredAt}`);
  return truncate(lines.join('\n'), 3900);
}

function describeSummary(event) {
  const lines = event.snapshot.map((item) => {
    const icon = STATUS_ICONS[item.status] ?? '❔';
    const parts = [`${icon} ${item.node} / ${item.target}`, `障害 ${item.incidentsThisWeek} 回`];
    if (item.lastHeight) parts.push(`height ${item.lastHeight}`);
    parts.push(`最終正常 ${item.lastOkAt ?? '未確認'}`);
    return parts.join(' — ');
  });
  // harvesters はサマリを作った後で index.js が付け加える（evaluate を変更しないため）。
  // 最終確認時刻が古いままなら、一覧を取得できない状態が続いている。
  if (event.harvesters?.length > 0) {
    lines.push('', ...event.harvesters.map((item) =>
      `🌾 ${item.node} — harvester ${item.count} 件 — 最終確認 ${item.observedAt ?? '未確認'}`));
  }
  lines.push('', `確認時刻: ${event.occurredAt}`);
  return truncate(lines.join('\n'), 3900);
}

/**
 * 参加・離脱のうち空のほうは行ごと出さない。
 * 「離脱: （なし）」のような情報量のない行は、本当に見るべき行を埋もれさせる。
 */
function describeHarvesters(event) {
  const lines = [event.detail, ''];
  if (event.added.length > 0) lines.push(`参加: ${event.added.map(shortAccount).join(', ')}`);
  if (event.removed.length > 0) lines.push(`離脱: ${event.removed.map(shortAccount).join(', ')}`);
  lines.push('', `確認時刻: ${event.occurredAt}`);
  return truncate(lines.join('\n'), 3900);
}

function shortAccount(publicKey) {
  return `${publicKey.slice(0, ACCOUNT_PREFIX_LENGTH)}…`;
}

/** Discord の description は 4096 文字が上限なので余裕を持って切る。 */
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(省略)`;
}
