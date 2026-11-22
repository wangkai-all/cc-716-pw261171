// app.js — 页面状态与渲染。任何输入变化都走同一条重算管线：
// 维度尺度 → 可参与范围 → 完整距离表 → 选择（贪心/精确）→ 分配与半径 → 全量重绘。
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
} from './core.js';
import { DIMENSIONS, RECORDS, DEVICE_TYPES } from './data.js';

const recordsById = Object.fromEntries(RECORDS.map((r) => [r.id, r]));
const typeOf = Object.fromEntries(RECORDS.map((r) => [r.id, r.deviceType]));

// 固定顺序的分类配色（散点 all-pairs 校验通过的前三槽）
const TYPE_COLORS = { 泵: '#2a78d6', 风机: '#eb6834', 压缩机: '#1baf7a' };
const INK = '#0b0b0b';
const INK2 = '#52514e';
const MUTED = '#898781';
const GRID = '#e1e0d9';
const BASELINE = '#c3c2b7';
const SURFACE = '#fcfcfb';
const CRITICAL = '#d03b3b';

const state = {
  dims: DIMENSIONS.map((d) => ({ ...d })),
  k: 4,
  excludeFaulty: true,
  pinned: new Set(),
  banned: new Set(), // 禁选为代表点（仍被覆盖）
  quotas: Object.fromEntries(DEVICE_TYPES.map((t) => [t, 0])),
  plotMethod: 'greedy',
  xDim: 'rpm',
  yDim: 'temp',
  expandedRep: null,
};

let lastModel = null;

/* ---------- DOM 工具 ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else if (k === 'disabled') el.disabled = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const fmt = (v, n = 4) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(n));

/* ---------- 重算管线 ---------- */

function recompute() {
  const dims = activeDimensions(state.dims);
  const scope = computeScope(RECORDS, dims, { excludeFaulty: state.excludeFaulty });
  const dist = computeDistanceMatrix(recordsById, scope.eligible, dims);
  const candidates = scope.eligible.filter((id) => !state.banned.has(id));

  const problems = [];
  if (dims.length === 0) problems.push('至少需要 1 个参与维度（勾选参与且尺度为正）');
  problems.push(
    ...checkFeasibility({
      k: state.k,
      candidates,
      pinned: [...state.pinned],
      quotas: state.quotas,
      typeOf,
    }),
  );

  const model = {
    dims,
    scope,
    dist,
    candidates,
    problems,
    unconstrained: isUnconstrained({
      pinned: [...state.pinned],
      quotas: state.quotas,
      banned: [...state.banned],
    }),
    greedy: null,
    greedyAssign: null,
    exact: null,
    exactAssign: null,
  };

  if (problems.length === 0) {
    const opts = { pinned: [...state.pinned], quotas: state.quotas, typeOf };
    const gsel = farthestGreedy(dist, candidates, state.k, opts);
    model.greedy = { selected: gsel };
    model.greedyAssign = assignAll(dist, gsel);
    const ex = exactSearch(dist, candidates, state.k, opts);
    if (ex === null) {
      model.exact = { disabled: true };
    } else if (ex.selected) {
      model.exact = ex;
      model.exactAssign = assignAll(dist, ex.selected);
    } else {
      model.exact = { ...ex, empty: true };
    }
  }

  // 精确结果不可用时，散点图方法回退为贪心
  if (state.plotMethod === 'exact' && !model.exactAssign) state.plotMethod = 'greedy';
  // 坐标轴维度失效时回退
  const keys = model.dims.map((d) => d.key);
  if (!keys.includes(state.xDim)) state.xDim = keys[0] ?? null;
  if (!keys.includes(state.yDim)) state.yDim = keys[1] ?? keys[0] ?? null;

  // 展开的代表点若已不在当前方法的选择中，收起
  const sel = currentSelection(model);
  if (state.expandedRep && (!sel || !sel.includes(state.expandedRep))) {
    state.expandedRep = null;
  }

  lastModel = model;
  renderAll(model);
}

function currentSelection(model) {
  if (state.plotMethod === 'exact' && model.exact && model.exact.selected) return model.exact.selected;
  if (state.plotMethod === 'exact') return null;
  return model.greedy ? model.greedy.selected : null;
}

function currentAssign(model) {
  if (state.plotMethod === 'exact' && model.exactAssign) return model.exactAssign;
  if (state.plotMethod === 'exact') return null;
  return model.greedyAssign;
}

