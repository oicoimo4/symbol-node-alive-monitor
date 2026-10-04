import { CURRENT_VERSION, INITIAL_TARGET_STATE } from './state.js';

/** この回数の連続失敗で初めて DOWN 通知を送る（瞬断による誤報を防ぐ）。 */
export const FAILURE_THRESHOLD = 2;

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const TLS_HINT = 'HTTP(3000) は正常に応答しています。TLS 証明書の期限切れの可能性があります。';

/**
 * 前回の state と今回の検査結果から、新しい state と送るべき通知イベントを求める。
 * 副作用を持たず、現在時刻も引数で受け取る純粋関数であること。
 */
export function evaluate({ prevState, results, now }) {
  const occurredAt = now.toISOString();
  const targets = {};
  const events = [];

  for (const result of results) {
    const prev = prevState.targets?.[result.key] ?? INITIAL_TARGET_STATE;

    if (result.ok) {
      if (prev.notified) {
        events.push(makeEvent('recovered', result, {
          occurredAt,
          downSince: prev.downSince,
          detail: result.detail,
        }));
      }
      targets[result.key] = {
        status: 'up',
        consecutiveFailures: 0,
        lastHeight: result.height ?? prev.lastHeight,
        lastOkAt: occurredAt,
        downSince: null,
        notified: false,
        incidentsThisWeek: prev.incidentsThisWeek,
      };
      continue;
    }

    const consecutiveFailures = prev.consecutiveFailures + 1;
    const downSince = prev.downSince ?? occurredAt;
    const shouldNotify = consecutiveFailures >= FAILURE_THRESHOLD && !prev.notified;

    if (shouldNotify) {
      events.push(makeEvent('down', result, {
        occurredAt,
        downSince,
        detail: result.detail,
        reason: result.reason,
      }));
    }

    targets[result.key] = {
      status: consecutiveFailures >= FAILURE_THRESHOLD ? 'down' : 'up',
      consecutiveFailures,
      // 失敗時は lastHeight を更新しない。復旧判定に前回の正常値を使うため。
      lastHeight: prev.lastHeight,
      lastOkAt: prev.lastOkAt,
      downSince,
      notified: prev.notified || shouldNotify,
      incidentsThisWeek: prev.incidentsThisWeek + (shouldNotify ? 1 : 0),
    };
  }

  annotateTlsHint(events, results);

  let lastWeeklySummaryAt = prevState.lastWeeklySummaryAt ?? null;
  const summaryDue =
    lastWeeklySummaryAt === null ||
    now.getTime() - Date.parse(lastWeeklySummaryAt) >= WEEK_MS;

  if (summaryDue) {
    events.push(buildSummaryEvent(targets, results, occurredAt));
    lastWeeklySummaryAt = occurredAt;
    for (const key of Object.keys(targets)) {
      targets[key].incidentsThisWeek = 0;
    }
  }

  return {
    nextState: { version: CURRENT_VERSION, updatedAt: occurredAt, lastWeeklySummaryAt, targets },
    events,
  };
}

function makeEvent(type, result, { occurredAt, downSince, detail, reason = null }) {
  return {
    type,
    key: result.key,
    node: result.node,
    target: result.label,
    reason,
    detail,
    hint: null,
    downSince,
    occurredAt,
    snapshot: null,
  };
}

/**
 * https だけが落ちていて http が生きている場合、
 * TLS 証明書の期限切れを疑う一文を通知に添える。
 */
function annotateTlsHint(events, results) {
  const okByKey = new Map(results.map((r) => [r.key, r.ok]));
  for (const event of events) {
    if (event.type !== 'down' || event.target !== 'api-https') continue;
    if (okByKey.get(`${event.node}::api-http`) === true) {
      event.hint = TLS_HINT;
    }
  }
}

function buildSummaryEvent(targets, results, occurredAt) {
  const resultByKey = new Map(results.map((r) => [r.key, r]));
  const snapshot = Object.entries(targets).map(([key, state]) => ({
    key,
    node: resultByKey.get(key)?.node ?? null,
    target: resultByKey.get(key)?.label ?? null,
    status: state.status,
    incidentsThisWeek: state.incidentsThisWeek,
    lastOkAt: state.lastOkAt,
    lastHeight: state.lastHeight,
  }));

  return {
    type: 'summary',
    key: null,
    node: null,
    target: null,
    reason: null,
    detail: `監視対象 ${snapshot.length} 件`,
    hint: null,
    downSince: null,
    occurredAt,
    snapshot,
  };
}
