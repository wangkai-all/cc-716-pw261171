// core.js — 代表点挑选核心逻辑（纯函数，浏览器与 Node 测试共用）
//
// 流程约定（与界面一致）：
//   ① 每个维度先指定业务尺度（scale），距离在「值/尺度」归一化空间取欧氏距离；
//   ② 先明确可参与样本范围：缺失任一启用维度的记录退出范围，
//      不允许临时忽略缺失维度后再与完整记录比距离；
//   ③ 对可参与记录计算完整距离表；
//   ④ 在最远点贪心 / 小规模精确枚举中选择代表点（约束实际进入选择过程）；
//   ⑤ 分配全部可参与记录到最近代表点，得到覆盖半径与被遗漏最严重的记录。

export const EXACT_MAX_N = 18; // 十八条以内可枚举核对
const EPS = 1e-9;

/** 启用的维度：勾选参与且尺度为正 */
export function activeDimensions(dims) {
  return dims.filter((d) => d.active && Number.isFinite(d.scale) && d.scale > 0);
}

/**
 * 第②步：明确可参与范围。
 * 缺失启用维度的记录、被排除的故障采集记录，都退出范围（不被覆盖也不可参选），
 * 并保留退出原因用于展示。
 */
export function computeScope(records, dims, { excludeFaulty = false } = {}) {
  const eligible = [];
  const excluded = [];
  for (const r of records) {
    const reasons = [];
    const missing = dims.filter((d) => !Number.isFinite(r.values[d.key]));
    if (missing.length > 0) {
      reasons.push(`缺失维度：${missing.map((d) => d.label).join('、')}`);
    }
    if (excludeFaulty && r.faulty) reasons.push('故障采集记录');
    if (reasons.length > 0) excluded.push({ id: r.id, reasons });
    else eligible.push(r.id);
  }
  return { eligible, excluded };
}

export function normalizedCoords(record, dims) {
  return dims.map((d) => record.values[d.key] / d.scale);
}

/** 第③步：完整距离表。坐标相同但来源不同的记录各自保留（血缘不去重），距离为 0。 */
export function computeDistanceMatrix(recordsById, ids, dims) {
  const coords = {};
  for (const id of ids) coords[id] = normalizedCoords(recordsById[id], dims);
  const n = ids.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = coords[ids[i]];
      const b = coords[ids[j]];
      let s = 0;
      for (let t = 0; t < a.length; t++) {
        const d = a[t] - b[t];
        s += d * d;
      }
      matrix[i][j] = matrix[j][i] = Math.sqrt(s);
    }
  }
  return { ids, matrix, coords };
}

export function indexMap(ids) {
  return new Map(ids.map((id, i) => [id, i]));
}

/**
 * 第④步-a：最远点贪心（Gonzalez）。
 * 无约束（无必选、无名额、无禁选）时半径 ≤ 2 × 最优；
 * 约束生效后该 2-近似保证不再适用，调用方必须在界面上提示。
 *
 * 约束处理：pinned 直接作为初始代表点；每步若剩余名额已等于类型名额缺口，
 * 则只在缺口类型中选最远点，保证名额约束被真正满足。
 */
export function farthestGreedy(dist, candidates, k, { pinned = [], quotas = {}, typeOf = {} } = {}) {
  const idx = indexMap(dist.ids);
  const selected = [];
  const inSel = new Set();
  for (const p of pinned) {
    if (!inSel.has(p)) {
      selected.push(p);
      inSel.add(p);
    }
  }

  if (selected.length === 0 && candidates.length > 0) {
    // 确定性种子：候选集中距离最远的一对，取字典序较小端点
    let best = -1;
    let seed = candidates[0];
    for (let a = 0; a < candidates.length; a++) {
      for (let b = a + 1; b < candidates.length; b++) {
        const d = dist.matrix[idx.get(candidates[a])][idx.get(candidates[b])];
        if (d > best + EPS) {
          best = d;
          seed = candidates[a] < candidates[b] ? candidates[a] : candidates[b];
        }
      }
    }
    selected.push(seed);
    inSel.add(seed);
  }

  while (selected.length < k) {
    const slotsLeft = k - selected.length;
    const counts = {};
    for (const s of selected) {
      const t = typeOf[s];
      counts[t] = (counts[t] || 0) + 1;
    }
    let deficit = 0;
    const need = {};
    for (const [t, q] of Object.entries(quotas)) {
      const lack = Math.max(0, (q || 0) - (counts[t] || 0));
      if (lack > 0) {
        need[t] = lack;
        deficit += lack;
      }
    }
    let pool = candidates.filter((c) => !inSel.has(c));
    if (pool.length === 0) break;
    if (deficit >= slotsLeft) {
      const forced = pool.filter((c) => need[typeOf[c]] > 0);
      if (forced.length > 0) pool = forced;
    }
    let pick = null;
    let pickD = -1;
    for (const c of pool) {
      const ci = idx.get(c);
      let m = Infinity;
      for (const s of selected) {
        const d = dist.matrix[ci][idx.get(s)];
        if (d < m) m = d;
      }
      if (m > pickD + EPS || (Math.abs(m - pickD) <= EPS && (pick === null || c < pick))) {
        pick = c;
        pickD = m;
      }
    }
    if (pick === null) break;
    selected.push(pick);
    inSel.add(pick);
  }
  return selected;
}

