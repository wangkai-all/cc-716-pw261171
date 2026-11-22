// core.test.mjs — 需求逐条对应的算法测试（node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXACT_MAX_N,
  activeDimensions,
  computeScope,
  computeDistanceMatrix,
  farthestGreedy,
  exactSearch,
  assignAll,
  checkFeasibility,
  isUnconstrained,
  toCSV,
} from '../src/core.js';
import { DIMENSIONS, RECORDS, DEVICE_TYPES } from '../src/data.js';

const recordsById = Object.fromEntries(RECORDS.map((r) => [r.id, r]));
const typeOf = Object.fromEntries(RECORDS.map((r) => [r.id, r.deviceType]));
const dims = () => activeDimensions(DIMENSIONS.map((d) => ({ ...d })));

function setup({ excludeFaulty = true } = {}) {
  const d = dims();
  const scope = computeScope(RECORDS, d, { excludeFaulty });
  const dist = computeDistanceMatrix(recordsById, scope.eligible, d);
  const candidates = scope.eligible.slice();
  return { d, scope, dist, candidates };
}

/** 独立实现的暴力枚举（位掩码），用于交叉核对 exactSearch */
function bruteForce(dist, candidates, k, { pinned = [], quotas = {} } = {}) {
  const idx = new Map(dist.ids.map((id, i) => [id, i]));
  const pool = candidates.filter((c) => !pinned.includes(c));
  const need = k - pinned.length;
  let best = null;
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    if (mask.toString(2).split('1').length - 1 !== need) continue;
    const sel = [...pinned, ...pool.filter((_, i) => mask & (1 << i))];
    const counts = {};
    for (const s of sel) counts[typeOf[s]] = (counts[typeOf[s]] || 0) + 1;
    if (Object.entries(quotas).some(([t, q]) => (counts[t] || 0) < q)) continue;
    let radius = 0;
    for (const p of dist.ids) {
      let m = Infinity;
      for (const s of sel) m = Math.min(m, dist.matrix[idx.get(p)][idx.get(s)]);
      radius = Math.max(radius, m);
    }
    if (!best || radius < best - 1e-9) best = radius;
  }
  return best;
}

test('可参与范围：缺失维度的记录退出范围，而不是临时忽略后比距离', () => {
  const { scope } = setup();
  assert.ok(!scope.eligible.includes('R13'), 'R13 缺失振动维度，不得参与');
  const r13 = scope.excluded.find((e) => e.id === 'R13');
  assert.ok(r13.reasons.some((r) => r.includes('缺失维度')));
  // 停用振动维度后，R13 应可参与（范围由启用维度决定，且先定范围再算距离）
  const d = dims().filter((x) => x.key !== 'vib');
  const scope2 = computeScope(RECORDS, d, { excludeFaulty: true });
  assert.ok(scope2.eligible.includes('R13'));
});

test('可参与范围：故障采集记录按开关排除', () => {
  assert.ok(!setup({ excludeFaulty: true }).scope.eligible.includes('R14'));
  assert.ok(setup({ excludeFaulty: false }).scope.eligible.includes('R14'));
});

test('血缘保留：坐标相同、来源不同的记录不去重，距离为 0 但各自独立', () => {
  const { scope, dist } = setup();
  assert.ok(scope.eligible.includes('R15') && scope.eligible.includes('R16'));
  const i = dist.ids.indexOf('R15');
  const j = dist.ids.indexOf('R16');
  assert.equal(dist.matrix[i][j], 0);
  // 类型约束按条计数：R15 是泵、R16 是风机，互不能顶替
  assert.notEqual(typeOf.R15, typeOf.R16);
});

test('距离表：对称、对角为 0、数值与手算一致（业务尺度归一化）', () => {
  const { dist } = setup();
  const n = dist.ids.length;
  for (let i = 0; i < n; i++) {
    assert.equal(dist.matrix[i][i], 0);
    for (let j = 0; j < n; j++) {
      assert.ok(Math.abs(dist.matrix[i][j] - dist.matrix[j][i]) < 1e-12);
    }
  }
  // R01(2950,78,4.2,0.82) vs R02(2880,81,4.6,0.85)，尺度 3000/120/12/10
  const i = dist.ids.indexOf('R01');
  const j = dist.ids.indexOf('R02');
  const expect = Math.hypot(70 / 3000, -3 / 120, -0.4 / 12, -0.03 / 10);
  assert.ok(Math.abs(dist.matrix[i][j] - expect) < 1e-12);
});

