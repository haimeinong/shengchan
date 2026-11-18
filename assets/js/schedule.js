/* ============================================================
 * 排产分析（二期）
 * 业务链路：
 *   1) 需求合并：欠货 > 备货紧急/预警 > 月度生产计划剩余，同一 SKU 取最大值
 *   2) 产品线分配：工艺形态（产品形态+包装形式）→ 生产线，逐工段计算用工时间
 *   3) 排程：按优先级 + 交期贪心填入未来 N 天，每条产线每日固定工时
 *   4) 人工按天确认 → 生成生产订单 → 完工补录批次号（物料编码+生产日期+班组字母）
 *   5) 完工自动写入每日实际产出；库存按最新批次倒推展示当前构成（先进先出）
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 通用工具 ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '—';
    return (+n).toLocaleString('zh-CN', { maximumFractionDigits: 1 });
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function addDays(str, n) {
    var d = new Date(str + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function nowStr() { return new Date().toLocaleString('zh-CN', { hour12: false }); }
  function weekLabel(str) { return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(str + 'T00:00:00').getDay()]; }
  function toast(msg, type) {
    var w = $('#toast-wrap');
    if (!w) return;
    var d = document.createElement('div');
    d.className = 'toast ' + (type || '');
    d.textContent = msg;
    w.appendChild(d);
    setTimeout(function () { d.remove(); }, 3200);
  }

  /* ---------------- 生产线档案（与产能档案保持一致） ---------------- */
  var PRODUCTION_LINES = [
    { code: 'L01', name: '整粒香辛料分装线', seq: '①' },
    { code: 'L02', name: '粉碎与固态复合线', seq: '②' },
    { code: 'L03', name: '半固态（炒制/调配）线', seq: '③' },
    { code: 'L04', name: '液态调味料线', seq: '④' },
    { code: 'L05', name: '分装线', seq: '⑤' }
  ];
  /* 默认映射：工艺形态 → { 生产线, 默认工段编号 }。工段可通过 sectionsOf(line)[0] 自动回填 */
  var FORM_LINE_MAP = {
    '原始香辛料': { line: 'L01', section: '' },
    '粉料': { line: 'L02', section: '' },
    '块料': { line: 'L02', section: '' },
    '酱料': { line: 'L03', section: '' }
  };

  function lineByCode(code) {
    return PRODUCTION_LINES.filter(function (l) { return l.code === code; })[0] || null;
  }
  function lineLabel(code) {
    var l = lineByCode(code);
    return l ? (l.seq + ' ' + l.name) : (code || '');
  }
  function lineOptions(sel) {
    return '<option value="">未分配</option>' + PRODUCTION_LINES.map(function (l) {
      return '<option value="' + l.code + '"' + (sel === l.code ? ' selected' : '') + '>' + l.seq + ' ' + l.name + '</option>';
    }).join('');
  }

  /* ---------------- 状态 ---------------- */
  var state = {
    materials: [], matMap: {}, semiMaterials: [],
    snapshots: [], snapByCode: {}, semiSnapshots: [],
    backorders: [], plans: [], boms: [], bomByCode: {},
    worksections: [], capacities: [], lineMap: {}, tasks: [], orders: [],
    cfg: { start: todayStr(), hours: 8, days: 3, batchMax: 0, incChange: true, incPick: true, confirmer: '' },
    demand: [], missing: [], planRows: [],
    keyword: '', lineFilter: '', sourceFilter: '', statusFilter: '',
    lineKeyword: '', lineEdits: {},
    dayTab: '', expanded: {}, expandedBatches: {},
    dayOverrides: {}, /* 人工调整：{ '日期|物料编码': { qty } } */
    orderStatus: '', orderKeyword: '', batchKeyword: '', batchScope: 'batch',
    completeOrder: null, batchDirty: false, initialized: false, loading: null
  };

  /* ---------------- 配置读写 ---------------- */
  function loadCfg() {
    return DB.all('replenish_cfg').then(function (rows) {
      (rows || []).forEach(function (r) {
        var v = r.值;
        switch (r.参数键) {
          case 'sched_start': if (v) state.cfg.start = String(v); break;
          case 'sched_hours': if (+v > 0) state.cfg.hours = +v; break;
          case 'sched_days': if (+v >= 1) state.cfg.days = +v; break;
          case 'sched_batch_max': state.cfg.batchMax = +v || 0; break;
          case 'sched_inc_change': state.cfg.incChange = String(v) !== '0'; break;
          case 'sched_inc_pick': state.cfg.incPick = String(v) !== '0'; break;
          case 'sched_confirmer': state.cfg.confirmer = String(v || ''); break;
        }
      });
    });
  }
  function saveCfg() {
    var ts = nowStr();
    return DB.bulkPut('replenish_cfg', [
      { 参数键: 'sched_start', 值: state.cfg.start, 更新时间: ts },
      { 参数键: 'sched_hours', 值: state.cfg.hours, 更新时间: ts },
      { 参数键: 'sched_days', 值: state.cfg.days, 更新时间: ts },
      { 参数键: 'sched_batch_max', 值: state.cfg.batchMax, 更新时间: ts },
      { 参数键: 'sched_inc_change', 值: state.cfg.incChange ? '1' : '0', 更新时间: ts },
      { 参数键: 'sched_inc_pick', 值: state.cfg.incPick ? '1' : '0', 更新时间: ts },
      { 参数键: 'sched_confirmer', 值: state.cfg.confirmer, 更新时间: ts }
    ]);
  }

  /* ---------------- 数据加载 ---------------- */
  function loadAll() {
    return Promise.all([
      DB.all('material'), DB.all('stock'), DB.all('backorder'), DB.all('plan'),
      DB.all('bom'), DB.all('worksection'), DB.all('capacity'), DB.all('line_map'),
      DB.all('schedule'), DB.all('prodorder')
    ]).then(function (r) {
      var mats = r[0] || [];
      state.materials = mats.filter(function (m) { return (m.库存属性 || '成品') === '成品'; });
      state.semiMaterials = mats.filter(function (m) { return m.库存属性 === '半成品'; });
      state.matMap = {};
      mats.forEach(function (m) { state.matMap[m.物料编码] = m; });

      state.snapshots = (r[1] || []).filter(function (s) { return s.库存类型 === '成品'; });
      state.semiSnapshots = (r[1] || []).filter(function (s) { return s.库存类型 === '半成品'; });
      state.snapByCode = {};
      state.snapshots.forEach(function (s) {
        (state.snapByCode[s.物料编码] = state.snapByCode[s.物料编码] || []).push(s);
      });
      Object.keys(state.snapByCode).forEach(function (c) {
        state.snapByCode[c].sort(function (a, b) { return a.日期 < b.日期 ? -1 : (a.日期 > b.日期 ? 1 : 0); });
      });

      state.backorders = (r[2] || []).filter(function (b) { return b.状态 !== '已结清'; });
      state.plans = (r[3] || []).filter(function (p) { return p.状态 === '已确认'; });
      state.boms = (r[4] || []).filter(function (b) { return b.状态 === '已确认' || b.状态 === '已锁定'; });
      state.bomByCode = {};
      state.boms.forEach(function (b) { (state.bomByCode[b.成品编码] = state.bomByCode[b.成品编码] || []).push(b); });

      state.worksections = (r[5] || []).filter(function (w) { return w.状态 !== '停用'; });
      state.capacities = r[6] || [];

      state.lineMap = {};
      (r[7] || []).forEach(function (x) {
        state.lineMap[comboKey(x.产品形态, x.包装形式)] = {
          line: x.生产线 || '', section: x.默认工段编号 || ''
        };
      });

      state.tasks = r[8] || [];
      state.orders = r[9] || [];
    });
  }

  /* ---------------- 工艺形态 / 产线 / 产能 ---------------- */
  function comboKey(base, pack) {
    base = String(base || '').trim();
    pack = String(pack || '').trim();
    return pack ? (base + '-' + pack) : base;
  }
  function comboOf(m) { return comboKey(m.产品形态, m.包装形式); }

  /* 工段信息：返回 { line, sectionCode, sectionName, deviceType }
   * 优先级：物料主数据「默认工段」> 工艺形态映射的默认工段 > 产品形态映射的默认工段
   *       > 默认 FORM_LINE_MAP > 生产线首个工段（自动推断）
   * 生产线可从工段反查，也可从映射记录/物料主数据覆盖
   */
  function sectionInfoOf(code, m) {
    m = m || state.matMap[code] || {};
    var combo = comboOf(m);
    var base = String(m.产品形态 || '').trim();
    var ownSection = String(m.默认工段 || '').trim();
    var ownLine = String(m.生产线 || '').trim();

    var rec = state.lineMap.hasOwnProperty(combo) ? Object.assign({}, state.lineMap[combo])
      : (state.lineMap.hasOwnProperty(base) ? Object.assign({}, state.lineMap[base])
        : (FORM_LINE_MAP[base] ? Object.assign({}, FORM_LINE_MAP[base]) : { line: '', section: '' }));

    var line = ownLine || (rec && rec.line) || '';
    var sectionCode = ownSection || (rec && rec.section) || '';

    /* 若有默认工段但生产线为空，从工段反查生产线 */
    if (!line && sectionCode) {
      var s = state.worksections.filter(function (w) { return w.工段编号 === sectionCode; })[0];
      if (s) line = s.生产线 || '';
    }

    /* 若生产线已知但工段为空，自动取该线第一个工段 */
    if (line && !sectionCode) {
      var secs = sectionsOf(line);
      if (secs.length) sectionCode = secs[0].工段编号;
    }

    var sec = state.worksections.filter(function (w) { return w.工段编号 === sectionCode; })[0] || {};
    /* 设备组优先从「产能矩阵」表按 工艺形态×默认工段 读取（与产能档案维护入口一致），
       产能矩阵缺值时 fallback 到工段档案的「设备类型」字段（兼容历史数据） */
    var cap = capOf(combo, sectionCode);
    var deviceType = String((cap && cap.设备类型) || sec.设备类型 || '').trim();
    return {
      line: line, sectionCode: sectionCode,
      sectionName: sec.工段名称 || '',
      deviceType: deviceType
    };
  }

  /* 保留 lineOf 兼容已有调用 */
  function lineOf(code, m) { return sectionInfoOf(code, m).line; }

  function sectionsOf(line) {
    return state.worksections.filter(function (w) { return w.生产线 === line; })
      .sort(function (a, b) { return (a.工段序号 || 0) - (b.工段序号 || 0); });
  }
  function capOf(combo, sec) {
    var base = combo.split('-')[0];
    var list = state.capacities;
    return list.filter(function (c) { return c.产品形态 === combo && c.工段编号 === sec; })[0]
      || list.filter(function (c) { return c.产品形态 === base && c.工段编号 === sec; })[0]
      || null;
  }
  function parseRate(cap) {
    if (!cap) return null;
    var candidates = [cap.实测值, cap.借鉴值];
    var bad = null;
    for (var i = 0; i < candidates.length; i++) {
      var raw = candidates[i];
      if (raw === '' || raw == null) continue;
      var s = String(raw);
      var mm = s.match(/([\d.]+)/);
      if (!mm || !(+mm[1] > 0)) continue;
      var isKg = /kg|公斤|千克/i.test(s);
      var obj = { rate: +mm[1], raw: s, unitBad: isKg, from: i === 0 ? '实测值' : '借鉴值' };
      if (!isKg) return obj;
      bad = bad || obj;
    }
    return bad;
  }

  /* 单件工时只取默认工段的产能数据：单位工时 = 1 / (默认工段每小时产量) */
  function laborOf(code) {
    var m = state.matMap[code] || {};
    var combo = comboOf(m);
    var info = sectionInfoOf(code, m);
    var out = {
      line: info.line, combo: combo,
      sectionCode: info.sectionCode, sectionName: info.sectionName,
      deviceType: info.deviceType,
      rows: [], unitHours: 0, change: 0, pick: 0, unitBad: [], missing: ''
    };
    if (!combo || combo === '-') { out.missing = '未填产品形态/包装形式'; return out; }
    if (!info.line) { out.missing = '工艺形态未映射生产线'; return out; }
    if (!info.sectionCode) { out.missing = '未确定默认工段（请在产品线映射或物料主数据指定）'; return out; }

    var cap = capOf(combo, info.sectionCode);
    var p = parseRate(cap);
    if (!cap) { out.missing = '默认工段「' + info.sectionCode + '」产能矩阵未维护'; return out; }
    if (!p) { out.missing = '默认工段产能数据无有效数值'; return out; }
    if (p.unitBad) { out.unitBad.push(info.sectionCode + '「' + p.raw + '」'); out.missing = '默认工段产能单位不是「箱/小时」：' + p.raw; return out; }

    out.rows.push({
      sec: info.sectionCode, name: info.sectionName,
      rate: p.rate, hours: 1 / p.rate,
      from: p.from, raw: p.raw, cap: cap
    });
    out.unitHours = 1 / p.rate;
    out.change = +cap.调试换线清场时间 || 0;
    out.pick = +cap.领料时间 || 0;
    out.missing = '';
    return out;
  }

  /* ---------------- 需求合并 ---------------- */
  function latestSnap(code) {
    var list = state.snapByCode[code] || [];
    return list.length ? list[list.length - 1] : null;
  }
  function stockOf(code) { var s = latestSnap(code); return s ? (+s.数量 || 0) : 0; }

  function totalOutInWindow(code, anchorDate, days) {
    var start = new Date(anchorDate.getTime() - (days - 1) * 86400000);
    var startStr = start.getFullYear() + '-' + pad2(start.getMonth() + 1) + '-' + pad2(start.getDate());
    var list = (state.snapByCode[code] || []).filter(function (s) { return s.日期 >= startStr; });
    if (!list.length) return 0;
    var total = 0, prev = null;
    list.forEach(function (s) {
      var out = +s.出库数量 || 0;
      if (prev && s.日期.slice(0, 7) === prev.日期.slice(0, 7)) {
        var inc = out - (+prev.出库数量 || 0);
        total += inc > 0 ? inc : 0;
      } else {
        total += out;
      }
      prev = s;
    });
    return total;
  }
  function monthQty(code, ym, field) {
    var list = (state.snapByCode[code] || []).filter(function (s) { return s.日期.slice(0, 7) === ym; });
    if (!list.length) return null;
    return +list[list.length - 1][field] || 0;
  }
  function monthAdd(ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + pad2(m + 1);
  }

  function buildDemand() {
    var byCode = {};
    function slot(code) {
      if (!byCode[code]) {
        var m = state.matMap[code] || {};
        byCode[code] = {
          code: code, name: m.物料名称 || '', series: m.产品系列 || '',
          base: m.产品形态 || '', pack: m.包装形式 || '', combo: comboOf(m),
          sources: {}, dates: [], qty: 0, priority: 9
        };
      }
      return byCode[code];
    }

    /* 1) 欠货 */
    state.backorders.forEach(function (b) {
      var qty = +b.欠货数量 || 0;
      if (qty <= 0) return;
      var r = slot(b.物料编码);
      r.sources['欠货'] = (r.sources['欠货'] || 0) + qty;
      if (b.需求日期) r.dates.push(b.需求日期);
    });

    /* 2) 备货缺口：以最新快照为锚点，沿用备货建议口径（30 天窗口 + 目标库存天数） */
    var anchor = '';
    state.snapshots.forEach(function (s) { if (s.日期 > anchor) anchor = s.日期; });
    if (anchor) {
      var anchorDate = new Date(anchor + 'T00:00:00');
      state.materials.forEach(function (m) {
        var rawDays = String(m.目标库存天数 == null ? '' : m.目标库存天数).trim();
        if (rawDays !== '' && +rawDays === 0) return;
        var targetDays = +rawDays > 0 ? +rawDays : 7;
        var out = totalOutInWindow(m.物料编码, anchorDate, 30);
        var dailyAvg = out / 30;
        if (dailyAvg <= 0) return;
        var stock = stockOf(m.物料编码);
        var gap = Math.max(0, dailyAvg * targetDays - stock);
        if (gap <= 0) return;
        var availDays = stock / dailyAvg;
        if (availDays >= targetDays) return;
        var r = slot(m.物料编码);
        r.sources['备货'] = Math.ceil(gap);
        r.备货等级 = availDays < 3 ? '紧急' : '预警';
      });
    }

    /* 3) 月度生产计划剩余（周期覆盖的月份，已确认） */
    var startYm = state.cfg.start.slice(0, 7);
    var endYm = addDays(state.cfg.start, Math.max(0, state.cfg.days - 1)).slice(0, 7);
    var months = [];
    for (var ym = startYm; ym <= endYm; ym = monthAdd(ym, 1)) months.push(ym);
    state.plans.forEach(function (p) {
      if (months.indexOf(p.月份) < 0) return;
      var planQty = +p.计划数量 || 0;
      if (planQty <= 0) return;
      var inQty = monthQty(p.物料编码, p.月份, '入库数量');
      var remain = Math.max(0, planQty - (inQty || 0));
      if (remain <= 0) return;
      var r = slot(p.物料编码);
      r.sources['月计划'] = (r.sources['月计划'] || 0) + remain;
    });

    /* 合并：取最大值，优先级 欠货1 > 紧急备货2 > 预警备货3 > 月计划4 */
    var out = [];
    Object.keys(byCode).forEach(function (code) {
      var r = byCode[code];
      var vals = ['欠货', '备货', '月计划'].map(function (k) { return +r.sources[k] || 0; });
      r.qty = Math.max.apply(null, vals);
      if (r.qty <= 0) return;
      r.priority = r.sources['欠货'] > 0 ? 1 : (r.sources['备货'] > 0 ? (r.备货等级 === '紧急' ? 2 : 3) : 4);
      r.date = r.dates.length ? r.dates.sort()[0] : (r.priority === 4 ? '' : addDays(state.cfg.start, 1));
      var lab = laborOf(code);
      r.labor = lab;
      r.line = lab.line;
      r.unitHours = lab.unitHours;
      r.sectionCode = lab.sectionCode;
      r.sectionName = lab.sectionName;
      r.deviceType = lab.deviceType;
      r.setupHours = (state.cfg.incChange ? lab.change : 0) + (state.cfg.incPick ? lab.pick : 0);
      r.setupHours = r.setupHours / 60;
      r.batches = state.cfg.batchMax > 0 ? Math.max(1, Math.ceil(r.qty / state.cfg.batchMax)) : 1;
      r.hours = r.qty * r.unitHours + r.batches * r.setupHours;
      r.need = r.qty;
      r.scheduled = 0;
      r.remaining = r.qty;
      r.shortages = checkBom(code, r.qty);
      r.kitStatus = !state.bomByCode[code] ? '未维护' : (r.shortages.length ? '缺料' : '齐套');
      out.push(r);
    });
    out.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      var ad = a.date || '9999-12-31', bd = b.date || '9999-12-31';
      if (ad !== bd) return ad < bd ? -1 : 1;
      return b.qty - a.qty;
    });
    return out;
  }

  function semiStockOf(code) {
    var latest = null;
    state.semiSnapshots.forEach(function (s) { if (s.物料编码 === code && (!latest || s.日期 > latest.日期)) latest = s; });
    return latest ? (+latest.数量 || 0) : 0;
  }
  function checkBom(code, qty) {
    var links = state.bomByCode[code] || [];
    var out = [];
    links.forEach(function (l) {
      var need = qty * (+l.单耗 || 0);
      var stock = semiStockOf(l.半成品编码);
      var short = need - stock;
      if (short > 0.0001) out.push({ code: l.半成品编码, need: need, stock: stock, short: short, use: +l.单耗 || 0 });
    });
    return out;
  }

  /* ---------------- 排程（贪心） ---------------- */
  function taskKey(date, code) { return date + '|' + code; }

  function computePlan() {
    var dates = [];
    for (var i = 0; i < state.cfg.days; i++) dates.push(addDays(state.cfg.start, i));
    var used = {};   // date|line -> hours（已确认 + 建议）
    var dayTasks = {}; // date -> line -> [row]
    var byKey = {};   // date|code -> task
    dates.forEach(function (d) { dayTasks[d] = {}; });

    /* 剩余需求按天、按优先级填充 */
    var remaining = {};
    state.demand.forEach(function (r) { remaining[r.code] = r.qty; });
    var maxHours = state.cfg.hours;

    /* 已确认任务先占产能，并从剩余需求中扣除 */
    var codeStarted = {};
    state.tasks.forEach(function (t) {
      if (t.状态 !== '已确认') return;
      if (dates.indexOf(t.排产日期) < 0) return;
      codeStarted[t.物料编码] = true;
      var k = t.排产日期 + '|' + t.生产线;
      used[k] = (used[k] || 0) + (+t.所需工时 || 0);
      (dayTasks[t.排产日期][t.生产线] = dayTasks[t.排产日期][t.生产线] || []).push({
        date: t.排产日期, line: t.生产线, code: t.物料编码, qty: +t.计划数量 || 0,
        hours: +t.所需工时 || 0, priority: +t.优先级 || 9, source: t.来源 || '',
        sectionCode: t.工段编号 || t.sectionCode || '', status: '已确认'
      });
      byKey[taskKey(t.排产日期, t.物料编码)] = t;
      if (remaining.hasOwnProperty(t.物料编码)) {
        remaining[t.物料编码] = Math.max(0, remaining[t.物料编码] - (+t.计划数量 || 0));
        var dr = state.demand.filter(function (x) { return x.code === t.物料编码; })[0];
        if (dr) dr.scheduled += (+t.计划数量 || 0);
      }
    });

    dates.forEach(function (d) {
      state.demand.forEach(function (r) {
        var left = remaining[r.code] || 0;
        if (left <= 0) return;
        if (!r.line || !r.unitHours) return;
        var k = d + '|' + r.line;
        var free = maxHours - (used[k] || 0);
        if (free <= 0.0001) return;
        var existing = byKey[taskKey(d, r.code)];
        if (existing) return; // 当日已有该 SKU 任务
        var firstChunk = !codeStarted[r.code];
        var setup = r.setupHours || 0;
        var allow = free - (firstChunk ? setup : 0);
        if (allow <= 0.0001) return;
        var qtyFit = Math.floor(allow / r.unitHours);
        if (qtyFit < 1) return;
        var qty = Math.min(left, qtyFit);
        var hours = qty * r.unitHours + (firstChunk ? setup : 0);
        var task = {
          date: d, line: r.line, code: r.code, qty: qty, hours: hours,
          priority: r.priority, source: sourceText(r), sectionCode: r.sectionCode,
          sectionName: r.sectionName, deviceType: r.deviceType,
          status: '建议', name: r.name
        };
        (dayTasks[d][r.line] = dayTasks[d][r.line] || []).push(task);
        used[k] = (used[k] || 0) + hours;
        remaining[r.code] = left - qty;
        r.scheduled += qty;
        codeStarted[r.code] = true;
      });
    });

    state.demand.forEach(function (r) { r.remaining = Math.max(0, r.qty - r.scheduled); });
    state.planRows = [];
    dates.forEach(function (d) {
      PRODUCTION_LINES.forEach(function (l) {
        (dayTasks[d][l.code] || []).forEach(function (t) { state.planRows.push(t); });
      });
    });
    state.used = used;
    state.dates = dates;
    state.dayTasks = dayTasks;
    return { dates: dates, used: used, dayTasks: dayTasks };
  }

  function sourceText(r) {
    var arr = [];
    if (r.sources['欠货']) arr.push('欠货');
    if (r.sources['备货']) arr.push('备货缺口');
    if (r.sources['月计划']) arr.push('月计划');
    return arr.join('+');
  }

  function refreshKit() {
    state.demand.forEach(function (r) {
      var q = r.scheduled > 0 ? r.scheduled : r.qty;
      var short = checkBom(r.code, q);
      r.shortNow = short;
      r.kitStatus = !state.bomByCode[r.code] ? '未维护' : (short.length ? '缺料' : '齐套');
    });
  }

  /* ---------------- 建议落库（仅「建议」状态，不动已确认） ---------------- */
  function persistSuggestions() {
    var dates = state.dates || [];
    var stale = state.tasks.filter(function (t) {
      return t.状态 === '建议' && dates.indexOf(t.排产日期) >= 0 && !state.planRows.some(function (p) {
        return p.status === '建议' && p.date === t.排产日期 && p.code === t.物料编码;
      });
    });
    var unitMap = {};
    state.demand.forEach(function (r) { unitMap[r.code] = r.unitHours; });
    var ts = nowStr();
    var rows = state.planRows.filter(function (t) { return t.status === '建议'; }).map(function (t) {
      var old = state.tasks.filter(function (x) { return x.排产日期 === t.date && x.物料编码 === t.code; })[0] || {};
      return {
        排产日期: t.date, 物料编码: t.code, 生产线: t.line,
        计划数量: Math.round(t.qty * 100) / 100, 优先级: t.priority, 来源: t.source,
        工段编号: t.sectionCode || '', 工段名称: t.sectionName || '', 设备类型: t.deviceType || '',
        单件工时: round2(unitMap[t.code] || 0), 所需工时: round2(t.hours),
        状态: '建议', 确认人: '', 确认时间: '',
        修改记录: old.修改记录 || [], 备注: old.备注 || '',
        创建时间: old.创建时间 || ts, 更新时间: ts
      };
    });
    var dels = stale.map(function (t) { return [t.排产日期, t.物料编码]; });
    return Promise.all(dels.map(function (k) { return DB.del('schedule', k); }))
      .then(function () { return DB.bulkPut('schedule', rows); });
  }

  /* ---------------- 刷新主流程 ---------------- */
  function refresh() {
    state.demand = buildDemand();
    state.missing = state.demand.filter(function (r) { return !!r.labor.missing; }).map(function (r) {
      return { code: r.code, name: r.name, combo: r.combo, qty: r.qty, reason: r.labor.missing };
    });
    computePlan();
    refreshKit();
    renderParams();
    renderKpi();
    renderLineMap();
    renderDemand();
    renderDayTabsTop();
    renderSuggestions();
    renderDay();
    renderOrders();
    renderBatches();
    renderMissing();
  }

  function rerenderAfterLoad() { refresh(); }

  /* ---------------- 渲染：参数 / KPI ---------------- */
  function renderParams() {
    var s = $('#sched-start'); if (s) s.value = state.cfg.start;
    var h = $('#sched-hours'); if (h) h.value = state.cfg.hours;
    var d = $('#sched-days'); if (d) d.value = state.cfg.days;
    var b = $('#sched-batch-max'); if (b) b.value = state.cfg.batchMax || '';
    var c1 = $('#sched-inc-change'); if (c1) c1.checked = !!state.cfg.incChange;
    var c2 = $('#sched-inc-pick'); if (c2) c2.checked = !!state.cfg.incPick;
    var cf = $('#sched-confirmer'); if (cf) cf.value = state.cfg.confirmer || '';
    var lf = $('#sched-line-filter');
    if (lf && lf.options.length <= 1) {
      lf.innerHTML = '<option value="">全部产线</option>' + PRODUCTION_LINES.map(function (l) {
        return '<option value="' + l.code + '">' + l.seq + ' ' + l.name + '</option>';
      }).join('');
    }
  }

  function renderKpi() {
    var rows = state.demand;
    var pending = rows.filter(function (r) { return r.remaining > 0.0001; });
    var overload = 0;
    Object.keys(state.used || {}).forEach(function (k) {
      if (state.used[k] > state.cfg.hours + 0.01) overload++;
    });
    var short = rows.filter(function (r) { return r.scheduled > 0 && r.kitStatus === '缺料'; });
    var unmapped = rows.filter(function (r) { return !r.line || !r.unitHours; });
    var set = function (id, v) { var el = $(id); if (el) el.textContent = v; };
    set('#sched-kpi-sku', fmtNum(pending.length));
    set('#sched-kpi-qty', fmtNum(pending.reduce(function (s, r) { return s + r.remaining; }, 0)));
    set('#sched-kpi-hours', fmtNum(rows.reduce(function (s, r) { return s + (r.hours || 0); }, 0)));
    set('#sched-kpi-overload', fmtNum(overload));
    set('#sched-kpi-short', fmtNum(short.length));
    set('#sched-kpi-unmapped', fmtNum(unmapped.length));
  }

  /* ---------------- 渲染：产品线映射 ---------------- */
  function comboList() {
    var map = {};
    state.materials.forEach(function (m) {
      var combo = comboOf(m);
      if (!combo || combo === '-') return;
      if (!map[combo]) map[combo] = { combo: combo, base: String(m.产品形态 || '').trim(), pack: String(m.包装形式 || '').trim(), count: 0 };
      map[combo].count++;
    });
    Object.keys(state.lineMap).forEach(function (combo) {
      if (!map[combo]) {
        var i = combo.indexOf('-');
        map[combo] = { combo: combo, base: i > 0 ? combo.slice(0, i) : combo, pack: i > 0 ? combo.slice(i + 1) : '', count: 0 };
      }
    });
    return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
      return a.base === b.base ? (a.pack > b.pack ? 1 : -1) : (a.base > b.base ? 1 : -1);
    });
  }

  function currentRecForCombo(combo, base) {
    if (state.lineEdits.hasOwnProperty(combo)) return Object.assign({}, state.lineEdits[combo]);
    if (state.lineMap.hasOwnProperty(combo)) return Object.assign({}, state.lineMap[combo]);
    if (state.lineMap.hasOwnProperty(base)) return Object.assign({}, state.lineMap[base]);
    return FORM_LINE_MAP[base] ? Object.assign({}, FORM_LINE_MAP[base]) : { line: '', section: '' };
  }

  function sectionOptions(line, sel, combo) {
    var list = sectionsOf(line);
    var opts = list.map(function (s) {
      /* 设备组优先从产能矩阵按「工艺形态×工段」读取（与产能档案维护入口一致），
         工艺形态未指定时 fallback 到工段档案的设备类型字段（兼容历史数据） */
      var cap = combo ? capOf(combo, s.工段编号) : null;
      var dev = String((cap && cap.设备类型) || s.设备类型 || '').trim();
      return '<option value="' + esc(s.工段编号) + '"' + (sel === s.工段编号 ? ' selected' : '') + '>'
        + esc(s.工段编号) + ' ' + esc(s.工段名称 || '')
        + (dev ? '（设备组：' + esc(dev) + '）' : '') + '</option>';
    }).join('');
    return '<option value="">自动推断</option>' + opts;
  }

  function renderLineMap() {
    var tb = $('#sched-line-table tbody'); if (!tb) return;
    var kw = state.lineKeyword.toLowerCase();
    var list = comboList().filter(function (r) {
      return !kw || (r.combo + ' ' + r.base).toLowerCase().indexOf(kw) >= 0;
    });
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty">暂无工艺形态（请先在物料主数据填写 产品形态/包装形式）</td></tr>';
      return;
    }
    tb.innerHTML = list.map(function (r) {
      var cur = currentRecForCombo(r.combo, r.base);
      var hasEdit = state.lineEdits.hasOwnProperty(r.combo);
      var hasSaved = state.lineMap.hasOwnProperty(r.combo) || state.lineMap.hasOwnProperty(r.base);
      var hasLine = !!(cur && cur.line);
      var hasSection = !!(cur && cur.section);
      var status = hasEdit ? '<span class="sched-warn-text">待保存</span>'
        : (hasSaved ? '<span class="repl-sync-tag">已配置</span>'
          : (FORM_LINE_MAP[r.base] && FORM_LINE_MAP[r.base].line === cur.line && !hasEdit ? '<span class="muted">默认映射</span>' : '<span class="repl-sync-tag">已配置</span>'));
      if (!hasLine) status = '<span class="sched-warn-text">未映射</span>';
      var lineSel = '<select class="sched-line-select' + (hasLine ? '' : ' sched-line-unset') + '" data-combo="' + esc(r.combo) + '" data-field="line">' + lineOptions(cur.line || '') + '</select>';
      var secSel = '<select class="sched-line-select' + (hasSection ? '' : ' sched-line-unset') + '" data-combo="' + esc(r.combo) + '" data-field="section">'
        + sectionOptions(cur.line || '', cur.section || '', r.combo) + '</select>';
      return '<tr>'
        + '<td class="code">' + esc(r.combo) + '</td>'
        + '<td>' + esc(r.base || '—') + '</td>'
        + '<td>' + esc(r.pack || '—') + '</td>'
        + '<td>' + lineSel + '</td>'
        + '<td>' + secSel + '</td>'
        + '<td class="num">' + r.count + '</td>'
        + '<td>' + status + '</td></tr>';
    }).join('');
  }

  /* ---------------- 渲染：需求清单 ---------------- */
  function priBadge(p) {
    var label = { 1: 'P1 欠货', 2: 'P2 紧急备货', 3: 'P3 预警备货', 4: 'P4 月计划' }[p] || ('P' + p);
    return '<span class="sched-pri p' + p + '">' + label + '</span>';
  }
  function srcTags(r) {
    var out = [];
    if (r.sources['欠货']) out.push('<span class="sched-src">欠货 ' + fmtNum(r.sources['欠货']) + '</span>');
    if (r.sources['备货']) out.push('<span class="sched-src">备货 ' + fmtNum(r.sources['备货']) + '</span>');
    if (r.sources['月计划']) out.push('<span class="sched-src">月计划 ' + fmtNum(r.sources['月计划']) + '</span>');
    return out.join('');
  }

  function demandMatches(r) {
    var kw = state.keyword.toLowerCase();
    if (kw && (r.code + ' ' + r.name + ' ' + r.series).toLowerCase().indexOf(kw) < 0) return false;
    if (state.lineFilter && r.line !== state.lineFilter) return false;
    if (state.sourceFilter) {
      var key = state.sourceFilter === '备货' ? '备货' : state.sourceFilter;
      if (!r.sources[key]) return false;
    }
    if (state.statusFilter === 'pending' && r.remaining <= 0.0001) return false;
    if (state.statusFilter === 'done' && r.remaining > 0.0001) return false;
    if (state.statusFilter === 'unmapped' && (r.line && r.unitHours)) return false;
    return true;
  }

  function renderDemand() {
    var tb = $('#sched-demand-table tbody'); if (!tb) return;
    var list = state.demand.filter(demandMatches);
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="16" class="empty">暂无排产需求（请先导入欠货、成品库存或确认月度生产计划）</td></tr>';
      return;
    }
    var html = '';
    list.forEach(function (r) {
      var lineSel = '<select class="sched-line-select' + (r.line ? '' : ' sched-line-unset') + '" data-code="' + esc(r.code) + '">' + lineOptions(r.line) + '</select>';
      var unitCell = r.unitHours ? fmtNum(round2(r.unitHours * 100) / 100) : '<span class="sched-warn-text">产能缺失</span>';
      var kit = r.kitStatus === '缺料' ? '<span class="repl-badge urgent">缺料</span>'
        : (r.kitStatus === '齐套' ? '<span class="repl-badge ok">齐套</span>' : '<span class="repl-badge off">未维护</span>');
      html += '<tr>'
        + '<td>' + priBadge(r.priority) + '</td>'
        + '<td>' + srcTags(r) + '</td>'
        + '<td class="code">' + esc(r.code) + '</td>'
        + '<td>' + esc(r.name) + '</td>'
        + '<td>' + esc(r.series) + '</td>'
        + '<td>' + esc(r.combo || '—') + (r.labor.unitBad.length ? ' <span class="sched-unit-bad" title="产能单位不是箱/小时">⚠</span>' : '') + '</td>'
        + '<td class="num">' + fmtNum(r.qty) + '</td>'
        + '<td>' + esc(r.date || '—') + '</td>'
        + '<td>' + lineSel + '</td>'
        + '<td class="num">' + unitCell + '</td>'
        + '<td>' + (r.sectionCode ? esc(r.sectionCode) + ' <span class="muted">' + esc(r.sectionName) + '</span>' : '<span class="sched-warn-text">—</span>') + '</td>'
        + '<td>' + esc(r.deviceType || '—') + '</td>'
        + '<td class="num">' + (r.unitHours ? fmtNum(round2(r.hours)) : '—') + '</td>'
        + '<td class="num">' + fmtNum(r.scheduled) + '</td>'
        + '<td class="num">' + (r.remaining > 0.0001 ? '<b class="sched-warn-text">' + fmtNum(r.remaining) + '</b>' : '0') + '</td>'
        + '<td>' + kit + '</td>'
        + '<td><button class="btn btn-link btn-sm sched-detail-btn" data-code="' + esc(r.code) + '">' + (state.expanded[r.code] ? '收起' : '详情') + '</button></td>'
        + '</tr>';
      if (state.expanded[r.code]) html += '<tr class="plan-detail-row"><td colspan="17">' + demandDetail(r) + '</td></tr>';
    });
    tb.innerHTML = html;
  }

  function demandDetail(r) {
    var src = '<div><b>需求来源</b><div class="plan-basis">'
      + '欠货：<b>' + fmtNum(r.sources['欠货'] || 0) + '</b> 箱　'
      + '备货缺口：<b>' + fmtNum(r.sources['备货'] || 0) + '</b> 箱' + (r.备货等级 ? '（' + r.备货等级 + '）' : '') + '　'
      + '月计划剩余：<b>' + fmtNum(r.sources['月计划'] || 0) + '</b> 箱</div>'
      + '<div class="muted">同一 SKU 取三者最大值 = <b>' + fmtNum(r.qty) + '</b> 箱；需求日期 ' + esc(r.date || '—')
      + '；优先级 ' + priBadge(r.priority) + '</div>'
      + (r.labor.unitBad.length ? '<div class="sched-warn-text" style="margin-top:6px">产能单位异常：' + esc(r.labor.unitBad.join('、')) + '（已跳过，请改为「箱/小时」）</div>' : '')
      + (r.labor.missing ? '<div class="sched-warn-text" style="margin-top:6px">无法排产：' + esc(r.labor.missing) + '</div>' : '')
      + '</div>';

    var rows = r.labor.rows || [];
    var secTable = '<div><b>默认工段用工时间<span class="hint">（本单 ' + fmtNum(r.qty) + ' 箱）</span></b>'
      + (rows.length
        ? '<table class="grid"><thead><tr><th>工段编号</th><th>工段名称</th><th>设备组</th><th class="num">每小时产量</th><th class="num">单件工时(h/箱)</th><th class="num">本单工时(h)</th><th>取值</th></tr></thead><tbody>'
          + rows.map(function (x) {
            return '<tr>'
              + '<td>' + esc(x.sec) + '</td>'
              + '<td>' + esc(x.name) + '</td>'
              + '<td>' + esc(r.deviceType || '—') + '</td>'
              + '<td class="num">' + fmtNum(x.rate) + ' 箱/h</td>'
              + '<td class="num">' + fmtNum(round2(x.hours * 1000) / 1000) + '</td>'
              + '<td class="num">' + fmtNum(round2(x.hours * r.qty)) + '</td>'
              + '<td>' + esc(x.from) + '</td></tr>';
          }).join('')
          + '</tbody></table>'
          + '<div class="muted" style="margin-top:4px">换线清场 ' + fmtNum(r.labor.change) + ' 分钟 / 领料 ' + fmtNum(r.labor.pick) + ' 分钟；批次 ' + r.batches + ' 个；所需工时 ' + fmtNum(round2(r.hours)) + ' h</div>'
        : '<div class="muted">无可用产能数据</div>')
      + '</div>';

    var bom = '<div><b>半成品齐套<span class="hint">（按' + (r.scheduled > 0 ? '已排 ' : '需求 ') + fmtNum(r.scheduled > 0 ? r.scheduled : r.qty) + ' 箱 × 单耗）</span></b>'
      + (!state.bomByCode[r.code] ? '<div class="muted">该成品未维护半成品对应关系（需先在「半成品对应」确认）</div>'
        : ((r.shortNow || []).length
          ? '<table class="grid"><thead><tr><th>半成品编码</th><th class="num">单耗(kg/箱)</th><th class="num">需求量(kg)</th><th class="num">库存(kg)</th><th class="num">缺口(kg)</th></tr></thead><tbody>'
            + r.shortNow.map(function (s) {
              return '<tr class="repl-row-urgent"><td class="code">' + esc(s.code) + '</td><td class="num">' + fmtNum(s.use) + '</td><td class="num">' + fmtNum(round2(s.need)) + '</td><td class="num">' + fmtNum(round2(s.stock)) + '</td><td class="num neg">' + fmtNum(round2(s.short)) + '</td></tr>';
            }).join('') + '</tbody></table>'
          : '<div class="pos">已齐套</div>'))
      + '</div>';

    return '<div class="sched-demand-detail">' + src + secTable + bom + '</div>';
  }

  /* ---------------- 渲染：顶部日期切换 ---------------- */
  function renderDayTabsTop() {
    var tabs = $('#sched-day-tabs-top');
    if (!tabs) return;
    var dates = state.dates || [];
    if (!dates.length) { tabs.innerHTML = ''; return; }
    tabs.innerHTML = dates.map(function (d) {
      var st = dayStatus(d);
      var dot = st.suggested ? '●' : (st.confirmed ? '✓' : '');
      return '<button class="sched-day-tab-btn ' + (state.dayTab === d ? 'active' : '') + '" data-day="' + d + '">'
        + d.slice(5) + ' ' + weekLabel(d) + ' <span class="muted">' + dot + '</span></button>';
    }).join('');
  }

  /* ---------------- 渲染：推荐排产清单（按当前选中日期过滤） ---------------- */
  function renderSuggestions() {
    var tb = $('#sched-suggest-table tbody');
    var foot = $('#sched-suggest-foot');
    if (!tb) return;
    var dates = state.dates || [];
    if (!dates.length || !state.dayTab) {
      tb.innerHTML = '<tr><td colspan="10" class="empty">暂无排产建议，请先点「生成/刷新排产建议」</td></tr>';
      if (foot) foot.innerHTML = '';
      return;
    }
    var dt = state.dayTasks[state.dayTab] || {};
    var all = [];
    PRODUCTION_LINES.forEach(function (l) {
      (dt[l.code] || []).forEach(function (t) { all.push(t); });
    });
    all.sort(function (a, b) { return (a.priority || 9) - (b.priority || 9); });
    if (!all.length) {
      tb.innerHTML = '<tr><td colspan="10" class="empty">' + state.dayTab + ' 暂无推荐排产 · 可点下方「手动补充产品」</td></tr>';
      if (foot) foot.innerHTML = '';
      return;
    }
    var html = '';
    all.forEach(function (t, i) {
      var nm = (state.matMap[t.code] || {}).物料名称 || '';
      var info = sectionInfoOf(t.code);
      var ov = state.dayOverrides[t.date + '|' + t.code];
      var qtyDisp = ov ? ov.qty : t.qty;
      var editable = t.status === '建议';
      html += '<tr data-code="' + esc(t.code) + '" data-date="' + esc(t.date) + '">'
        + '<td class="num">' + (i + 1) + '</td>'
        + '<td class="code">' + esc(t.code) + '</td>'
        + '<td>' + esc(nm) + '</td>'
        + '<td>' + esc(t.sectionCode || info.sectionCode || '—') + (t.sectionName || info.sectionName ? ' <span class="muted">' + esc(t.sectionName || info.sectionName) + '</span>' : '') + '</td>'
        + '<td>' + esc(t.deviceType || info.deviceType || '手工生产组') + '</td>'
        + '<td class="num">'
          + (editable
            ? '<button class="btn btn-sm sched-qty-minus" data-code="' + esc(t.code) + '" data-qty="' + qtyDisp + '" data-date="' + esc(t.date) + '" title="减少">-</button>'
              + '<input class="sched-qty-input" style="width:54px;text-align:right;padding:2px 4px;border:1px solid var(--border);border-radius:4px" type="number" min="0" step="1" value="' + qtyDisp + '" data-code="' + esc(t.code) + '" data-qty="' + qtyDisp + '" data-date="' + esc(t.date) + '">'
              + '<button class="btn btn-sm sched-qty-plus" data-code="' + esc(t.code) + '" data-qty="' + qtyDisp + '" data-date="' + esc(t.date) + '" title="增加">+</button>'
            : fmtNum(qtyDisp))
        + '</td>'
        + '<td class="num">' + fmtNum(round2(t.hours)) + '</td>'
        + '<td>' + priBadge(t.priority) + '</td>'
        + '<td>' + (t.status === '已确认'
          ? '<span class="sched-status-confirmed">已确认</span>'
          : (ov ? '<span class="repl-badge warn">已调整</span>' : '<span class="repl-sync-tag pending">建议</span>'))
        + '</td>'
        + '<td>'
          + (editable ? '<button class="btn btn-sm btn-danger sched-remove-row" data-code="' + esc(t.code) + '" data-date="' + esc(t.date) + '">移除</button>' : '<span class="muted">—</span>')
        + '</td></tr>';
    });
    tb.innerHTML = html;

    var sugCount = all.filter(function (t) { return t.status === '建议'; }).length;
    var sugQty = all.filter(function (t) { return t.status === '建议'; }).reduce(function (s, t) {
      return s + ((state.dayOverrides[t.date + '|' + t.code] && state.dayOverrides[t.date + '|' + t.code].qty != null) ? state.dayOverrides[t.date + '|' + t.code].qty : t.qty);
    }, 0);
    var totalHours = all.reduce(function (s, t) { return s + (t.hours || 0); }, 0);
    var confCount = all.length - sugCount;
    if (foot) {
      foot.innerHTML = '<div class="sched-suggest-foot">'
        + '<span class="muted">合计 ' + all.length + ' 条（已确认 ' + confCount + ' · 建议 ' + sugCount + '） · ' + fmtNum(sugQty) + ' 箱 · ' + fmtNum(round2(totalHours)) + ' h</span>'
        + '<span>'
        + '<button class="btn btn-sm" id="sched-suggest-add">+ 手动补充产品</button> '
        + (sugCount ? '<button class="btn btn-primary btn-sm" id="sched-suggest-confirm">全部确定（' + sugCount + ' 条）</button>' : '')
        + '</span></div>';
    }
  }

  /* ---------------- 渲染：设备组当天生产卡片（简化版 + 固定宽度） ---------------- */
  function dayStatus(date) {
    var list = state.tasks.filter(function (t) { return t.排产日期 === date; });
    var sug = list.filter(function (t) { return t.状态 === '建议'; });
    var conf = list.filter(function (t) { return t.状态 === '已确认'; });
    return { total: list.length, suggested: sug.length, confirmed: conf.length };
  }

  function renderDay() {
    var body = $('#sched-day-body');
    if (!body) return;
    var dates = state.dates || [];
    if (!dates.length) { body.innerHTML = ''; return; }

    var date = state.dayTab;
    /* 按设备组分组（只看当天） */
    var allTasks = [];
    var dt = state.dayTasks[date] || {};
    Object.keys(dt).forEach(function (lineCode) {
      (dt[lineCode] || []).forEach(function (t) { allTasks.push(t); });
    });
    allTasks.sort(function (a, b) { return (a.priority || 9) - (b.priority || 9); });
    var groups = {};
    allTasks.forEach(function (t) {
      var info = sectionInfoOf(t.code);
      var key = info.deviceType || '手工生产组';  /* 未标记设备组 → 手工生产组 */
      if (info.line && key !== '手工生产组') key = lineLabel(info.line) + ' / ' + key;
      (groups[key] = groups[key] || []).push(t);
    });

    if (!Object.keys(groups).length) {
      body.innerHTML = '<div class="empty">该日暂无排产任务</div>';
      return;
    }

    var cards = '';
    Object.keys(groups).forEach(function (gkey) {
      var list = groups[gkey];
      var sugInGroup = list.filter(function (t) { return t.status === '建议'; }).length;
      var cls = gkey === '手工生产组' ? ' sched-manual-card' : '';
      cards += '<div class="sched-line-card' + cls + '">'
        + '<div class="sched-line-card-head"><b>' + esc(gkey) + '</b>'
        + '<span class="sched-load">' + list.length + ' SKU</span></div>'
        + '<table class="grid sched-day-group-table"><thead><tr>'
        + '<th class="code">物料编码</th><th>物料名称</th><th class="num">计划(箱)</th></tr></thead><tbody>'
        + list.map(function (t) {
          var nm = (state.matMap[t.code] || {}).物料名称 || '';
          var ov = state.dayOverrides[t.date + '|' + t.code];
          var qtyDisp = ov ? ov.qty : t.qty;
          var statusTag = t.status === '已确认'
            ? '<span class="sched-status-confirmed">已确认</span>'
            : (ov ? '<span class="repl-badge warn">已调整</span>' : '<span class="repl-sync-tag pending">建议</span>');
          return '<tr>'
            + '<td class="code">' + esc(t.code) + '</td>'
            + '<td>' + esc(nm) + ' ' + statusTag + '</td>'
            + '<td class="num">' + fmtNum(qtyDisp) + '</td></tr>';
        }).join('')
        + '</tbody></table>'
        + '</div>';
    });
    body.innerHTML = '<div class="sched-day-grid">' + cards + '</div>';
  }

  /* ---------------- 按天确认 / 撤销 ---------------- */
  function orderSeqStart(date) {
    var prefix = 'PO-' + date.replace(/-/g, '') + '-';
    var max = 0;
    state.orders.forEach(function (o) {
      if (String(o.订单号 || '').indexOf(prefix) === 0) {
        var n = +String(o.订单号).slice(prefix.length) || 0;
        if (n > max) max = n;
      }
    });
    return max;
  }
  function pad3(n) {
    var s = String(n);
    while (s.length < 3) s = '0' + s;
    return s;
  }

  /* 统一入口：从 state.dayTasks 取指定日期（可选设备组过滤）的建议任务 */
  function pickSuggestedTasks(date, groupKey) {
    var dt = state.dayTasks[date] || {};
    var list = [];
    PRODUCTION_LINES.forEach(function (l) {
      (dt[l.code] || []).forEach(function (t) { if (t.status === '建议') list.push(t); });
    });
    if (groupKey) {
      list = list.filter(function (t) {
        var info = sectionInfoOf(t.code);
        var key = info.deviceType || '手工生产组';
        if (info.line && key !== '手工生产组') key = lineLabel(info.line) + ' / ' + key;
        return key === groupKey;
      });
    }
    list.sort(function (a, b) { return (+a.priority || 9) - (+b.priority || 9); });
    return list;
  }

  /* 把 dayTasks 里的建议任务统一落库到 schedule 表（含手动补充、数量调整后的最新状态） */
  function persistTasksToSchedule(tasks) {
    var now = nowStr();
    var rows = tasks.map(function (t) {
      var info = sectionInfoOf(t.code);
      var r = state.demand.filter(function (x) { return x.code === t.code; })[0];
      return {
        排产日期: t.date, 物料编码: t.code, 生产线: t.line,
        计划数量: +t.qty || 0, 优先级: +t.priority || 9, 来源: t.source || '',
        工段编号: info.sectionCode || '', 工段名称: info.sectionName || '',
        设备类型: info.deviceType || '',
        单件工时: r ? round2(r.unitHours) : 0, 所需工时: round2(t.hours || 0),
        状态: '建议', 确认人: '', 确认时间: '',
        修改记录: [], 备注: '', 创建时间: now, 更新时间: now
      };
    });
    var keys = rows.map(function (r) { return [r.排产日期, r.物料编码]; });
    return Promise.all(keys.map(function (k) { return DB.del('schedule', k); }))
      .then(function () { return DB.bulkPut('schedule', rows); });
  }

  /* 从已持久化的 schedule 记录里为这些任务生成生产订单，然后把状态改已确认 */
  function confirmTasks(date, tasks, confirmer, ts) {
    var orders = [];
    var prefix = 'PO-' + date.replace(/-/g, '') + '-';
    var seqByCode = {};
    /* 按日期+生产线分组生成连续序号，跨批次不重复 */
    var key = 'PO-' + date.replace(/-/g, '') + '-';
    var max = 0;
    state.orders.forEach(function (o) {
      if (String(o.订单号 || '').indexOf(key) === 0) {
        var n = +String(o.订单号).slice(key.length) || 0;
        if (n > max) max = n;
      }
    });
    tasks.forEach(function (t) {
      var m = state.matMap[t.code] || {};
      var info = sectionInfoOf(t.code);
      var num = pad3(++max);
      orders.push({
        订单号: prefix + num, 批次号: '', 物料编码: t.code, 物料名称: m.物料名称 || '',
        产品形态: m.产品形态 || '', 包装形式: m.包装形式 || '', 生产线: t.line,
        工段编号: info.sectionCode || '', 工段名称: info.sectionName || '', 设备类型: info.deviceType || '',
        生产日期: '', 计划数量: +t.qty || 0, 完工数量: '', 班组: '',
        类型: '生产', 状态: '待生产', 排产日期: date,
        单件工时: t.unitHours || 0, 备注: '', 创建时间: ts, 完工时间: '', 修改记录: []
      });
    });
    /* 改状态：先把这些建议任务落库为已确认 */
    var confirmed = tasks.map(function (t) {
      var m = state.tasks.filter(function (x) { return x.排产日期 === t.date && x.物料编码 === t.code; })[0] || {};
      var row = Object.assign({}, m, {
        排产日期: t.date, 物料编码: t.code, 生产线: t.line,
        计划数量: +t.qty || 0, 优先级: +t.priority || 9, 来源: t.source || '',
        工段编号: t.sectionCode || '', 工段名称: t.sectionName || '', 设备类型: t.deviceType || '',
        状态: '已确认', 确认人: confirmer, 确认时间: ts, 更新时间: ts
      });
      return DB.put('schedule', row);
    });
    return Promise.all(confirmed).then(function () {
      return DB.bulkPut('prodorder', orders);
    }).then(function () {
      return DB.log({ 操作类型: '排产确认', 详情: { 日期: date, 任务数: tasks.length, 订单数: orders.length, 确认人: confirmer } });
    });
  }

  function confirmDay(date, groupKey) {
    var confirmer = String(state.cfg.confirmer || '').trim();
    if (!confirmer) { toast('请先在排产参数中填写确认人', 'warn'); return; }
    var tasks = pickSuggestedTasks(date, groupKey);
    if (!tasks.length) { toast(groupKey ? '该设备组当天没有可确认的建议任务' : date + ' 没有可确认的建议任务', 'warn'); return; }
    var label = groupKey ? ('设备组「' + groupKey + '」') : date;
    if (!confirm('确认 ' + label + ' 的 ' + tasks.length + ' 条排产安排，并生成待生产订单？')) return;
    var ts = nowStr();
    persistTasksToSchedule(tasks)
      .then(function () {
        /* 内存里把这些 dayTasks 改成已确认，refresh 后从 DB 重新加载 */
        tasks.forEach(function (t) { t.status = '已确认'; t.确认人 = confirmer; t.确认时间 = ts; });
        return confirmTasks(date, tasks, confirmer, ts);
      })
      .then(function () { return loadAll(); })
      .then(function () {
        refresh();
        toast('已确认 ' + tasks.length + ' 条排产，生成待生产订单', 'ok');
      })
      .catch(function (e) { toast('确认失败：' + (e.message || e), 'err'); console.error(e); });
  }

  function revokeDay(date) {
    var orders = state.orders.filter(function (o) { return o.排产日期 === date && o.类型 === '生产'; });
    if (orders.some(function (o) { return o.状态 === '已完工'; })) {
      toast('当天已有完工订单，不能撤销，请先处理完工记录', 'err'); return;
    }
    if (!orders.length) { toast('当天没有可撤销的生产订单', 'warn'); return; }
    if (!confirm('撤销 ' + date + ' 的确认？将删除 ' + orders.length + ' 张待生产订单，排产任务恢复为建议状态。')) return;
    var tasks = state.tasks.filter(function (t) { return t.排产日期 === date && t.状态 === '已确认'; });
    tasks.forEach(function (t) { t.状态 = '建议'; t.确认人 = ''; t.确认时间 = ''; });
    Promise.all(orders.map(function (o) { return DB.del('prodorder', o.id); }))
      .then(function () { return Promise.all(tasks.map(function (t) { return DB.put('schedule', t); })); })
      .then(function () { return DB.log({ 操作类型: '排产撤销确认', 详情: { 日期: date, 任务数: tasks.length, 删除订单: orders.length } }); })
      .then(function () { return loadAll(); })
      .then(function () { refresh(); toast('已撤销当天确认，订单已删除', 'ok'); })
      .catch(function (e) { toast('撤销失败：' + (e.message || e), 'err'); });
  }

  /* ---------------- 渲染：生产订单与批次 ---------------- */
  function renderOrders() {
    var tb = $('#sched-order-table tbody'); if (!tb) return;
    var kw = state.orderKeyword.toLowerCase();
    var list = state.orders.filter(function (o) {
      if (state.orderStatus && o.状态 !== state.orderStatus) return false;
      if (kw && (o.订单号 + ' ' + o.物料编码 + ' ' + (o.批次号 || '') + ' ' + (o.物料名称 || '')).toLowerCase().indexOf(kw) < 0) return false;
      return true;
    }).sort(function (a, b) {
      var ad = a.排产日期 || '', bd = b.排产日期 || '';
      if (ad !== bd) return ad < bd ? 1 : -1;
      return (b.id || 0) - (a.id || 0);
    });
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="12" class="empty">暂无生产订单（按天确认排产后自动生成）</td></tr>';
      return;
    }
    tb.innerHTML = list.map(function (o) {
      var op = o.状态 === '待生产'
        ? '<button class="btn btn-primary btn-sm sched-complete-btn" data-id="' + o.id + '">完工录入</button>'
        : '<span class="muted">—</span>';
      return '<tr class="' + (o.类型 === '期初' ? 'muted' : '') + '">'
        + '<td class="code">' + esc(o.订单号 || '—') + '</td>'
        + '<td>' + esc(o.排产日期 || '—') + '</td>'
        + '<td>' + esc(lineLabel(o.生产线)) + '</td>'
        + '<td class="code">' + esc(o.物料编码) + '</td>'
        + '<td>' + esc(o.物料名称 || '') + (o.类型 === '期初' ? ' <span class="sched-src">期初</span>' : '') + '</td>'
        + '<td class="num">' + fmtNum(o.计划数量) + '</td>'
        + '<td class="num">' + (o.完工数量 === '' || o.完工数量 == null ? '—' : fmtNum(o.完工数量)) + '</td>'
        + '<td class="code">' + (o.批次号 ? '<span class="sched-batch-tag">' + esc(o.批次号) + '</span>' : '—') + '</td>'
        + '<td>' + esc(o.班组 || '—') + '</td>'
        + '<td>' + esc(o.生产日期 || '—') + '</td>'
        + '<td>' + (o.状态 === '已完工' ? '<span class="repl-badge ok">已完工</span>' : '<span class="repl-badge warn">待生产</span>') + '</td>'
        + '<td class="sched-order-op">' + op + '</td></tr>';
    }).join('');
  }

  /* ---------------- 完工录入（批次号） ---------------- */
  function openComplete(id) {
    var o = state.orders.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!o) { toast('订单不存在', 'err'); return; }
    state.completeOrder = o;
    state.batchDirty = false;
    $('#sc-order-no').value = o.订单号 || '';
    $('#sc-mat').value = (o.物料编码 || '') + ' ' + (o.物料名称 || '');
    $('#sc-plan').value = o.计划数量 == null ? '' : o.计划数量;
    $('#sc-qty').value = o.计划数量 == null ? '' : o.计划数量;
    $('#sc-date').value = todayStr();
    $('#sc-team').value = '';
    $('#sc-remark').value = o.备注 || '';
    $('#sc-batch').value = suggestBatch(o.物料编码, todayStr(), '');
    $('#sched-complete-mask').hidden = false;
  }
  function closeComplete() {
    $('#sched-complete-mask').hidden = true;
    state.completeOrder = null;
  }
  function suggestBatch(code, date, team) {
    var d = String(date || todayStr()).replace(/-/g, '');
    var t = String(team || '').trim().toUpperCase();
    return String(code || '') + '-' + d + (t ? '-' + t : '');
  }
  function saveComplete() {
    var o = state.completeOrder;
    if (!o) return;
    var qty = parseFloat($('#sc-qty').value);
    var date = $('#sc-date').value;
    var team = String($('#sc-team').value || '').trim().toUpperCase();
    var batch = String($('#sc-batch').value || '').trim();
    if (!(qty >= 0)) { toast('完工数量需为不小于 0 的数字', 'err'); return; }
    if (!date) { toast('请选择完工日期', 'err'); return; }
    if (!batch) { toast('请填写批次号', 'err'); return; }
    if (team && !/^[A-Z]{1,2}$/.test(team)) { toast('班组请填写 1~2 个大写英文字母', 'err'); return; }
    var dup = state.orders.filter(function (x) {
      return x.id !== o.id && x.批次号 === batch && x.物料编码 === o.物料编码;
    });
    if (dup.length) { toast('批次号「' + batch + '」在该物料下已存在', 'err'); return; }
    var ts = nowStr();
    var rec = Object.assign({}, o);
    rec.完工数量 = qty;
    rec.生产日期 = date;
    rec.班组 = team;
    rec.批次号 = batch;
    rec.状态 = '已完工';
    rec.完工时间 = ts;
    rec.备注 = $('#sc-remark').value.trim();
    rec.修改记录 = (o.修改记录 || []).concat([{
      时间: ts, 内容: '完工录入：数量 ' + qty + '，日期 ' + date + '，班组 ' + (team || '—') + '，批次号 ' + batch
    }]);
    var outRow = null;
    if (o.工段编号) {
      outRow = {
        日期: date, 工段编号: o.工段编号, 产品形态: comboKey(o.产品形态, o.包装形式),
        物料编码: o.物料编码, 产出数量: qty, 生产时间: round2(qty * (+o.单件工时 || 0)),
        换产清洗次数: 0, 备注: '生产订单完工自动写入 ' + (o.订单号 || '')
      };
    }
    DB.put('prodorder', rec)
      .then(function () { if (outRow) return DB.put('output', outRow); })
      .then(function () {
        return DB.log({ 操作类型: '生产订单完工', 详情: { 订单号: o.订单号, 物料编码: o.物料编码, 完工数量: qty, 批次号: batch, 班组: team, 生产日期: date, 自动写入产出: !!outRow } });
      })
      .then(function () { return loadAll(); })
      .then(function () {
        refresh();
        closeComplete();
        toast('完工已保存，批次号 ' + batch + (outRow ? '；已写入实际产出' : '（未写产出：缺工段编号）'), 'ok');
      })
      .catch(function (e) { toast('完工保存失败：' + (e.message || e), 'err'); });
  }

  /* ---------------- 库存批次构成（先进先出，最新批次倒推） ---------------- */
  function batchComposition() {
    var map = {};
    state.orders.forEach(function (o) {
      if (o.状态 !== '已完工' || !o.批次号) return;
      (map[o.物料编码] = map[o.物料编码] || []).push(o);
    });
    Object.keys(map).forEach(function (code) {
      map[code].sort(function (a, b) {
        var ad = a.生产日期 || (a.完工时间 || '').slice(0, 10) || a.创建时间 || '';
        var bd = b.生产日期 || (b.完工时间 || '').slice(0, 10) || b.创建时间 || '';
        if (ad !== bd) return ad < bd ? 1 : -1;
        return (b.id || 0) - (a.id || 0);
      });
    });
    var out = [];
    var codes = {};
    state.materials.forEach(function (m) { codes[m.物料编码] = true; });
    Object.keys(map).forEach(function (c) { codes[c] = true; });
    Object.keys(codes).forEach(function (code) {
      var stock = stockOf(code);
      var remaining = Math.max(0, stock);
      var batches = map[code] || [];
      var alloc = [];
      batches.forEach(function (b) {
        if (remaining <= 0.0001) return;
        var qty = (b.完工数量 !== '' && b.完工数量 != null) ? (+b.完工数量 || 0) : (+b.计划数量 || 0);
        if (qty <= 0) return;
        var take = Math.min(qty, remaining);
        alloc.push({ order: b, qty: qty, remain: take });
        remaining -= take;
      });
      if (!alloc.length && stock <= 0) return;
      out.push({ code: code, name: (state.matMap[code] || {}).物料名称 || '', stock: stock, alloc: alloc, legacy: remaining });
    });
    return out.sort(function (a, b) { return a.code > b.code ? 1 : -1; });
  }

  function renderBatches() {
    var tb = $('#sched-batch-table tbody'); if (!tb) return;
    var kw = state.batchKeyword.toLowerCase();
    var list = batchComposition().filter(function (r) {
      if (state.batchScope === 'batch' && !r.alloc.length) return false;
      if (kw) {
        var batches = r.alloc.map(function (a) { return a.order.批次号; }).join(' ');
        if ((r.code + ' ' + r.name + ' ' + batches).toLowerCase().indexOf(kw) < 0) return false;
      }
      return true;
    });
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="7" class="empty">暂无批次库存（确认排产并完工录入批次号，或导入期初批次）</td></tr>';
      return;
    }
    var html = '';
    list.forEach(function (r) {
      var brief = r.alloc.length
        ? '<ul class="sched-batch-list">' + r.alloc.map(function (a) {
          return '<li><span class="sched-batch-tag">' + esc(a.order.批次号) + '</span>' + fmtNum(a.remain) + ' 箱'
            + ' <span class="muted">(' + esc(a.order.生产日期 || (a.order.完工时间 || '').slice(0, 10) || '—') + ')</span></li>';
        }).join('') + '</ul>'
        : '<span class="muted">无批次</span>';
      html += '<tr>'
        + '<td class="code">' + esc(r.code) + '</td>'
        + '<td>' + esc(r.name) + '</td>'
        + '<td class="num">' + fmtNum(r.stock) + '</td>'
        + '<td class="num">' + r.alloc.length + '</td>'
        + '<td>' + brief + '</td>'
        + '<td class="num">' + (r.legacy > 0.0001 ? fmtNum(r.legacy) : '—') + '</td>'
        + '<td><button class="btn btn-link btn-sm sched-batch-btn" data-code="' + esc(r.code) + '">' + (state.expandedBatches[r.code] ? '收起' : '详情') + '</button></td></tr>';
      if (state.expandedBatches[r.code]) {
        html += '<tr class="sched-batch-detail"><td colspan="7">' + batchDetail(r) + '</td></tr>';
      }
    });
    tb.innerHTML = html;
  }

  function batchDetail(r) {
    if (!r.alloc.length) return '<div class="muted">当前库存全部为期初/无批次库存。</div>';
    return '<table class="grid"><thead><tr><th>批次号</th><th>生产日期</th><th>产线</th><th>班组</th><th>订单号</th><th class="num">批次数量(箱)</th><th class="num">当前剩余(箱)</th><th class="num">占比</th></tr></thead><tbody>'
      + r.alloc.map(function (a) {
        var o = a.order;
        var pct = r.stock > 0 ? (a.remain / r.stock * 100) : 0;
        return '<tr>'
          + '<td><span class="sched-batch-tag">' + esc(o.批次号) + '</span></td>'
          + '<td>' + esc(o.生产日期 || '—') + '</td>'
          + '<td>' + esc(lineLabel(o.生产线)) + '</td>'
          + '<td>' + esc(o.班组 || '—') + '</td>'
          + '<td class="code">' + esc(o.订单号 || (o.类型 === '期初' ? '期初导入' : '—')) + '</td>'
          + '<td class="num">' + fmtNum(a.qty) + '</td>'
          + '<td class="num"><b>' + fmtNum(a.remain) + '</b></td>'
          + '<td class="num">' + fmtNum(Math.round(pct * 10) / 10) + '%</td></tr>';
      }).join('')
      + (r.legacy > 0.0001 ? '<tr class="muted"><td><span class="sched-batch-tag legacy">期初无批次</span></td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td class="num">' + fmtNum(r.legacy) + '</td><td class="num">' + fmtNum(Math.round(r.legacy / r.stock * 1000) / 10) + '%</td></tr>' : '')
      + '</tbody></table>'
      + '<div class="muted" style="margin-top:4px">按先进先出：当前库存从最新批次往前抵扣，更早批次视为已出库。</div>';
  }

  /* ---------------- 数据缺失 ---------------- */
  function renderMissing() {
    var panel = $('#sched-missing-panel'); if (!panel) return;
    var tb = $('#sched-missing-table tbody');
    var list = state.missing || [];
    panel.hidden = !list.length;
    var cnt = $('#sched-missing-count'); if (cnt) cnt.textContent = list.length;
    if (!tb) return;
    tb.innerHTML = list.length ? list.map(function (r) {
      return '<tr><td class="code">' + esc(r.code) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.combo || '—') + '</td>'
        + '<td class="num">' + fmtNum(r.qty) + '</td><td class="sched-missing-reason">' + esc(r.reason) + '</td></tr>';
    }).join('') : '';
  }

  /* ---------------- 参数与动作 ---------------- */
  function readCfgInputs() {
    var start = $('#sched-start').value || todayStr();
    var hours = parseFloat($('#sched-hours').value);
    var days = parseInt($('#sched-days').value, 10);
    var batchMax = parseFloat($('#sched-batch-max').value);
    state.cfg.start = start;
    state.cfg.hours = hours > 0 ? hours : 8;
    state.cfg.days = days >= 1 && days <= 14 ? days : 3;
    state.cfg.batchMax = batchMax > 0 ? batchMax : 0;
    state.cfg.incChange = $('#sched-inc-change').checked;
    state.cfg.incPick = $('#sched-inc-pick').checked;
    state.cfg.confirmer = String($('#sched-confirmer').value || '').trim();
  }

  function generate() {
    readCfgInputs();
    saveCfg()
      .then(loadAll)
      .then(function () {
        refresh();
        return persistSuggestions();
      })
      .then(loadAll)
      .then(function () {
        refresh();
        toast('已生成未来 ' + state.cfg.days + ' 天排产建议（' + state.planRows.filter(function (t) { return t.status === '建议'; }).length + ' 条）', 'ok');
      })
      .catch(function (e) { toast('生成失败：' + (e.message || e), 'err'); });
  }

  function saveLineMap() {
    var edits = Object.keys(state.lineEdits);
    if (!edits.length) { toast('没有需要保存的映射修改', 'warn'); return; }
    var ts = nowStr();
    var rows = edits.map(function (combo) {
      var i = combo.indexOf('-');
      var r = state.lineEdits[combo];
      return {
        产品形态: i > 0 ? combo.slice(0, i) : combo,
        包装形式: i > 0 ? combo.slice(i + 1) : '',
        生产线: r.line || '',
        默认工段编号: r.section || '',
        更新时间: ts
      };
    });
    DB.bulkPut('line_map', rows)
      .then(function () {
        return DB.log({ 操作类型: '更新工艺形态映射', 详情: { 条数: rows.length, 明细: rows.map(function (r) {
          return r.产品形态 + (r.包装形式 ? '-' + r.包装形式 : '') + ' → 产线 ' + (r.生产线 || '未分配') + ' / 工段 ' + (r.默认工段编号 || '自动');
        }) } });
      })
      .then(function () {
        rows.forEach(function (r) {
          var key = comboKey(r.产品形态, r.包装形式);
          state.lineMap[key] = { line: r.生产线, section: r.默认工段编号 };
        });
        state.lineEdits = {};
        return loadAll();
      })
      .then(function () { refresh(); toast('工艺形态映射已保存（' + rows.length + ' 条）', 'ok'); })
      .catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  function saveSkuLine(code, line) {
    DB.get('material', code).then(function (m) {
      if (!m) throw new Error('物料主数据中不存在该编码');
      m.生产线 = line || '';
      return DB.put('material', m).then(function () {
        return DB.log({ 操作类型: '更新成品产线', 详情: { 物料编码: code, 物料名称: m.物料名称, 生产线: line || '未分配' } });
      });
    }).then(function () { return loadAll(); })
      .then(function () { refresh(); toast('产线已保存到物料主数据', 'ok'); })
      .catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  /* ---------------- 期初批次导入 / 模板 ---------------- */
  function toDateStr(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
    if (typeof v === 'number' && v > 20000) {
      var d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
    }
    var s = String(v).trim().replace(/[./]/g, '-');
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? (m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3])) : s;
  }

  function importOpening(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        var ts = nowStr();
        var add = 0, upd = 0, skip = 0;
        var pending = [];
        rows.forEach(function (raw) {
          var code = String(raw['物料编码'] || raw['编码'] || '').trim();
          var batch = String(raw['批次号'] || '').trim();
          var qty = parseFloat(raw['数量'] || raw['数量(箱)'] || raw['完工数量'] || 0);
          if (!code || !batch || !(qty > 0)) { skip++; return; }
          var m = state.matMap[code] || {};
          var existed = state.orders.filter(function (o) { return o.类型 === '期初' && o.物料编码 === code && o.批次号 === batch; })[0];
          var rec = existed ? Object.assign({}, existed) : {
            订单号: 'OPEN-' + batch, 批次号: batch, 物料编码: code, 物料名称: m.物料名称 || '',
            产品形态: m.产品形态 || '', 包装形式: m.包装形式 || '', 生产线: String(raw['产线'] || m.生产线 || ''),
            生产日期: '', 计划数量: qty, 完工数量: qty, 班组: String(raw['班组'] || '').trim().toUpperCase(),
            类型: '期初', 状态: '已完工', 排产日期: '', 工段编号: '', 工段名称: '', 设备类型: '', 单件工时: 0,
            备注: String(raw['备注'] || ''), 创建时间: ts, 完工时间: ts, 修改记录: []
          };
          rec.计划数量 = qty;
          rec.完工数量 = qty;
          rec.生产日期 = toDateStr(raw['生产日期'] || raw['日期'] || '') || todayStr();
          if (!existed) add++; else upd++;
          rec.修改记录 = (rec.修改记录 || []).concat([{ 时间: ts, 内容: '期初批次导入：数量 ' + qty + '，生产日期 ' + rec.生产日期 }]);
          pending.push(rec);
        });
        if (!pending.length) { toast('没有可导入的数据，请检查模板列名', 'err'); skip++; }
        return DB.bulkPut('prodorder', pending)
          .then(function () {
            return DB.log({ 操作类型: '期初批次导入', 详情: { 新增: add, 更新: upd, 跳过: skip, 文件名: file.name } });
          })
          .then(function () { return loadAll(); })
          .then(function () {
            refresh();
            toast('期初批次导入完成：新增 ' + add + ' 条，更新 ' + upd + ' 条，跳过 ' + skip + ' 条', skip ? 'warn' : 'ok');
          });
      } catch (err) {
        toast('导入失败：' + (err.message || err), 'err');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function downloadTemplate() {
    var rows = [
      { 物料编码: '示例-0001', 批次号: '示例-0001-20261101-A', 数量: 120, 生产日期: '2026-11-01', 产线: 'L02', 班组: 'A', 备注: '上线前期初库存' }
    ];
    var ws = XLSX.utils.json_to_sheet(rows, { header: ['物料编码', '批次号', '数量', '生产日期', '产线', '班组', '备注'] });
    ws['!cols'] = [{ wch: 18 }, { wch: 26 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 24 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '期初批次');
    XLSX.writeFile(wb, '期初批次导入模板.xlsx');
  }

  /* ---------------- 导出 Excel ---------------- */
  function exportXlsx() {
    var wb = XLSX.utils.book_new();

    var d1 = state.demand.map(function (r) {
      return {
        优先级: 'P' + r.priority, 来源: sourceText(r), 物料编码: r.code, 物料名称: r.name,
        产品系列: r.series, 工艺形态: r.combo, 需求数量: round2(r.qty), 需求日期: r.date || '',
        分配产线: lineLabel(r.line), 默认工段: r.sectionCode ? (r.sectionCode + ' ' + (r.sectionName || '')) : '',
        设备类型: r.deviceType || '', 单件工时: round2(r.unitHours || 0),
        所需工时: round2(r.hours || 0), 已排数量: round2(r.scheduled), 待排数量: round2(r.remaining),
        齐套: r.kitStatus, 欠货: round2(r.sources['欠货'] || 0), 备货缺口: round2(r.sources['备货'] || 0),
        月计划剩余: round2(r.sources['月计划'] || 0)
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d1), '排产需求');

    var d2 = (state.planRows || []).map(function (t) {
      return {
        下料日期: t.date, 生产线: lineLabel(t.line), 设备类型: t.deviceType || '',
        工段: (t.sectionCode || '') + (t.sectionName ? ' ' + t.sectionName : ''),
        物料编码: t.code, 物料名称: (state.matMap[t.code] || {}).物料名称 || '',
        计划数量: round2(t.qty), 所需工时: round2(t.hours), 优先级: 'P' + t.priority,
        来源: t.source, 状态: t.status === '已确认' ? '已确认' : '建议'
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d2), '未来排产');

    var d3 = (state.orders || []).map(function (o) {
      return {
        订单号: o.订单号, 类型: o.类型 || '生产', 状态: o.状态, 排产日期: o.排产日期 || '',
        生产线: lineLabel(o.生产线), 物料编码: o.物料编码, 物料名称: o.物料名称,
        计划数量: o.计划数量, 完工数量: o.完工数量, 批次号: o.批次号 || '', 班组: o.班组 || '',
        生产日期: o.生产日期 || '', 工段: (o.工段编号 || '') + (o.工段名称 ? ' ' + o.工段名称 : ''), 设备类型: o.设备类型 || '', 备注: o.备注 || ''
      };
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d3), '生产订单');

    var d4 = [];
    batchComposition().forEach(function (r) {
      if (!r.alloc.length && r.legacy <= 0.0001) return;
      r.alloc.forEach(function (a) {
        var o = a.order;
        d4.push({
          物料编码: r.code, 物料名称: r.name, 当前库存: round2(r.stock), 批次号: o.批次号,
          生产日期: o.生产日期 || '', 生产线: lineLabel(o.生产线), 班组: o.班组 || '',
          订单号: o.订单号 || '', 批次数量: round2(a.qty), 当前剩余: round2(a.remain),
          期初无批次: ''
        });
      });
      if (r.legacy > 0.0001) {
        d4.push({
          物料编码: r.code, 物料名称: r.name, 当前库存: round2(r.stock), 批次号: '期初无批次',
          生产日期: '', 生产线: '', 班组: '', 订单号: '', 批次数量: '', 当前剩余: round2(r.legacy),
          期初无批次: round2(r.legacy)
        });
      }
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d4), '库存批次构成');

    XLSX.writeFile(wb, '排产分析_' + todayStr().replace(/-/g, '') + '.xlsx');
    toast('已导出排产分析 Excel', 'ok');
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    if (state.bound) return;
    state.bound = true;

    $('#sched-generate').addEventListener('click', generate);
    $('#sched-export').addEventListener('click', exportXlsx);
    $('#sched-line-save').addEventListener('click', saveLineMap);

    $('#sched-line-search').addEventListener('input', function () { state.lineKeyword = this.value.trim(); renderLineMap(); });
    $('#sched-search').addEventListener('input', function () { state.keyword = this.value.trim(); renderDemand(); });
    $('#sched-line-filter').addEventListener('change', function () { state.lineFilter = this.value; renderDemand(); });
    $('#sched-source-filter').addEventListener('change', function () { state.sourceFilter = this.value; renderDemand(); });

    $('#sched-status-filter').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-st]');
      if (!btn) return;
      state.statusFilter = btn.getAttribute('data-st');
      $$('#sched-status-filter button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      renderDemand();
    });

    $('#sched-line-table').addEventListener('change', function (e) {
      var sel = e.target.closest('select[data-combo]');
      if (!sel) return;
      var combo = sel.getAttribute('data-combo');
      var field = sel.getAttribute('data-field');
      if (!state.lineEdits[combo]) state.lineEdits[combo] = currentRecForCombo(combo, combo.split('-')[0]);
      state.lineEdits[combo][field] = sel.value;
      /* 换了产线后默认工段可能不在该产线，清掉让用户重新选 */
      if (field === 'line' && state.lineEdits[combo].section) {
        var sec = state.worksections.filter(function (w) { return w.工段编号 === state.lineEdits[combo].section; })[0];
        if (!sec || sec.生产线 !== sel.value) state.lineEdits[combo].section = '';
      }
      renderLineMap();
    });

    $('#sched-demand-table').addEventListener('click', function (e) {
      var btn = e.target.closest('.sched-detail-btn');
      if (!btn) return;
      var code = btn.getAttribute('data-code');
      state.expanded[code] = !state.expanded[code];
      renderDemand();
    });
    $('#sched-demand-table').addEventListener('change', function (e) {
      var sel = e.target.closest('select[data-code]');
      if (!sel) return;
      saveSkuLine(sel.getAttribute('data-code'), sel.value);
    });

    /* 推荐排产清单事件 */
    var sugTable = $('#sched-suggest-table');
    if (sugTable) {
      sugTable.addEventListener('click', function (e) {
        /* 数量调整按钮 */
        var minus = e.target.closest('.sched-qty-minus');
        var plus = e.target.closest('.sched-qty-plus');
        if (minus || plus) {
          var code = (minus || plus).getAttribute('data-code');
          var date = (minus || plus).getAttribute('data-date');
          var current = +(minus || plus).getAttribute('data-qty') || 0;
          var newQty = plus ? current + 1 : Math.max(0, current - 1);
          applyQtyOverride(date, code, newQty);
          return;
        }
        /* 移除按钮 */
        var rm = e.target.closest('.sched-remove-row');
        if (rm) {
          removeTaskRow(rm.getAttribute('data-code'), rm.getAttribute('data-date'));
          return;
        }
      });
      sugTable.addEventListener('change', function (e) {
        var inp = e.target.closest('.sched-qty-input');
        if (!inp) return;
        var code = inp.getAttribute('data-code');
        var date = inp.getAttribute('data-date');
        var qty = Math.max(0, Math.floor(+inp.value || 0));
        applyQtyOverride(date, code, qty);
      });
    }
    var sugFoot = $('#sched-suggest-foot');
    if (sugFoot) {
      sugFoot.addEventListener('click', function (e) {
        var addBtn = e.target.closest('#sched-suggest-add');
        if (addBtn) { openManualAdd(); return; }
        var cfBtn = e.target.closest('#sched-suggest-confirm');
        if (cfBtn) { confirmAllSuggestions(); return; }
      });
    }

    /* 顶部日期切换事件（点哪个日期就切到哪个） */
    var tabsTop = $('#sched-day-tabs-top');
    if (tabsTop) {
      tabsTop.addEventListener('click', function (e) {
        var btn = e.target.closest('.sched-day-tab-btn[data-day]');
        if (!btn) return;
        state.dayTab = btn.getAttribute('data-day');
        renderDayTabsTop();
        renderSuggestions();
        renderDay();
      });
    }

    /* 设备组卡片区域事件（确认本组 / 撤销） */
    var dayBody = $('#sched-day-body');
    if (dayBody) {
      dayBody.addEventListener('click', function (e) {
        var c = e.target.closest('.sched-confirm-day');
        if (c) { confirmDay(c.getAttribute('data-day'), c.getAttribute('data-group')); return; }
        var r = e.target.closest('.sched-revoke-day');
        if (r) { revokeDay(r.getAttribute('data-day')); return; }
      });
    }

    function applyQtyOverride(date, code, newQty) {
      var task = (state.dayTasks[date] || {})[lineOf(code)];
      task = task ? task.filter(function (t) { return t.code === code; })[0] : null;
      if (!task) return;
      var oldQty = task.qty;
      var oldHours = task.hours;
      var r = state.demand.filter(function (x) { return x.code === code; })[0];
      var setupHours = r ? r.setupHours : 0;
      var firstChunk = true;
      var newHours = newQty * (r ? r.unitHours : 1) + (firstChunk ? setupHours : 0);
      var delta = newHours - oldHours;
      state.used[date + '|' + task.line] = Math.max(0, (state.used[date + '|' + task.line] || 0) + delta);
      task.qty = newQty;
      task.hours = newHours;
      /* 数量调为 0 视为去掉当天任务，标记 override 为 null */
      if (newQty <= 0) {
        state.dayOverrides[date + '|' + code] = { qty: 0 };
        /* 从 dayTasks 中移除 */
        var list = state.dayTasks[date][task.line] || [];
        state.dayTasks[date][task.line] = list.filter(function (t) { return !(t.date === date && t.code === code); });
      } else {
        state.dayOverrides[date + '|' + code] = { qty: newQty };
      }
      r.scheduled = Math.max(0, (r.scheduled || 0) + (newQty - oldQty));
      r.remaining = Math.max(0, r.qty - r.scheduled);
      renderKpi();
      renderDemand();
      renderSuggestions();
      renderDay();
    }

    /* 从推荐清单里移除一行（仅建议状态） */
    function removeTaskRow(code, date) {
      var info = sectionInfoOf(code);
      var line = info.line || lineOf(code);
      var list = (state.dayTasks[date] || {})[line] || [];
      var task = list.filter(function (t) { return t.code === code; })[0];
      if (!task) { toast('未找到该排产任务', 'err'); return; }
      if (task.status !== '建议') { toast('已确认的任务不能移除', 'err'); return; }
      var r = state.demand.filter(function (x) { return x.code === code; })[0];
      if (r) {
        r.scheduled = Math.max(0, (r.scheduled || 0) - task.qty);
        r.remaining = Math.max(0, r.qty - r.scheduled);
      }
      var hoursDelta = task.hours;
      state.used[date + '|' + line] = Math.max(0, (state.used[date + '|' + line] || 0) - hoursDelta);
      list = list.filter(function (t) { return !(t.code === code); });
      state.dayTasks[date][line] = list;
      delete state.dayOverrides[date + '|' + code];
      toast('已移除 ' + code + ' 在 ' + date + ' 的排产', 'ok');
      renderKpi(); renderDemand(); renderSuggestions(); renderDay();
    }

    /* 批量确定当前选中日期的所有建议任务 */
    function confirmAllSuggestions() {
      var date = state.dayTab;
      var all = pickSuggestedTasks(date);
      if (!all.length) { toast(date + ' 没有可确定的建议任务', 'warn'); return; }
      if (!confirm('确定 ' + date + ' 全部 ' + all.length + ' 条建议排产，并生成待生产订单？')) return;
      var confirmer = String(state.cfg.confirmer || '').trim();
      if (!confirmer) { toast('请先在排产参数中填写确认人', 'warn'); return; }
      var ts = nowStr();
      persistTasksToSchedule(all)
        .then(function () {
          all.forEach(function (t) { t.status = '已确认'; t.确认人 = confirmer; t.确认时间 = ts; });
          return confirmTasks(date, all, confirmer, ts);
        })
        .then(function () { return loadAll(); })
        .then(function () {
          refresh();
          toast('已确定 ' + all.length + ' 条排产，生成待生产订单', 'ok');
        })
        .catch(function (e) { toast('确定失败：' + (e.message || e), 'err'); console.error(e); });
    }

    /* 手动补充产品：弹窗选 SKU + 日期 + 数量 */
    function openManualAdd() {
      if (!state.materials.length) { toast('暂无成品物料主数据', 'warn'); return; }
      if (!state.dates || !state.dates.length) { toast('请先生成排产建议', 'warn'); return; }
      var html = '<div class="inline-form" id="manual-add-form">'
        + '<label>日期* <select id="ma-date">'
        + state.dates.map(function (d) { return '<option value="' + esc(d) + '">' + esc(d) + '（' + weekLabel(d) + '）</option>'; }).join('')
        + '</select></label>'
        + '<label>物料编码* <select id="ma-code">'
        + state.materials.map(function (m) {
            var info = sectionInfoOf(m.物料编码, m);
            return '<option value="' + esc(m.物料编码) + '">' + esc(m.物料编码) + ' ' + esc(m.物料名称 || '') + ' [' + esc(info.line || '未分配') + ']</option>';
          }).join('')
        + '</select></label>'
        + '<label>数量(箱)* <input type="number" min="1" step="1" id="ma-qty" value="10"></label>'
        + '<div class="inline-form-actions">'
        + '<button class="btn btn-primary btn-sm" id="ma-ok">确认添加</button> '
        + '<button class="btn btn-sm" id="ma-cancel">取消</button></div></div>';
      $('#modal-title').textContent = '手动补充排产';
      $('#modal-body').innerHTML = html;
      $('#modal-mask').hidden = false;
      $('#ma-cancel').onclick = function () { $('#modal-mask').hidden = true; };
      $('#ma-ok').onclick = function () {
        var date = $('#ma-date').value;
        var code = $('#ma-code').value;
        var qty = Math.max(1, Math.floor(+$('#ma-qty').value || 0));
        addManualTask(date, code, qty);
        $('#modal-mask').hidden = true;
      };
    }

    function addManualTask(date, code, qty) {
      var info = sectionInfoOf(code);
      if (!info.line) { toast('该物料未映射生产线', 'err'); return; }
      var labor = laborOf(code);
      if (labor.missing) { toast('无法排产：' + labor.missing, 'err'); return; }
      var list = (state.dayTasks[date] = state.dayTasks[date] || {});
      (list[info.line] = list[info.line] || []);
      /* 检查当天是否已有该 SKU */
      var exist = list[info.line].filter(function (t) { return t.code === code; })[0];
      if (exist) {
        toast('当天已有该产品排产，已合并数量', 'warn');
        exist.qty = (exist.qty || 0) + qty;
        var r = state.demand.filter(function (x) { return x.code === code; })[0];
        if (r) {
          exist.hours = exist.qty * r.unitHours + (exist.firstChunk ? r.setupHours : 0);
          state.used[date + '|' + info.line] = (state.used[date + '|' + info.line] || 0) + exist.hours - ((exist._prevHours) || 0);
          exist._prevHours = exist.hours;
        }
      } else {
        var hours = qty * labor.unitHours + labor.setupHours;
        (list[info.line] = list[info.line] || []).push({
          date: date, line: info.line, code: code, qty: qty, hours: hours,
          priority: 9, source: '手动补充', sectionCode: info.sectionCode,
          sectionName: info.sectionName, deviceType: info.deviceType,
          status: '建议', name: (state.matMap[code] || {}).物料名称 || ''
        });
        state.used[date + '|' + info.line] = (state.used[date + '|' + info.line] || 0) + hours;
      }
      toast('已添加 ' + code + ' ' + qty + ' 箱到 ' + date, 'ok');
      renderKpi(); renderDemand(); renderSuggestions(); renderDay();
    }

    $('#sched-order-status').addEventListener('change', function () { state.orderStatus = this.value; renderOrders(); });
    $('#sched-order-search').addEventListener('input', function () { state.orderKeyword = this.value.trim(); renderOrders(); });
    $('#sched-order-table').addEventListener('click', function (e) {
      var btn = e.target.closest('.sched-complete-btn');
      if (btn) openComplete(btn.getAttribute('data-id'));
    });

    $('#sched-batch-search').addEventListener('input', function () { state.batchKeyword = this.value.trim(); renderBatches(); });
    $('#sched-batch-scope').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-scope]');
      if (!btn) return;
      state.batchScope = btn.getAttribute('data-scope');
      $$('#sched-batch-scope button').forEach(function (b) { b.classList.toggle('active', b === btn); });
      renderBatches();
    });
    $('#sched-batch-table').addEventListener('click', function (e) {
      var btn = e.target.closest('.sched-batch-btn');
      if (!btn) return;
      var code = btn.getAttribute('data-code');
      state.expandedBatches[code] = !state.expandedBatches[code];
      renderBatches();
    });

    $('#sched-complete-close').addEventListener('click', closeComplete);
    $('#sched-complete-cancel').addEventListener('click', closeComplete);
    $('#sched-complete-save').addEventListener('click', saveComplete);
    $('#sched-complete-mask').addEventListener('click', function (e) {
      if (e.target === this) closeComplete();
    });
    function syncBatch() {
      var o = state.completeOrder;
      if (!o || state.batchDirty) return;
      $('#sc-batch').value = suggestBatch(o.物料编码, $('#sc-date').value, $('#sc-team').value);
    }
    $('#sc-date').addEventListener('change', syncBatch);
    $('#sc-team').addEventListener('input', syncBatch);
    $('#sc-batch').addEventListener('input', function () { state.batchDirty = true; });

    $('#sched-opening-tpl').addEventListener('click', downloadTemplate);
    $('#sched-opening-import').addEventListener('click', function () { $('#sched-opening-file').value = ''; $('#sched-opening-file').click(); });
    $('#sched-opening-file').addEventListener('change', function () {
      if (this.files && this.files[0]) importOpening(this.files[0]);
    });
  }

  /* ---------------- 初始化 / 对外接口 ---------------- */
  var cfgReady = null;
  function init() {
    bindEvents();
    if (!cfgReady) cfgReady = loadCfg();
    return cfgReady;
  }
  function render() {
    return init().then(loadAll).then(function () {
      state.initialized = true;
      refresh();
    }).catch(function (e) {
      toast('排产数据加载失败：' + (e.message || e), 'err');
    });
  }

  global.ScheduleView = { init: init, render: render, state: state };
})(window);