function* combinationIndices(n, r, start = 0, prefix = []) {
  if (r === 0) {
    yield prefix;
    return;
  }
  for (let i = start; i <= n - r; i++) {
    yield* combinationIndices(n, r - 1, i + 1, [...prefix, i]);
  }
}

/**
 * 第④步-b：小规模精确枚举。候选数超过 EXACT_MAX_N（18）时返回 null（关闭枚举）。
 * 枚举所有满足必选/名额约束的子集，取最坏覆盖半径最小者；
 * 并列时依次按总距离、字典序取确定性结果。约束下依然是最优（枚举核对基准）。
 */
export function exactSearch(dist, candidates, k, { pinned = [], quotas = {}, typeOf = {} } = {}) {
  if (candidates.length > EXACT_MAX_N) return null;
  const idx = indexMap(dist.ids);
  const pool = candidates.filter((c) => !pinned.includes(c));
  const need = k - pinned.length;
  if (need < 0 || need > pool.length) {
    return { selected: null, radius: null, combos: 0, feasibleSubsets: 0 };
  }
  let combos = 0;
  let feasibleSubsets = 0;
  let best = null;
  for (const inds of combinationIndices(pool.length, need)) {
    combos++;
    const sel = [...pinned, ...inds.map((i) => pool[i])];
    const counts = {};
    for (const s of sel) {
      const t = typeOf[s];
      counts[t] = (counts[t] || 0) + 1;
    }
    let ok = true;
    for (const [t, q] of Object.entries(quotas)) {
      if ((counts[t] || 0) < (q || 0)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    feasibleSubsets++;
    let radius = 0;
    let sum = 0;
    for (const p of dist.ids) {
      const pi = idx.get(p);
      let m = Infinity;
      for (const s of sel) {
        const d = dist.matrix[pi][idx.get(s)];
        if (d < m) m = d;
      }
      if (m > radius) radius = m;
      sum += m;
    }
    const key = sel.slice().sort().join('');
    if (
      !best ||
      radius < best.radius - EPS ||
      (Math.abs(radius - best.radius) <= EPS &&
        (sum < best.sum - EPS || (Math.abs(sum - best.sum) <= EPS && key < best.key)))
    ) {
      best = { selected: sel, radius, sum, key };
    }
  }
  return {
    selected: best ? best.selected : null,
    radius: best ? best.radius : null,
    combos,
    feasibleSubsets,
  };
}

/** 第⑤步：全部可参与记录分配到最近代表点，得到半径与被遗漏最严重的记录。 */
export function assignAll(dist, selected) {
  const idx = indexMap(dist.ids);
  const reps = [...selected].sort();
  const assign = {};
  const dmap = {};
  let radius = 0;
  let worst = null;
  for (const p of dist.ids) {
    const pi = idx.get(p);
    let m = Infinity;
    let rep = null;
    for (const s of reps) {
      const d = dist.matrix[pi][idx.get(s)];
      if (d < m - EPS) {
        m = d;
        rep = s;
      }
    }
    assign[p] = rep;
    dmap[p] = m;
    if (m > radius + EPS || (Math.abs(m - radius) <= EPS && (worst === null || p < worst))) {
      radius = m;
      worst = p;
    }
  }
  const coveredBy = {};
  for (const s of selected) coveredBy[s] = [];
  for (const p of dist.ids) coveredBy[assign[p]].push(p);
  return { assign, dist: dmap, radius, worst, coveredBy };
}

/** 约束可行性检查，返回问题列表（空数组 = 可行）。 */
export function checkFeasibility({ k, candidates, pinned, quotas, typeOf }) {
  const problems = [];
  if (!Number.isInteger(k) || k < 1) problems.push('代表点数量 k 至少为 1');
  if (k > candidates.length) problems.push(`k=${k} 超过可参选记录数 ${candidates.length}`);
  const candSet = new Set(candidates);
  for (const p of pinned) {
    if (!candSet.has(p)) problems.push(`必选样本 ${p} 不在可参选范围（缺失维度 / 故障已排除 / 被禁选）`);
  }
  if (pinned.length > k) problems.push(`必选样本数 ${pinned.length} 超过 k=${k}`);
  const qsum = Object.values(quotas).reduce((a, b) => a + (b || 0), 0);
  if (qsum > k) problems.push(`类型最低名额合计 ${qsum} 超过 k=${k}`);
  const avail = {};
  for (const c of candidates) {
    const t = typeOf[c];
    avail[t] = (avail[t] || 0) + 1;
  }
  for (const [t, q] of Object.entries(quotas)) {
    if ((q || 0) > (avail[t] || 0)) {
      problems.push(`类型「${t}」最低名额 ${q} 超过其可参选记录数 ${avail[t] || 0}`);
    }
  }
  return problems;
}

/** 是否处于无约束情形（决定贪心 2-近似保证是否适用） */
export function isUnconstrained({ pinned = [], quotas = {}, banned = [] } = {}) {
  const qsum = Object.values(quotas).reduce((a, b) => a + (b || 0), 0);
  return pinned.length === 0 && banned.length === 0 && qsum === 0;
}

export function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 生成带 BOM 的 CSV 文本（Excel 友好） */
export function toCSV(rows) {
  return '﻿' + rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
}