/* ---------- 静态控件（只建一次，避免输入时丢焦点） ---------- */

function initControls() {
  // 维度表
  const dimRows = document.getElementById('dim-rows');
  for (const d of state.dims) {
    const scaleInput = h('input', {
      type: 'number', min: '0', step: 'any', value: d.scale,
      oninput: (e) => {
        const v = parseFloat(e.target.value);
        d.scale = Number.isFinite(v) ? v : NaN; // 非法尺度 → 维度退出计算
        recompute();
      },
    });
    const activeInput = h('input', {
      type: 'checkbox', checked: d.active,
      onchange: (e) => {
        d.active = e.target.checked;
        recompute();
      },
    });
    dimRows.append(
      h('tr', {},
        h('td', {}, activeInput),
        h('td', { text: d.label }),
        h('td', { text: d.unit }),
        h('td', {}, scaleInput),
      ),
    );
  }

  // k
  const kInput = document.getElementById('k-input');
  kInput.value = state.k;
  kInput.addEventListener('input', () => {
    const v = parseInt(kInput.value, 10);
    state.k = Number.isInteger(v) ? v : 0;
    recompute();
  });

  // 排除故障采集
  const exf = document.getElementById('exclude-faulty');
  exf.checked = state.excludeFaulty;
  exf.addEventListener('change', () => {
    state.excludeFaulty = exf.checked;
    recompute();
  });

  // 类型名额
  const quotaBox = document.getElementById('quota-inputs');
  for (const t of DEVICE_TYPES) {
    quotaBox.append(
      h('label', {},
        h('span', { text: `「${t}」≥` }),
        h('input', {
          type: 'number', min: '0', max: '18', step: '1', value: state.quotas[t],
          oninput: (e) => {
            const v = parseInt(e.target.value, 10);
            state.quotas[t] = Number.isInteger(v) && v >= 0 ? v : 0;
            recompute();
          },
        }),
      ),
    );
  }

  // 导出
  document.getElementById('export-selected').addEventListener('click', exportSelected);
  document.getElementById('export-assign').addEventListener('click', exportAssignments);
  document.getElementById('export-json').addEventListener('click', exportJSON);
}

/* ---------- 渲染 ---------- */

function renderAll(model) {
  renderPinList(model);
  renderScope(model);
  renderAlerts(model);
  renderResults(model);
  renderPlotControls(model);
  renderScatter(model);
  renderLegend(model);
  renderCoverage(model);
  renderRecordsTable(model);
  renderDistMatrix(model);
  const feasible = model.problems.length === 0;
  for (const id of ['export-selected', 'export-assign', 'export-json']) {
    document.getElementById(id).disabled = !feasible;
  }
}

function renderPinList(model) {
  const box = document.getElementById('pin-list');
  box.replaceChildren();
  const candSet = new Set(model.candidates);
  for (const r of RECORDS) {
    const selectable = candSet.has(r.id);
    const label = h('label', { class: selectable ? '' : 'disabled' },
      h('input', {
        type: 'checkbox',
        checked: state.pinned.has(r.id),
        disabled: !selectable && !state.pinned.has(r.id),
        onchange: (e) => {
          if (e.target.checked) {
            state.pinned.add(r.id);
            state.banned.delete(r.id); // 必选与禁选互斥
          } else {
            state.pinned.delete(r.id);
          }
          recompute();
        },
      }),
      `${r.id} ${r.deviceId}`,
    );
    if (!selectable) label.title = '不在可参选范围（缺失维度 / 故障已排除 / 被禁选）';
    box.append(label);
  }
}

function renderScope(model) {
  const box = document.getElementById('scope-summary');
  box.replaceChildren();
  box.append(
    h('p', { class: 'scope-count', text: `可参与 ${model.scope.eligible.length} 条 / 共 ${RECORDS.length} 条（可参选代表点 ${model.candidates.length} 条）` }),
  );
  if (model.scope.excluded.length > 0) {
    for (const e of model.scope.excluded) {
      box.append(h('span', { class: 'chip excluded', text: `${e.id}：${e.reasons.join('；')}` }));
    }
  } else {
    box.append(h('p', { class: 'hint', text: '无被排除记录。' }));
  }
}