test('尺度进入距离：修改业务尺度后距离表必须变化', () => {
  const { scope, d } = setup();
  const d1 = computeDistanceMatrix(recordsById, scope.eligible, d);
  const d2cfg = d.map((x) => (x.key === 'rpm' ? { ...x, scale: 1500 } : x));
  const d2 = computeDistanceMatrix(recordsById, scope.eligible, d2cfg);
  const i = d1.ids.indexOf('R01');
  const j = d1.ids.indexOf('R02');
  assert.notEqual(d1.matrix[i][j], d2.matrix[i][j]);
});

test('无约束贪心满足 2-近似保证，且精确枚举不差于贪心', () => {
  const { dist, candidates } = setup();
  for (const k of [2, 3, 4, 5]) {
    const g = farthestGreedy(dist, candidates, k, { typeOf });
    const e = exactSearch(dist, candidates, k, { typeOf });
    const ga = assignAll(dist, g);
    assert.ok(ga.radius <= 2 * e.radius + 1e-9, `k=${k} 贪心超出 2 倍最优`);
    assert.ok(e.radius <= ga.radius + 1e-9, `k=${k} 精确应不差于贪心`);
  }
});

test('精确枚举与独立暴力实现结果一致（含必选/名额/禁选约束）', () => {
  const { dist, scope } = setup();
  const banned = ['R05'];
  const candidates = scope.eligible.filter((id) => !banned.includes(id));
  const opts = { pinned: ['R03'], quotas: { 压缩机: 1, 风机: 1 }, typeOf };
  const e = exactSearch(dist, candidates, 4, opts);
  const bf = bruteForce(dist, candidates, 4, opts);
  assert.ok(Math.abs(e.radius - bf) < 1e-9);
  // 约束真正进入选择结果
  assert.ok(e.selected.includes('R03'), '必选样本必须入选');
  assert.ok(!e.selected.includes('R05'), '禁选记录不得入选');
  const types = e.selected.map((s) => typeOf[s]);
  assert.ok(types.filter((t) => t === '压缩机').length >= 1);
  assert.ok(types.filter((t) => t === '风机').length >= 1);
});

test('约束贪心同样满足必选与名额（约束进入贪心选择过程）', () => {
  const { dist, candidates } = setup();
  const opts = { pinned: ['R03'], quotas: { 压缩机: 1, 风机: 1 }, typeOf };
  const g = farthestGreedy(dist, candidates, 4, opts);
  assert.ok(g.includes('R03'));
  const types = g.map((s) => typeOf[s]);
  assert.ok(types.filter((t) => t === '压缩机').length >= 1);
  assert.ok(types.filter((t) => t === '风机').length >= 1);
});

test('血缘与名额联动：坐标相同的泵记录不能顶替风机名额', () => {
  const { dist, candidates } = setup();
  // 必选 R15（泵，坐标与 R16 相同），风机名额 1 —— 若去重丢血缘会误判名额已满足
  const opts = { pinned: ['R15'], quotas: { 风机: 1 }, typeOf };
  const e = exactSearch(dist, candidates, 3, opts);
  assert.ok(e.selected.includes('R15'));
  assert.ok(
    e.selected.some((s) => typeOf[s] === '风机'),
    '风机名额必须由真正的风机记录满足',
  );
  const g = farthestGreedy(dist, candidates, 3, opts);
  assert.ok(g.some((s) => typeOf[s] === '风机'));
});

