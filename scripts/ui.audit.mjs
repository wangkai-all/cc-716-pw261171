// ui.audit.mjs — 散点图几何审计：边界、标签碰撞、命中目标、覆盖连线
// 运行：node test/ui.audit.mjs（需先 npm install 安装 devDependency jsdom）
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url).pathname;
const html = readFileSync(ROOT + 'index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/' });
globalThis.document = dom.window.document;
await import(new URL('../src/app.js', import.meta.url));

const $ = (s) => dom.window.document.querySelector(s);
const $$ = (s) => [...dom.window.document.querySelectorAll(s)];
let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`✔ ${name}`);
  else { failures++; console.error(`✘ ${name} ${extra}`); }
};

const W = 680, H = 420;
const svg = $('#scatter');

// 1. 所有几何在 viewBox 内
const outOfBounds = [];
for (const el of svg.children) {
  const nums = ['cx', 'cy', 'x', 'y', 'x1', 'y1', 'x2', 'y2']
    .map((a) => el.getAttribute(a))
    .filter((v) => v !== null)
    .map(Number);
  for (const v of nums) {
    if (v < -20 || v > Math.max(W, H) + 20) outOfBounds.push(`${el.tagName}=${v}`);
  }
}
check('全部几何在 viewBox 内（含文本基线余量）', outOfBounds.length === 0, outOfBounds.join(','));

// 2. 代表点标签不溢出右缘，且互不重叠（估算字宽 6.4px/char @11px）
const repLabels = $$('#scatter text').filter((t) => /^R\d{2}$/.test(t.textContent));
check('代表点有直接标注（4 代表点 + 被遗漏最严重）', repLabels.length >= 4, `got ${repLabels.length}`);
const boxes = repLabels.map((t) => {
  const x = Number(t.getAttribute('x'));
  const y = Number(t.getAttribute('y'));
  return { id: t.textContent, x0: x, x1: x + t.textContent.length * 6.4, y0: y - 11, y1: y + 2 };
});
check('标签不溢出右缘', boxes.every((b) => b.x1 <= W - 4), JSON.stringify(boxes.map((b) => b.x1)));
let overlap = false;
for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i];
    const b = boxes[j];
    if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) overlap = `${a.id}~${b.id}`;
  }
}
check('代表点标签互不重叠', overlap === false, String(overlap));

// 3. 命中目标 ≥ 24px（r=12）
const hits = $$('#scatter circle[r="12"]');
check('每个数据点都有 24px 命中圆', hits.length >= 14, `got ${hits.length}`);

// 4. 数据点半径 5（10px ≥ 8px 规范）且带 2px 表面色环
const dots = $$('#scatter circle[r="5"]');
check('数据点为 10px 且带表面色环', dots.length === 14 && dots.every((c) => c.getAttribute('stroke-width') === '2'));

// 5. 点击代表点 → 覆盖连线出现
const linesBefore = $$('#scatter line').length;
const repHit = hits.find((c) => c.getAttribute('aria-label').includes('代表点'));
repHit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
check('展开代表点后出现覆盖连线', $$('#scatter line').length > linesBefore);
check('覆盖面板与连线同步', !$('#coverage-panel').hidden);

// 6. 被遗漏最严重记录有状态菱形标记
check('被遗漏最严重记录有菱形标记', $$('#scatter path').length >= 1);

// 7. 精确半径 ≤ 贪心半径（枚举核对关系）
const g = parseFloat($('#result-greedy .radius').textContent);
const e = parseFloat($('#result-exact .radius').textContent);
check('精确半径 ≤ 贪心半径', e <= g + 1e-9, `greedy=${g} exact=${e}`);

// 8. 轴标题说明归一化（尺度可见）
const axisTexts = $$('#scatter text').map((t) => t.textContent).join(' ');
check('轴标题含业务尺度', axisTexts.includes('÷ 尺度'));

console.log(failures === 0 ? '\nAUDIT_OK' : `\nAUDIT_FAILED (${failures})`);
process.exit(failures ? 1 : 0);