function renderAlerts(model) {
  const box = document.getElementById('alerts');
  box.replaceChildren();
  if (model.problems.length > 0) {
    box.append(
      h('div', { class: 'alert error' },
        h('strong', { text: '⚠ 约束不可行，未进行选择：' }),
        h('ul', {}, model.problems.map((p) => h('li', { text: p }))),
      ),
    );
    return;
  }
  if (!model.unconstrained) {
    box.append(
      h('div', { class: 'alert warn', text: '⚠ 必选 / 名额 / 禁选约束已生效：贪心结果不再享有无约束情形的 2-近似保证，请以精确枚举半径核对。' }),
    );
  }
  if (model.exact && model.exact.disabled) {
    box.append(
      h('div', { class: 'alert info', text: `ℹ 可参选记录 ${model.candidates.length} 条，超过 ${EXACT_MAX_N} 条上限，精确枚举已关闭，仅显示贪心结果。` }),
    );
  }
}

function repChips(selected, assign, methodKey) {
  return h('div', { class: 'rep-chips' },
    selected.map((id) => {
      const r = recordsById[id];
      const n = assign ? assign.coveredBy[id].length : 0;
      return h('span', { class: 'rep-chip' },
        h('span', { class: 'dot', style: `background:${TYPE_COLORS[r.deviceType]}` }),
        h('button', {
          text: `${id}（覆盖 ${n}）`,
          style: 'border:none;background:none;padding:0;cursor:pointer;',
          title: '在散点图中展开其覆盖记录',
          onclick: () => {
            state.plotMethod = methodKey;
            state.expandedRep = state.expandedRep === id ? null : id;
            renderAll(lastModel);
          },
        }),
        h('button', {
          class: 'ban', text: '×', title: '排除此代表点（禁选后重算）',
          onclick: () => banRecord(id),
        }),
      );
    }),
  );
}

function banRecord(id) {
  state.banned.add(id);
  state.pinned.delete(id); // 禁选与必选互斥，自动解除必选
  if (state.expandedRep === id) state.expandedRep = null;
  recompute();
}

function renderResults(model) {
  // 贪心卡片
  const g = document.querySelector('#result-greedy .result-body');
  g.replaceChildren();
  if (model.problems.length > 0) {
    g.append(h('p', { class: 'hint', text: '约束不可行，无结果。' }));
  } else {
    const a = model.greedyAssign;
    g.append(
      h('div', { class: 'radius-label', text: '最坏覆盖半径（归一化距离）' }),
      h('div', { class: 'radius', text: fmt(a.radius, 3) }),
      h('p', { class: 'worst', text: `被遗漏最严重：${a.worst}（${recordsById[a.worst].deviceId} · ${recordsById[a.worst].deviceType}），距离 ${fmt(a.dist[a.worst])}` }),
      model.unconstrained
        ? h('span', { class: 'badge ok', text: '✓ 无约束：2-近似保证适用（半径 ≤ 2 × 最优）' })
        : h('span', { class: 'badge warn', text: '⚠ 约束生效：2-近似保证不再适用' }),
      h('div', { class: 'radius-label', text: `选中的 ${model.greedy.selected.length} 个代表点：` }),
      repChips(model.greedy.selected, a, 'greedy'),
    );
  }

  // 精确卡片
  const e = document.querySelector('#result-exact .result-body');
  e.replaceChildren();
  if (model.problems.length > 0) {
    e.append(h('p', { class: 'hint', text: '约束不可行，无结果。' }));
  } else if (model.exact.disabled) {
    e.append(
      h('p', { class: 'hint', text: `可参选记录超过 ${EXACT_MAX_N} 条，枚举关闭。` }),
    );
  } else if (model.exact.empty) {
    e.append(h('p', { class: 'hint', text: '无可行子集。' }));
  } else {
    const a = model.exactAssign;
    e.append(
      h('div', { class: 'radius-label', text: '最坏覆盖半径（受约束最优）' }),
      h('div', { class: 'radius', text: fmt(a.radius, 3) }),
      h('p', { class: 'worst', text: `被遗漏最严重：${a.worst}（${recordsById[a.worst].deviceId} · ${recordsById[a.worst].deviceType}），距离 ${fmt(a.dist[a.worst])}` }),
      h('span', { class: 'badge info', text: `ℹ 已枚举 ${model.exact.combos} 个组合，其中满足约束 ${model.exact.feasibleSubsets} 个` }),
      h('div', { class: 'radius-label', text: `选中的 ${model.exact.selected.length} 个代表点：` }),
      repChips(model.exact.selected, a, 'exact'),
    );
  }

  // 对比行
  const line = document.getElementById('compare-line');
  line.replaceChildren();
  if (model.problems.length === 0 && model.exactAssign && model.greedyAssign) {
    const ratio = model.greedyAssign.radius / (model.exactAssign.radius || 1e-12);
    const same = Math.abs(model.greedyAssign.radius - model.exactAssign.radius) < 1e-9;
    line.append(
      `枚举核对：贪心半径 ${fmt(model.greedyAssign.radius, 3)}，精确最优 ${fmt(model.exactAssign.radius, 3)} —— `,
      h('strong', { text: same ? '贪心本轮达到最优' : `贪心为最优的 ${ratio.toFixed(2)} 倍` }),
    );
  }
}

