// data.js — 虚构设备工况数据集（仅用于演示，非真实采集）
//
// 5 台虚构设备、3 类设备类型、16 条多维工况记录。
// 特意包含：
//   - R13：振动维度缺失（传感器离线），用于演示「缺失维度先退出参与范围」；
//   - R14：故障采集记录，用于演示「排除故障采集」约束；
//   - R15 / R16：坐标完全相同但来源（设备、类型、批次）不同，
//     用于演示血缘保留 —— 不因去重丢掉设备类型约束。

export const DIMENSIONS = [
  { key: 'rpm', label: '转速', unit: 'rpm', scale: 3000, active: true },
  { key: 'temp', label: '温度', unit: '°C', scale: 120, active: true },
  { key: 'vib', label: '振动', unit: 'mm/s', scale: 12, active: true },
  { key: 'press', label: '压力', unit: 'MPa', scale: 10, active: true },
];

// 固定顺序 → 固定配色槽位（槽位 1/2/3，散点 all-pairs 校验通过）
export const DEVICE_TYPES = ['泵', '风机', '压缩机'];

export const RECORDS = [
  { id: 'R01', deviceId: 'P-01', deviceType: '泵', batch: '2026-11-A', faulty: false, note: '', values: { rpm: 2950, temp: 78, vib: 4.2, press: 0.82 } },
  { id: 'R02', deviceId: 'P-01', deviceType: '泵', batch: '2026-11-A', faulty: false, note: '', values: { rpm: 2880, temp: 81, vib: 4.6, press: 0.85 } },
  { id: 'R03', deviceId: 'P-02', deviceType: '泵', batch: '2026-11-A', faulty: false, note: '', values: { rpm: 3050, temp: 74, vib: 3.8, press: 0.78 } },
  { id: 'R04', deviceId: 'P-02', deviceType: '泵', batch: '2026-11-B', faulty: false, note: '', values: { rpm: 2900, temp: 79, vib: 4.1, press: 0.8 } },
  { id: 'R05', deviceId: 'F-01', deviceType: '风机', batch: '2026-11-A', faulty: false, note: '', values: { rpm: 1500, temp: 62, vib: 3.1, press: 0.38 } },
  { id: 'R06', deviceId: 'F-01', deviceType: '风机', batch: '2026-11-A', faulty: false, note: '', values: { rpm: 1620, temp: 65, vib: 3.4, press: 0.41 } },
  { id: 'R07', deviceId: 'F-02', deviceType: '风机', batch: '2026-11-B', faulty: false, note: '', values: { rpm: 1750, temp: 58, vib: 2.8, press: 0.35 } },
  { id: 'R08', deviceId: 'F-02', deviceType: '风机', batch: '2026-11-B', faulty: false, note: '', values: { rpm: 1480, temp: 66, vib: 3.6, press: 0.42 } },
  { id: 'R09', deviceId: 'C-01', deviceType: '压缩机', batch: '2026-11-A', faulty: false, note: '', values: { rpm: 5200, temp: 98, vib: 6.2, press: 2.1 } },
  { id: 'R10', deviceId: 'C-01', deviceType: '压缩机', batch: '2026-11-A', faulty: false, note: '', values: { rpm: 5600, temp: 104, vib: 6.8, press: 2.4 } },
  { id: 'R11', deviceId: 'C-01', deviceType: '压缩机', batch: '2026-11-B', faulty: false, note: '', values: { rpm: 4800, temp: 92, vib: 5.6, press: 1.9 } },
  { id: 'R12', deviceId: 'C-01', deviceType: '压缩机', batch: '2026-11-B', faulty: false, note: '', values: { rpm: 5900, temp: 110, vib: 7.4, press: 2.6 } },
  { id: 'R13', deviceId: 'P-01', deviceType: '泵', batch: '2026-11-C', faulty: false, note: '振动传感器离线', values: { rpm: 2920, temp: 80, press: 0.83 } },
  { id: 'R14', deviceId: 'F-01', deviceType: '风机', batch: '2026-11-C', faulty: true, note: '采集期间设备异常抖动，记录不可信', values: { rpm: 2200, temp: 95, vib: 9.8, press: 0.9 } },
  { id: 'R15', deviceId: 'P-02', deviceType: '泵', batch: '2026-11-C', faulty: false, note: '与 R16 坐标相同、来源不同', values: { rpm: 2600, temp: 72, vib: 3.9, press: 0.66 } },
  { id: 'R16', deviceId: 'F-02', deviceType: '风机', batch: '2026-11-C', faulty: false, note: '与 R15 坐标相同、来源不同', values: { rpm: 2600, temp: 72, vib: 3.9, press: 0.66 } },
];
