const TYPE_LABELS = { down: '🔴 DOWN', recovered: '🟢 復旧', summary: '📊 週次サマリ' };
const STATUS_ICONS = { up: '🟢', down: '🔴' };

export function titleOf(event) {
  if (event.type === 'summary') return TYPE_LABELS.summary;
  return `${TYPE_LABELS[event.type]}: ${event.node} (${event.target})`;
}

export function describeEvent(event) {
  if (event.type === 'summary') return describeSummary(event);

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
  lines.push('', `確認時刻: ${event.occurredAt}`);
  return truncate(lines.join('\n'), 3900);
}

/** Discord の description は 4096 文字が上限なので余裕を持って切る。 */
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(省略)`;
}