function renderPlotControls(model) {
  const box = document.getElementById('plot-controls');
  box.replaceChildren();
  const exactOk = model.exactAssign != null;

  const methodBox = h('span', {}, '结果：',
    h('label', {},
      h('input', {
        type: 'radio', name: 'method', checked: state.plotMethod === 'greedy',
        onchange: () => { state.plotMethod = 'greedy'; renderAll(lastModel); },
      }),
      '贪心'),
    h('label', {},
      h('input', {
        type: 'radio', name: 'method', checked: state.plotMethod === 'exact', disabled: !exactOk,
        onchange: () => { state.plotMethod = 'exact'; renderAll(lastModel); },
      }),
      '精确'),
  );

  const dimOptions = (selected, onchange) => {
    const sel = h('select', { onchange: (e) => onchange(e.target.value) });
    for (const d of model.dims) {
      const opt = h('option', { value: d.key, text: `${d.label}（${d.unit}）` });
      if (d.key === selected) opt.selected = true;
      sel.append(opt);
    }
    return sel;
  };
  box.append(
    methodBox,
    h('label', {}, 'X 轴', dimOptions(state.xDim, (v) => { state.xDim = v; renderAll(lastModel); })),
    h('label', {}, 'Y 轴', dimOptions(state.yDim, (v) => { state.yDim = v; renderAll(lastModel); })),
  );
}

function plottablePoints(model) {
  const xk = state.xDim;
  const yk = state.yDim;
  const xi = model.dims.findIndex((d) => d.key === xk);
  const yi = model.dims.findIndex((d) => d.key === yk);
  if (xi < 0 || yi < 0) return null;
  const eligible = model.dist.ids.map((id) => ({
    id,
    x: model.dist.coords[id][xi],
    y: model.dist.coords[id][yi],
    excluded: false,
  }));
  const xDim = model.dims[xi];
  const yDim = model.dims[yi];
  const excluded = model.scope.excluded
    .map((e) => recordsById[e.id])
    .filter((r) => Number.isFinite(r.values[xk]) && Number.isFinite(r.values[yk]))
    .map((r) => ({ id: r.id, x: r.values[xk] / xDim.scale, y: r.values[yk] / yDim.scale, excluded: true }));
  return { eligible, excluded, xDim, yDim };
}

