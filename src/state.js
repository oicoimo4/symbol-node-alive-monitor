import { readFile, writeFile } from 'node:fs/promises';

export const CURRENT_VERSION = 1;

/** 新規に監視対象を発見したときの初期状態。 */
export const INITIAL_TARGET_STATE = Object.freeze({
  status: 'up',
  consecutiveFailures: 0,
  lastHeight: null,
  lastOkAt: null,
  downSince: null,
  notified: false,
  incidentsThisWeek: 0,
});

export function createInitialState() {
  return { version: CURRENT_VERSION, updatedAt: null, lastWeeklySummaryAt: null, targets: {} };
}

/**
 * 外部から読み込んだ値を State に正規化する。
 * 空・不正・未知バージョンのいずれも初期状態として扱う
 * (state ブランチが存在しない初回実行では "{}" が渡ってくる)。
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== CURRENT_VERSION) {
    return createInitialState();
  }
  if (!raw.targets || typeof raw.targets !== 'object') {
    return createInitialState();
  }

  const targets = {};
  for (const [key, value] of Object.entries(raw.targets)) {
    targets[key] = { ...INITIAL_TARGET_STATE, ...(value ?? {}) };
  }

  return {
    version: CURRENT_VERSION,
    updatedAt: raw.updatedAt ?? null,
    lastWeeklySummaryAt: raw.lastWeeklySummaryAt ?? null,
    targets,
  };
}

export async function readState(path) {
  try {
    return normalizeState(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return createInitialState();
  }
}

export async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
