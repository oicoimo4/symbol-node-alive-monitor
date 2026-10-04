import { readFile, rename, writeFile } from 'node:fs/promises';

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

export async function readState(path, { logger = console } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    // ファイルが無いのは「初回実行」なので正常系。それ以外の読み込み失敗を黙って
    // 初期状態に落とすと、通知の重複や週次カウンタの消失として後から現れるため、
    // 必ず警告を残して原因を追えるようにする。
    if (err.code !== 'ENOENT') {
      logger.warn(`state の読み込みに失敗したため初期状態から開始します (${path}): ${err.message}`);
    }
    return createInitialState();
  }

  try {
    return normalizeState(JSON.parse(text));
  } catch (err) {
    logger.warn(`state の解析に失敗したため初期状態から開始します (${path}): ${err.message}`);
    return createInitialState();
  }
}

export async function writeState(path, state) {
  // 書き込み途中でジョブが落ちると、workflow の if: always() が壊れた JSON を
  // force push してしまう。一時ファイルに書いてから rename で差し替える。
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}