function renderScatter(model) {
  const svg = document.getElementById('scatter');
  svg.replaceChildren();
  hideTooltip();
  const W = 680;
  const H = 420;
  const ML = 56;
  const MR = 18;
  const MT = 18;
  const MB = 46;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const pp = plottablePoints(model);
  if (!pp) {
    svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', fill: MUTED, 'font-size': 13 }));
    svg.lastChild.textContent = '无可用维度';
    return;
  }
  const all = [...pp.eligible, ...pp.excluded];
  if (all.length === 0) return;

  const pad = (lo, hi) => {
    const span = hi - lo || 0.1;
    return [lo - span * 0.08, hi + span * 0.08];
  };
  const [x0, x1] = pad(Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x)));
  const [y0, y1] = pad(Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.y)));
  const X = (v) => ML + ((v - x0) / (x1 - x0)) * (W - ML - MR);
  const Y = (v) => H - MB - ((v - y0) / (y1 - y0)) * (H - MT - MB);

  // 网格与刻度
  for (let i = 0; i <= 4; i++) {
    const tx = x0 + ((x1 - x0) * i) / 4;
    const ty = y0 + ((y1 - y0) * i) / 4;
    svg.append(s('line', { x1: X(tx), y1: MT, x2: X(tx), y2: H - MB, stroke: GRID, 'stroke-width': 1 }));
    svg.append(s('line', { x1: ML, y1: Y(ty), x2: W - MR, y2: Y(ty), stroke: GRID, 'stroke-width': 1 }));
    const xl = s('text', { x: X(tx), y: H - MB + 16, 'text-anchor': 'middle', fill: MUTED, 'font-size': 10 });
    xl.textContent = tx.toFixed(2);
    svg.append(xl);
    const yl = s('text', { x: ML - 6, y: Y(ty) + 3, 'text-anchor': 'end', fill: MUTED, 'font-size': 10 });
    yl.textContent = ty.toFixed(2);
    svg.append(yl);
  }
  svg.append(s('line', { x1: ML, y1: H - MB, x2: W - MR, y2: H - MB, stroke: BASELINE, 'stroke-width': 1 }));
  svg.append(s('line', { x1: ML, y1: MT, x2: ML, y2: H - MB, stroke: BASELINE, 'stroke-width': 1 }));
  const xt = s('text', { x: (ML + W - MR) / 2, y: H - 6, 'text-anchor': 'middle', fill: INK2, 'font-size': 11 });
  xt.textContent = `${pp.xDim.label}（${pp.xDim.unit}）÷ 尺度 ${pp.xDim.scale}`;
  svg.append(xt);
  const yt = s('text', { x: 14, y: (MT + H - MB) / 2, 'text-anchor': 'middle', fill: INK2, 'font-size': 11, transform: `rotate(-90 14 ${(MT + H - MB) / 2})` });
  yt.textContent = `${pp.yDim.label}（${pp.yDim.unit}）÷ 尺度 ${pp.yDim.scale}`;
  svg.append(yt);

  const sel = currentSelection(model) ?? [];
  const assign = currentAssign(model);
  const posOf = new Map(pp.eligible.map((p) => [p.id, p]));

  // 覆盖连线（展开的代表点）
  if (state.expandedRep && assign && sel.includes(state.expandedRep)) {
    const rp = posOf.get(state.expandedRep);
    if (rp) {
      for (const cid of assign.coveredBy[state.expandedRep]) {
        if (cid === state.expandedRep) continue;
        const cp = posOf.get(cid);
        if (!cp) continue;
        svg.append(s('line', {
          x1: X(rp.x), y1: Y(rp.y), x2: X(cp.x), y2: Y(cp.y),
          stroke: INK2, 'stroke-width': 1, 'stroke-opacity': 0.35,
        }));
      }
    }
  }

  // 已排除记录（灰点）
  for (const p of pp.excluded) {
    svg.append(s('circle', { cx: X(p.x), cy: Y(p.y), r: 4, fill: BASELINE, 'fill-opacity': 0.7 }));
  }

  // 可参与记录
  for (const p of pp.eligible) {
    const r = recordsById[p.id];
    svg.append(s('circle', {
      cx: X(p.x), cy: Y(p.y), r: 5,
      fill: TYPE_COLORS[r.deviceType],
      stroke: SURFACE, 'stroke-width': 2, // 2px 表面色环
    }));
  }

  // 代表点外环 + 直接标注（只标代表点与被遗漏最严重记录）
  for (const id of sel) {
    const p = posOf.get(id);
    if (!p) continue;
    svg.append(s('circle', {
      cx: X(p.x), cy: Y(p.y), r: 9.5, fill: 'none',
      stroke: INK, 'stroke-width': 2,
    }));
    const lab = s('text', { x: X(p.x) + 12, y: Y(p.y) - 10, fill: INK2, 'font-size': 11 });
    lab.textContent = id;
    svg.append(lab);
  }

  // 被遗漏最严重记录（状态色菱形 + 图例说明，不靠颜色单独表意）
  if (assign && assign.worst) {
    const p = posOf.get(assign.worst);
    if (p) {
      const cx = X(p.x);
      const cy = Y(p.y);
      const d = 8;
      svg.append(s('path', {
        d: `M ${cx} ${cy - d} L ${cx + d} ${cy} L ${cx} ${cy + d} L ${cx - d} ${cy} Z`,
        fill: 'none', stroke: CRITICAL, 'stroke-width': 2,
      }));
      if (!sel.includes(assign.worst)) {
        const lab = s('text', { x: cx + 12, y: cy - 10, fill: INK2, 'font-size': 11 });
        lab.textContent = assign.worst;
        svg.append(lab);
      }
    }
  }

  // 命中层（24px 透明命中圆，悬停/聚焦出提示，代表点可点击展开）
  for (const p of [...pp.eligible, ...pp.excluded]) {
    const isRep = sel.includes(p.id);
    const px = X(p.x);
    const py = Y(p.y);
    const hit = s('circle', {
      cx: px, cy: py, r: 12,
      fill: '#000000', 'fill-opacity': '0', 'pointer-events': 'all',
      tabindex: '0', role: 'button',
      'aria-label': `${p.id}${isRep ? '（代表点，回车展开覆盖）' : ''}`,
    });
    const show = () => showTooltip(model, p, px, py);
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('pointerleave', hideTooltip);
    hit.addEventListener('blur', hideTooltip);
    if (isRep) {
      const toggle = () => {
        state.expandedRep = state.expandedRep === p.id ? null : p.id;
        renderAll(lastModel);
      };
      hit.addEventListener('click', toggle);
      hit.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      hit.style.cursor = 'pointer';
    }
    svg.append(hit);
  }
}

