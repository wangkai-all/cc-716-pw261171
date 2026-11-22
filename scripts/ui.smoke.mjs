// ui.smoke.mjs — 用 jsdom 加载真实页面与 app.js，模拟用户操作做端到端冒烟测试
// 运行：node test/ui.smoke.mjs（需先 npm install 安装 devDependency jsdom）
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const ROOT = new URL('..', import.meta.url).pathname;
const html = readFileSync(ROOT + 'index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/' });

globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;

await import(new URL('../src/app.js', import.meta.url));

const $ = (sel) => dom.window.document.querySelector(sel);
const $$ = (sel) => [...dom.window.document.querySelectorAll(sel)];
let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`✔ ${name}`);
  else {
    failures++;
    console.error(`✘ ${name} ${extra}`);
  }
}
const fire = (el, type) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));

/* ---- 初始渲染 ---- */
check('维度表 4 行', $$('#dim-rows tr').length === 4);
check('可参与 14 条（R13 缺维度、R14 故障被排除）', $('#scope-summary').textContent.includes('可参与 14 条'));
check('排除原因展示缺失维度与故障', $('#scope-summary').textContent.includes('缺失维度') && $('#scope-summary').textContent.includes('故障采集'));
check('贪心半径为数值', /^0\.\d{3}$/.test($('#result-greedy .radius').textContent.trim()));
check('精确半径为数值', /^0\.\d{3}$/.test($('#result-exact .radius').textContent.trim()));
check('精确卡片展示枚举组合数', $('#result-exact').textContent.includes('已枚举'));
check('被遗漏最严重记录已展示', $('#result-greedy .worst').textContent.includes('被遗漏最严重：R'));
check('无约束时 2-近似保证徽标出现', $('#result-greedy .badge.ok') !== null);
check('枚举核对对比行出现', $('#compare-line').textContent.includes('枚举核对'));
check('记录表 16 行（血缘重复记录保留）', $$('#records-body tr').length === 16);
check('R15 与 R16 都在表中', $('#records-body').textContent.includes('R15') && $('#records-body').textContent.includes('R16'));
check('距离表为 14×14', $$('#dist-matrix tbody tr').length === 14 && $$('#dist-matrix thead th').length === 15);
check('散点图有数据点', $$('#scatter circle').length >= 14);
check('散点图有代表点外环', $$('#scatter circle[stroke="#0b0b0b"]').length === 4);
check('图例包含 3 个设备类型', $('#legend').textContent.includes('泵') && $('#legend').textContent.includes('压缩机'));
check('导出按钮可用', !$('#export-selected').disabled);

const radiusBefore = $('#result-greedy .radius').textContent;

/* ---- 交互 1：修改业务尺度 → 全链路同步重算 ---- */
const scaleInput = $('#dim-rows tr:first-child input[type="number"]');
scaleInput.value = '300';
fire(scaleInput, 'input');
check('修改尺度后半径重算变化', $('#result-greedy .radius').textContent !== radiusBefore,
  `(before=${radiusBefore} after=${$('#result-greedy .radius').textContent})`);
scaleInput.value = '3000';
fire(scaleInput, 'input');
check('尺度改回后半径复原', $('#result-greedy .radius').textContent === radiusBefore);

/* ---- 交互 2：类型名额约束 → 保证提示出现、约束进入结果 ---- */
const quotaInput = $$('#quota-inputs input')[2]; // 压缩机
quotaInput.value = '2';
fire(quotaInput, 'input');
check('名额约束后贪心保证徽标变为警告', $('#result-greedy .badge.warn') !== null);
check('名额约束后顶部出现告警', $('#alerts .alert.warn') !== null);
check('约束后仍选出 4 个代表点', $$('#result-greedy .rep-chip').length === 4);
quotaInput.value = '0';
fire(quotaInput, 'input');
check('名额取消后保证徽标恢复', $('#result-greedy .badge.ok') !== null);

/* ---- 交互 3：排除一个代表点 → 分配与半径同步重算 ---- */
const banBtn = $('#result-greedy .rep-chip .ban');
banBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
check('禁选代表点后出现约束告警', $('#alerts .alert.warn') !== null);
check('禁选后记录表出现禁选标记', $('#records-body').textContent.includes('禁选'));
const unbanBtn = $$('#records-body button').find((b) => b.textContent === '取消禁选');
unbanBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
check('取消禁选后恢复无约束状态', $('#alerts .alert.warn') === null);

/* ---- 交互 4：点击散点图代表点 → 展开覆盖记录 ---- */
const repHit = $$('#scatter circle[role="button"]').find((c) => c.getAttribute('aria-label').includes('代表点'));
repHit.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
check('点击代表点后覆盖面板展开', !$('#coverage-panel').hidden);
check('覆盖面板列出记录与距离', $$('#coverage-panel tbody tr').length >= 1 && $('#coverage-panel').textContent.includes('距离'));

/* ---- 交互 5：必选样本约束 ---- */
const pinR12 = $$('#pin-list label').find((l) => l.textContent.includes('R12')).querySelector('input');
pinR12.click();
check('必选 R12 后进入贪心选择', $$('#result-greedy .rep-chip').some((c) => c.textContent.includes('R12')));
check('必选 R12 后进入精确选择', $$('#result-exact .rep-chip').some((c) => c.textContent.includes('R12')));
pinR12.click();

/* ---- 交互 6：不可行约束 → 明确报错而不是静默 ---- */
const kInput = $('#k-input');
kInput.value = '2';
fire(kInput, 'input');
const quotaPump = $$('#quota-inputs input')[0];
quotaPump.value = '3';
fire(quotaPump, 'input');
check('名额合计超 k 时报错且不出结果', $('#alerts .alert.error') !== null && $('#result-greedy .radius') === null);
check('不可行时导出按钮禁用', $('#export-selected').disabled);
quotaPump.value = '0';
fire(quotaPump, 'input');
kInput.value = '4';
fire(kInput, 'input');
check('恢复可行后结果回归', $('#result-greedy .radius') !== null);

/* ---- 交互 7：切换到精确方法视图 ---- */
const exactRadio = $$('#plot-controls input[name="method"]')[1];
exactRadio.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
check('切换到精确视图后仍有代表点外环', $$('#scatter circle[stroke="#0b0b0b"]').length === 4);

console.log(failures === 0 ? '\nSMOKE_OK' : `\nSMOKE_FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
