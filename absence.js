'use strict';

/**
 * 临时缺席试排（只在内存中计算，不写库、不改动正式排班）。
 *
 * 舞台监督临时登记若干条「人员 × 提示号闭区间」的缺席规则后，系统按与
 * 连场轮换排班（rotation.js）完全相同的规则试算整场排班：
 *  - 区间按提示号覆盖**全量重放后生效**的提示；失败提示不占轮次，
 *    落在失败提示上的区间自然不起作用；
 *  - 同一人员的多条规则（含区间重叠）取**并集**：只要某条生效提示的
 *    提示号落在该人员任一区间内，该人员这一轮就缺席；
 *  - 缺席人员在被覆盖的轮次不能出场，区间外仍可正常参与；
 *  - 沿用搬运资格、组内一人一岗、相邻生效提示不得同人的全部约束，
 *    对整场联合求解并允许回溯调整前序分配（复用 computeRotation）。
 *
 * 可行时输出逐轮岗位表与人员汇总；无解时只报告首个无法形成可行前缀的
 * 提示号与原因，不输出部分岗位表（与正式排班一致）。
 *
 * 本模块为纯函数：不读数据库、不写数据库；规则由调用方（页面）保存在
 * 内存中，每次试排即时传入，试排结束即弃。
 */

const { computeRotation } = require('./rotation');

/**
 * 校验并规范化缺席规则（未知人员与无效区间在此拦截）。
 *
 * @param {*} rawRules 请求体中的 rules，应为数组（允许为空数组 = 无缺席）
 * @param {string[]} staffNames 现有人员名单
 * @returns {{err:string}|{rules:Array<{staff:string,from:number,to:number}>}}
 */
function validateAbsenceRules(rawRules, staffNames) {
  if (!Array.isArray(rawRules)) return { err: '缺席规则格式不正确：rules 必须是数组' };
  const known = new Set(staffNames);
  const rules = [];
  for (let i = 0; i < rawRules.length; i++) {
    const raw = rawRules[i];
    const label = `第 ${i + 1} 条规则`;
    if (!raw || typeof raw !== 'object') return { err: `${label}格式不正确` };
    const staff = String(raw.staff === undefined || raw.staff === null ? '' : raw.staff).trim();
    if (!staff) return { err: `${label}：请选择缺席人员` };
    if (!known.has(staff)) return { err: `${label}：人员「${staff}」不存在（未知人员）` };
    const from = Number(raw.from);
    const to = Number(raw.to);
    if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(to) || to <= 0)
      return { err: `${label}：提示号区间的起止号都必须是正整数` };
    if (from > to)
      return { err: `${label}：提示号区间无效，起始号 ${from} 不能大于结束号 ${to}（闭区间需满足 起 ≤ 止）` };
    rules.push({ staff, from, to });
  }
  return { rules };
}

/**
 * 临时缺席试排（纯函数）。
 *
 * @param {Array<{number:number, note:string, transfers:Array}>} cues 已按提示号升序
 * @param {Array<{number:number, ok:boolean}>} results 全量重放结果（replay().results）
 * @param {Array<{name:string, props:string[]}>} staff 人员及其可搬运道具名单
 * @param {Array<{staff:string, from:number, to:number}>} rules 已规范化的缺席规则
 * @returns {Object} 在 computeRotation 结果（status / effectiveCueNumbers /
 *   rounds / roster / block / summary …）之上附加：
 *   - rules：回显的规范化规则；
 *   - coverage：并集覆盖——每名缺席人员实际缺席的生效提示号（按提示号升序）；
 *   - rounds[].absentStaff：该轮缺席的人员名单（仅 ok 时有轮次）。
 */
function computeAbsenceTrial(cues, results, staff, rules) {
  // 某提示号轮次的缺席人员 = 区间覆盖该提示号的全部规则人员（重叠规则取并集）
  const absentAt = (cueNumber) => {
    const names = new Set();
    for (const r of rules) {
      if (cueNumber >= r.from && cueNumber <= r.to) names.add(r.staff);
    }
    return names;
  };

  const rotation = computeRotation(cues, results, staff, { absentAt });

  // 并集覆盖：每名缺席人员实际缺席的生效提示（失败提示不占轮次，不在其中）
  const staffOrder = [];
  for (const r of rules) if (!staffOrder.includes(r.staff)) staffOrder.push(r.staff);
  const coveredBy = new Map(staffOrder.map((name) => [name, []]));
  for (const n of rotation.effectiveCueNumbers) {
    for (const name of absentAt(n)) coveredBy.get(name).push(n);
  }
  const coverage = staffOrder.map((name) => ({
    staff: name,
    intervals: rules.filter((r) => r.staff === name).map((r) => ({ from: r.from, to: r.to })),
    cues: coveredBy.get(name),
  }));

  return {
    ...rotation,
    rounds: rotation.rounds.map((r) => ({ ...r, absentStaff: [...absentAt(r.number)] })),
    rules,
    coverage,
  };
}

module.exports = { computeAbsenceTrial, validateAbsenceRules };