function showTooltip(model, p, px, py) {
  const tip = document.getElementById('tooltip');
  const r = recordsById[p.id];
  tip.replaceChildren();
  tip.append(h('div', { class: 't-title', text: `${r.id} · ${r.deviceType} · ${r.deviceId}（批次 ${r.batch}）` }));
  for (const d of model.dims) {
    const v = r.values[d.key];
    tip.append(h('div', { class: 't-row', text: `${d.label}：${Number.isFinite(v) ? v : '缺失'} ${d.unit}` }));
  }
  const status = [];
  const sel = currentSelection(model) ?? [];
  const assign = currentAssign(model);
  if (p.excluded) {
    const ex = model.scope.excluded.find((e) => e.id === p.id);
    status.push(`已排除：${ex ? ex.reasons.join('；') : ''}`);
  } else {
    if (sel.includes(p.id)) status.push(`代表点（${state.plotMethod === 'exact' ? '精确' : '贪心'}）`);
    if (state.pinned.has(p.id)) status.push('必选');
    if (state.banned.has(p.id)) status.push('禁选为代表点');
    if (assign && assign.assign[p.id]) {
      status.push(`归属 ${assign.assign[p.id]}，距离 ${fmt(assign.dist[p.id])}`);
    }
  }
  if (r.note) status.push(r.note);
  tip.append(h('div', { class: 't-row', text: status.join(' · ') || '—' }));

  // 定位在数据点旁（SVG 坐标 → 容器像素）
  const wrap = document.getElementById('plot-wrap');
  const svg = document.getElementById('scatter');
  const rect = svg.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  const cx = rect.left - wrapRect.left + (px / vb.width) * rect.width;
  const cy = rect.top - wrapRect.top + (py / vb.height) * rect.height;
  tip.hidden = false;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = cx + 14;
  let top = cy - th - 8;
  if (left + tw > wrapRect.width) left = cx - tw - 14;
  if (top < 0) top = cy + 16;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, top)}px`;
}

function hideTooltip() {
  document.getElementById('tooltip').hidden = true;
}

function renderLegend(model) {
  const box = document.getElementById('legend');
  box.replaceChildren();
  for (const t of DEVICE_TYPES) {
    const n = model.dist.ids.filter((id) => typeOf[id] === t).length;
    box.append(
      h('span', { class: 'item' },
        h('span', { class: 'swatch', style: `background:${TYPE_COLORS[t]}` }),
        `${t}（${n} 条）`),
    );
  }
  box.append(
    h('span', { class: 'item' }, h('span', { class: 'ring' }), '代表点'),
    h('span', { class: 'item' }, h('span', { class: 'diamond' }), '被遗漏最严重'),
    h('span', { class: 'item' }, h('span', { class: 'swatch grey' }), '已排除'),
  );
}

function renderCoverage(model) {
  const panel = document.getElementById('coverage-panel');
  panel.replaceChildren();
  const assign = currentAssign(model);
  const sel = currentSelection(model) ?? [];
  if (!state.expandedRep || !assign || !sel.includes(state.expandedRep)) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const id = state.expandedRep;
  const r = recordsById[id];
  const methodName = state.plotMethod === 'exact' ? '精确枚举' : '最远点贪心';
  const covered = assign.coveredBy[id].slice().sort((a, b) => assign.dist[b] - assign.dist[a]);
  panel.append(
    h('h3', { text: `代表点 ${id}（${r.deviceId} · ${r.deviceType}）覆盖 ${covered.length} 条记录 —— ${methodName}` }),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { text: '记录' }), h('th', { text: '设备' }), h('th', { text: '类型' }), h('th', { text: '距离' }))),
      h('tbody', {},
        covered.map((cid) => {
          const cr = recordsById[cid];
          return h('tr', {},
            h('td', { text: cid }),
            h('td', { text: cr.deviceId }),
            h('td', { text: cr.deviceType }),
            h('td', { text: fmt(assign.dist[cid]) }),
          );
        }),
      ),
    ),
    h('div', { class: 'panel-actions' },
      h('button', { text: '排除此代表点（禁选并重算）', onclick: () => banRecord(id) }),
      h('button', {
        text: '收起',
        onclick: () => { state.expandedRep = null; renderAll(lastModel); },
      }),
    ),
  );
}

function renderRecordsTable(model) {
  const head = document.getElementById('records-head');
  const body = document.getElementById('records-body');
  head.replaceChildren();
  body.replaceChildren();

  head.append(
    h('tr', {},
      h('th', { text: '记录' }),
      h('th', { text: '设备' }),
      h('th', { text: '类型' }),
      h('th', { text: '来源批次' }),
      h('th', { text: '状态' }),
      ...state.dims.map((d) => h('th', { text: `${d.label}(${d.unit})` })),
      h('th', { text: '贪心归属' }),
      h('th', { text: '精确归属' }),
      h('th', { text: '操作' }),
    ),
  );

  const eligibleSet = new Set(model.scope.eligible);
  const exclMap = new Map(model.scope.excluded.map((e) => [e.id, e.reasons.join('；')]));
  const gSel = model.greedy ? new Set(model.greedy.selected) : new Set();
  const eSel = model.exact && model.exact.selected ? new Set(model.exact.selected) : new Set();

  const cellAssign = (assign, sel, id) => {
    if (!eligibleSet.has(id)) return '—';
    if (!assign) return '—';
    const rep = assign.assign[id];
    return sel.has(id) ? `★ 自身` : `${rep} · ${fmt(assign.dist[id])}`;
  };

  for (const r of RECORDS) {
    const eligible = eligibleSet.has(r.id);
    const tags = [];
    if (r.faulty) tags.push(h('span', { class: 'tag faulty', text: '故障采集' }));
    if (state.pinned.has(r.id)) tags.push(h('span', { class: 'tag pin', text: '必选' }));
    if (state.banned.has(r.id)) tags.push(h('span', { class: 'tag ban', text: '禁选' }));
    if (!eligible) tags.push(h('span', { class: 'tag', text: `已排除：${exclMap.get(r.id)}` }));
    if (tags.length === 0) tags.push(h('span', { class: 'tag', text: '参与' }));

    const banned = state.banned.has(r.id);
    const row = h('tr', {
      class: [eligible ? '' : 'excluded-row', gSel.has(r.id) || eSel.has(r.id) ? 'rep-row' : ''].filter(Boolean).join(' '),
    },
      h('td', { text: r.id }),
      h('td', { text: r.deviceId }),
      h('td', { text: r.deviceType }),
      h('td', { text: r.batch }),
      h('td', {}, tags),
      ...state.dims.map((d) => h('td', { class: 'num', text: Number.isFinite(r.values[d.key]) ? String(r.values[d.key]) : '缺失' })),
      h('td', { text: cellAssign(model.greedyAssign, gSel, r.id) }),
      h('td', { text: cellAssign(model.exactAssign, eSel, r.id) }),
      h('td', {},
        eligible
          ? h('button', {
              text: banned ? '取消禁选' : '禁选',
              title: banned ? '恢复其代表点资格' : '仅取消代表点资格，记录仍被覆盖',
              onclick: () => {
                if (banned) {
                  state.banned.delete(r.id);
                  recompute();
                } else {
                  banRecord(r.id);
                }
              },
            })
          : null,
      ),
    );
    body.append(row);
  }
}

function renderDistMatrix(model) {
  const box = document.getElementById('dist-matrix');
  box.replaceChildren();
  const { ids, matrix } = model.dist;
  if (ids.length === 0) {
    box.append(h('p', { class: 'hint', text: '无可参与记录。' }));
    return;
  }
  const table = h('table', { class: 'matrix-table' });
  table.append(
    h('thead', {}, h('tr', {}, h('th', { text: '' }), ids.map((id) => h('th', { text: id })))),
  );
  const tbody = h('tbody', {});
  ids.forEach((id, i) => {
    tbody.append(
      h('tr', {},
        h('th', { text: id }),
        ids.map((_, j) =>
          h('td', { class: `num${i === j ? ' zero' : ''}`, text: matrix[i][j].toFixed(3) }),
        ),
      ),
    );
  });
  table.append(tbody);
  box.append(table);
}

/* ---------- 导出 ---------- */

function download(filename, text, mime = 'text/csv') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function dimValueCols() {
  return state.dims.map((d) => d.key);
}

function exportSelected() {
  const m = lastModel;
  if (!m || m.problems.length > 0) return;
  const keys = dimValueCols();
  const rows = [[
    'method', 'rep_id', 'device_id', 'device_type', 'batch',
    ...keys.map((k) => `value_${k}`),
    'covered_count', 'max_covered_dist',
  ]];
  const push = (method, selected, assign) => {
    for (const id of selected) {
      const r = recordsById[id];
      const covered = assign.coveredBy[id];
      const maxD = Math.max(...covered.map((c) => assign.dist[c]));
      rows.push([
        method, id, r.deviceId, r.deviceType, r.batch,
        ...keys.map((k) => (Number.isFinite(r.values[k]) ? r.values[k] : '')),
        covered.length, maxD.toFixed(6),
      ]);
    }
  };
  push('greedy', m.greedy.selected, m.greedyAssign);
  if (m.exactAssign) push('exact', m.exact.selected, m.exactAssign);
  download('representatives.csv', toCSV(rows));
}

function exportAssignments() {
  const m = lastModel;
  if (!m || m.problems.length > 0) return;
  const keys = dimValueCols();
  const rows = [[
    'record_id', 'device_id', 'device_type', 'batch', 'faulty',
    'eligible', 'excluded_reason',
    ...keys.map((k) => `value_${k}`),
    'greedy_rep', 'greedy_dist', 'exact_rep', 'exact_dist',
  ]];
  const exclMap = new Map(m.scope.excluded.map((e) => [e.id, e.reasons.join('；')]));
  const eligibleSet = new Set(m.scope.eligible);
  for (const r of RECORDS) {
    const eligible = eligibleSet.has(r.id);
    rows.push([
      r.id, r.deviceId, r.deviceType, r.batch, r.faulty ? '1' : '0',
      eligible ? '1' : '0', eligible ? '' : exclMap.get(r.id),
      ...keys.map((k) => (Number.isFinite(r.values[k]) ? r.values[k] : '')),
      eligible && m.greedyAssign ? m.greedyAssign.assign[r.id] : '',
      eligible && m.greedyAssign ? m.greedyAssign.dist[r.id].toFixed(6) : '',
      eligible && m.exactAssign ? m.exactAssign.assign[r.id] : '',
      eligible && m.exactAssign ? m.exactAssign.dist[r.id].toFixed(6) : '',
    ]);
  }
  download('assignments.csv', toCSV(rows));
}

function exportJSON() {
  const m = lastModel;
  if (!m || m.problems.length > 0) return;
  const pack = (selected, assign) => ({
    selected,
    radius: assign.radius,
    worst_record: assign.worst,
    assignments: Object.fromEntries(
      Object.entries(assign.assign).map(([id, rep]) => [id, { rep, dist: assign.dist[id] }]),
    ),
  });
  const payload = {
    generated_at: new Date().toISOString(),
    config: {
      dims: m.dims.map((d) => ({ key: d.key, label: d.label, unit: d.unit, scale: d.scale })),
      k: state.k,
      exclude_faulty: state.excludeFaulty,
      pinned: [...state.pinned],
      banned: [...state.banned],
      quotas: state.quotas,
    },
    scope: {
      eligible: m.scope.eligible,
      excluded: m.scope.excluded,
    },
    unconstrained: m.unconstrained,
    guarantee_note: m.unconstrained
      ? '无约束：贪心半径 ≤ 2 × 最优'
      : '约束生效：贪心 2-近似保证不适用，以精确枚举为准',
    greedy: pack(m.greedy.selected, m.greedyAssign),
    exact: m.exactAssign
      ? { ...pack(m.exact.selected, m.exactAssign), combos: m.exact.combos, feasible_subsets: m.exact.feasibleSubsets }
      : { disabled: true },
  };
  download('result.json', JSON.stringify(payload, null, 2), 'application/json');
}

/* ---------- 启动 ---------- */

initControls();
recompute();