test('分配与半径：每条记录归属最近代表点，半径为最大归属距离', () => {
  const { dist, candidates } = setup();
  const sel = farthestGreedy(dist, candidates, 4, { typeOf });
  const a = assignAll(dist, sel);
  const idx = new Map(dist.ids.map((id, i) => [id, i]));
  let maxD = 0;
  for (const p of dist.ids) {
    let m = Infinity;
    for (const s of sel) m = Math.min(m, dist.matrix[idx.get(p)][idx.get(s)]);
    assert.ok(Math.abs(a.dist[p] - m) < 1e-9, `${p} 的归属距离应等于最近代表点距离`);
    assert.equal(dist.matrix[idx.get(p)][idx.get(a.assign[p])], a.dist[p]);
    maxD = Math.max(maxD, m);
  }
  assert.ok(Math.abs(a.radius - maxD) < 1e-9);
  assert.ok(Math.abs(a.dist[a.worst] - a.radius) < 1e-9, '被遗漏最严重记录的距离即半径');
  // 覆盖清单完整且不重复
  const all = Object.values(a.coveredBy).flat().sort();
  assert.deepEqual(all, dist.ids.slice().sort());
});

test('贪心确定性：同一输入两次运行结果一致', () => {
  const { dist, candidates } = setup();
  const a = farthestGreedy(dist, candidates, 4, { typeOf });
  const b = farthestGreedy(dist, candidates, 4, { typeOf });
  assert.deepEqual(a, b);
});

test('精确枚举在候选超过 18 条时关闭', () => {
  const { dist } = setup();
  const many = Array.from({ length: EXACT_MAX_N + 1 }, (_, i) => `X${i}`);
  assert.equal(exactSearch(dist, many, 3, { typeOf }), null);
  assert.ok(exactSearch(dist, dist.ids, 3, { typeOf }) !== null, '18 条以内必须可枚举核对');
});

test('可行性检查：名额合计超 k、必选超 k、必选不在范围内均被拦截', () => {
  const { candidates } = setup();
  assert.ok(checkFeasibility({ k: 2, candidates, pinned: [], quotas: { 泵: 2, 风机: 1 }, typeOf }).length > 0);
  assert.ok(checkFeasibility({ k: 1, candidates, pinned: ['R01', 'R02'], quotas: {}, typeOf }).length > 0);
  assert.ok(
    checkFeasibility({ k: 3, candidates, pinned: ['R13'], quotas: {}, typeOf }).some((p) => p.includes('R13')),
    'R13 缺失维度不在范围内，必选它必须报错',
  );
  assert.equal(checkFeasibility({ k: 4, candidates, pinned: [], quotas: { 压缩机: 1 }, typeOf }).length, 0);
});

test('无约束判定：任一约束（必选/名额/禁选）生效即不再适用 2-近似保证', () => {
  assert.ok(isUnconstrained({ pinned: [], quotas: {}, banned: [] }));
  assert.ok(!isUnconstrained({ pinned: ['R01'], quotas: {}, banned: [] }));
  assert.ok(!isUnconstrained({ pinned: [], quotas: { 泵: 1 }, banned: [] }));
  assert.ok(!isUnconstrained({ pinned: [], quotas: {}, banned: ['R01'] }));
});

test('导出：归属 CSV 覆盖每条记录，选中 CSV 覆盖两种方法的代表点', () => {
  const { dist, candidates } = setup();
  const g = farthestGreedy(dist, candidates, 4, { typeOf });
  const e = exactSearch(dist, candidates, 4, { typeOf });
  const ga = assignAll(dist, g);
  const ea = assignAll(dist, e.selected);
  const rows = [['record_id', 'greedy_rep', 'greedy_dist', 'exact_rep', 'exact_dist']];
  for (const r of RECORDS) {
    rows.push([r.id, ga.assign[r.id] ?? '', ga.dist[r.id]?.toFixed(6) ?? '', ea.assign[r.id] ?? '', ea.dist[r.id]?.toFixed(6) ?? '']);
  }
  const csv = toCSV(rows);
  assert.equal(csv.trim().split('\n').length, RECORDS.length + 1);
  assert.ok(csv.includes('R16'), '血缘重复记录也必须出现在导出中');
  const selRows = [['method', 'rep_id']];
  for (const s of g) selRows.push(['greedy', s]);
  for (const s of e.selected) selRows.push(['exact', s]);
  const selCsv = toCSV(selRows);
  assert.equal(selCsv.trim().split('\n').length, 1 + g.length + e.selected.length);
});

test('数据集规模：可参选记录不超过 18 条，保证页面可枚举核对', () => {
  const { scope } = setup();
  assert.ok(scope.eligible.length <= EXACT_MAX_N);
  assert.ok(DEVICE_TYPES.length === 3);
});
