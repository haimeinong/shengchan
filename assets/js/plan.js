/* ============================================================
 * plan.js — 二期：月度生产规划
 * 推荐算法（同比趋势法）：
 *   推荐生产(箱) = 去年同期同月发货量 × (今年上月发货量 ÷ 去年上月发货量)
 *   发货量 = 该月最后一条成品快照的月累计"出库数量"；入库量同口径取"入库数量"
 *   兜底：缺去年上月→系数按 1；缺去年同期→参考今年上月；都缺→推荐值为空
 * 流程：生成推荐(草稿) → 专人确认(已确认，记录确认人/时间) → 确认后仍可改数量并留痕
 * 对比：实际入库(当月累计) − 计划数量 = 差额；入库/计划 = 达成率
 * 存储：fact_plan_monthly  key:[月份,物料编码]
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 本地辅助（自包含，风格同 replenish.js） ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $all(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) { if (n == null || n === '' || isNaN(n)) return '—'; return (Math.round(n * 100) / 100).toLocaleString('zh-CN'); }
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    var w = $('#toast-wrap');
    if (w) {
      w.appendChild(el);
      setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
      setTimeout(function () { el.remove(); }, 3000);
    } else { alert(msg); }
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function nowStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function curMonth() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }
  /* 月份加减 n 个月，ym 格式 YYYY-MM */
  function addMonths(ym, n) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) + n;
    while (m <= 0) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    return y + '-' + pad2(m);
  }
  function prevMonthOf(ym) { return addMonths(ym, -1); }
  function lastYearMonthOf(ym) { return (+ym.slice(0, 4) - 1) + ym.slice(4); }

  /* ---------------- 内部状态 ---------------- */
  var state = {
    materials: [],      // 成品物料
    byCode: {},         // 物料编码 → 按日期升序的成品快照数组
    plans: {},          // 物料编码 → 计划记录（选中月份）
    month: curMonth(),  // 选中月份 YYYY-MM
    keyword: '',
    filterStatus: '',   // ''|草稿|已确认
    checked: {},        // 勾选的物料编码
    expanded: ''        // 展开详情行的物料编码
  };

  /* ---------------- 数据加载 ---------------- */
  function loadAll() {
    return Promise.all([DB.all('material'), DB.all('stock'), DB.all('plan')]).then(function (r) {
      state.materials = (r[0] || []).filter(function (m) { return (m.库存属性 || '成品') === '成品'; })
        .sort(function (a, b) {
          var sa = (a.产品系列 || '') + '|' + a.物料编码, sb = (b.产品系列 || '') + '|' + b.物料编码;
          return sa < sb ? -1 : sa > sb ? 1 : 0;
        });
      state.byCode = {};
      (r[1] || []).forEach(function (s) {
        if (s.库存类型 !== '成品') return;
        (state.byCode[s.物料编码] = state.byCode[s.物料编码] || []).push(s);
      });
      Object.keys(state.byCode).forEach(function (code) {
        state.byCode[code].sort(function (a, b) { return a.日期 < b.日期 ? -1 : a.日期 > b.日期 ? 1 : 0; });
      });
      state.plans = {};
      (r[2] || []).forEach(function (p) { if (p.月份 === state.month) state.plans[p.物料编码] = p; });
      state.checked = {};
      state.expanded = '';
    });
  }

  /* ---------------- 月度口径计算 ---------------- */
  /** 某物料在某月"月末最后一条快照"的累计字段值（出库数量/入库数量），无快照返回 null */
  function monthQty(code, ym, field) {
    var rows = state.byCode[code] || [], hit = null;
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i];
      if (s.日期 >= ym + '-01' && s.日期 <= ym + '-31') hit = s;
    }
    return hit ? (+hit[field] || 0) : null;
  }

  /** 某物料在某月"首条快照"的字段值（期初语义，如 初期库存 = 月初结余） */
  function monthFirstQty(code, ym, field) {
    var rows = state.byCode[code] || [];
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i];
      if (s.日期 >= ym + '-01' && s.日期 <= ym + '-31') {
        var v = s[field];
        return (v == null || v === '') ? null : +v;
      }
    }
    return null;
  }

  /** 同比趋势法推荐值与依据 */
  function recommendFor(code) {
    var ym = state.month;
    var lySame = monthQty(code, lastYearMonthOf(ym), '出库数量');
    var tyPrev = monthQty(code, prevMonthOf(ym), '出库数量');
    var lyPrev = monthQty(code, lastYearMonthOf(prevMonthOf(ym)), '出库数量');
    var ratio = (lyPrev != null && lyPrev > 0 && tyPrev != null) ? tyPrev / lyPrev : null;
    var rec = null;
    if (lySame != null && ratio != null) rec = Math.round(lySame * ratio);
    else if (lySame != null) rec = Math.round(lySame);          /* 系数缺失按 1 */
    else if (tyPrev != null) rec = Math.round(tyPrev);          /* 无去年同期参考上月 */
    if (rec != null && rec < 0) rec = 0;
    return { rec: rec, basis: { 去年同期: lySame, 今年上月: tyPrev, 去年上月: lyPrev, 系数: ratio } };
  }

  /** 行展示数据：物料 + 计划记录 + 推荐 + 入库对比 */
  function rowOf(m) {
    var code = m.物料编码;
    var p = state.plans[code] || null;
    var r = recommendFor(code);
    var inQty = monthQty(code, state.month, '入库数量');
    var openQty = monthFirstQty(code, state.month, '初期库存');
    var planQty = p && p.计划数量 !== '' && p.计划数量 != null ? +p.计划数量 : null;
    var diff = (inQty != null && planQty != null) ? inQty - planQty : null;
    var rate = (inQty != null && planQty != null && planQty > 0) ? inQty / planQty : null;
    return { mat: m, code: code, plan: p, rec: r.rec, basis: r.basis, openQty: openQty, inQty: inQty, planQty: planQty, diff: diff, rate: rate };
  }

  /* ---------------- 渲染 ---------------- */
  function renderKpi() {
    var rows = state.materials.map(rowOf);
    var confirmed = rows.filter(function (r) { return r.plan && r.plan.状态 === '已确认'; });
    var planSum = 0, inSum = 0;
    rows.forEach(function (r) {
      if (r.planQty != null) planSum += r.planQty;
      if (r.inQty != null) inSum += r.inQty;
    });
    $('#plan-kpi-sku').textContent = rows.length;
    $('#plan-kpi-confirmed').textContent = confirmed.length;
    $('#plan-kpi-qty').textContent = fmtNum(planSum);
    $('#plan-kpi-in').textContent = fmtNum(inSum);
    $('#plan-kpi-rate').textContent = planSum > 0 ? Math.round(inSum / planSum * 100) + '%' : '—';
  }

  function ratioCell(basis) {
    if (basis.系数 == null) return '<span class="muted">—</span>';
    var v = Math.round(basis.系数 * 100) / 100;
    var warn = v > 2 || v < 0.5;   /* 同比倍率异常波动提示人工复核 */
    return '<span class="' + (warn ? 'plan-ratio-warn' : '') + '" title="今年上月 ÷ 去年上月' + (warn ? '，波动较大请复核' : '') + '">×' + v + '</span>';
  }

  function statusCell(p) {
    if (!p || p.状态 !== '已确认') return '<span class="repl-badge off">草稿</span>';
    return '<span class="repl-badge ok" title="' + esc((p.确认人 || '') + ' ' + (p.确认时间 || '')) + '">已确认</span>'
      + (p.确认人 ? '<div class="muted">' + esc(p.确认人) + '</div>' : '');
  }

  function detailRow(r, colspan) {
    var p = r.plan, b = r.basis;
    /* 本年 1–12 月发货趋势：每月并列「去年同月 + 今年同月」双柱 */
    var curYear = state.month.slice(0, 4), prevYear = String(+curYear - 1);
    var months = [], maxV = 1;
    for (var i = 0; i < 12; i++) {
      var mm = (i < 9 ? '0' : '') + (i + 1);
      var vCur = monthQty(r.code, curYear + '-' + mm, '出库数量');
      var vPrev = monthQty(r.code, prevYear + '-' + mm, '出库数量');
      months.push({ mm: mm, cur: curYear + '-' + mm, prev: prevYear + '-' + mm, vCur: vCur, vPrev: vPrev });
      if (vCur != null && vCur > maxV) maxV = vCur;
      if (vPrev != null && vPrev > maxV) maxV = vPrev;
    }
    var W = 460, H = 128, PT = 26, PB = 18, plotH = H - PT - PB, gw = (W - 8) / 12, bw = (gw - 6) / 2;
    function bar(x, v, ym, fill) {
      if (v == null) return '';
      var h = Math.max(2, v / maxV * plotH);
      return '<rect x="' + x.toFixed(1) + '" y="' + (H - PB - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5" fill="' + fill + '">'
        + '<title>' + ym + ' 发货 ' + fmtNum(v) + ' 箱</title></rect>';
    }
    var bars = months.map(function (mo, idx) {
      var gx = 4 + idx * gw;
      var fillCur = mo.cur === state.month ? '#1d4ed8' : '#2563eb';
      return bar(gx + 3, mo.vPrev, mo.prev, '#cbd5e1')
        + bar(gx + 3 + bw + 2, mo.vCur, mo.cur, fillCur)
        + '<text x="' + (gx + gw / 2).toFixed(1) + '" y="' + (H - 5) + '" text-anchor="middle" font-size="9" fill="#94a3b8">' + mo.mm + '</text>';
    }).join('');
    var legend = '<rect x="4" y="6" width="8" height="8" rx="1.5" fill="#2563eb"/>'
      + '<text x="16" y="13.5" font-size="9" fill="#64748b">今年</text>'
      + '<rect x="46" y="6" width="8" height="8" rx="1.5" fill="#cbd5e1"/>'
      + '<text x="58" y="13.5" font-size="9" fill="#64748b">去年</text>';
    var chart = '<svg class="plan-mini-chart" viewBox="0 0 ' + W + ' ' + H + '">' + legend + bars + '</svg>';

    var metaFields = [
      ['产品名称', r.mat.物料名称],
      ['所属系列', r.mat.产品系列],
      ['子分类', r.mat['子分类(包装形态)']],
      ['规格型号', r.mat.规格型号],
      ['产品形态', r.mat.产品形态],
      ['包装形式', r.mat.包装形式]
    ];
    var metaHtml = '<div class="plan-meta">' + metaFields.map(function (f) {
      return '<div class="plan-meta-item"><span>' + esc(f[0]) + '</span><b>' + esc(f[1] || '—') + '</b></div>';
    }).join('') + '</div>';

    var basisHtml = '<div class="plan-basis">'
      + '<span>推荐依据：</span>'
      + '去年同期(' + lastYearMonthOf(state.month) + ')发货 <b>' + fmtNum(b.去年同期) + '</b> 箱 · '
      + '今年上月(' + prevMonthOf(state.month) + ')发货 <b>' + fmtNum(b.今年上月) + '</b> 箱 · '
      + '去年上月(' + lastYearMonthOf(prevMonthOf(state.month)) + ')发货 <b>' + fmtNum(b.去年上月) + '</b> 箱 · '
      + '系数 <b>' + (b.系数 == null ? '—' : '×' + (Math.round(b.系数 * 100) / 100)) + '</b>'
      + (p && p.推荐依据 ? '<div class="muted">生成时快照：去年同期 ' + fmtNum(p.推荐依据.去年同期) + ' / 今年上月 ' + fmtNum(p.推荐依据.今年上月) + ' / 系数 ' + (p.推荐依据.系数 == null ? '—' : '×' + (Math.round(p.推荐依据.系数 * 100) / 100)) + '</div>' : '')
      + '</div>';

    var logs = (p && p.修改记录 && p.修改记录.length) ? p.修改记录.slice().reverse() : [];
    var logHtml = '<div class="plan-changes"><b>修改记录</b>'
      + (logs.length
        ? '<ul>' + logs.map(function (g) {
            return '<li>' + esc(g.时间) + '　' + esc(g.操作 || '编辑') + '：' + esc(g.原值) + ' → <b>' + esc(g.新值) + '</b></li>';
          }).join('') + '</ul>'
        : '<div class="muted">暂无修改记录</div>')
      + '</div>';

    var noteHtml = '<div class="plan-note">备注：<input type="text" class="plan-note-input" data-code="' + esc(r.code) + '" maxlength="60" placeholder="业务调整说明（可选）" value="' + esc(p && p.备注 || '') + '"></div>';

    return '<tr class="plan-detail-row"><td colspan="' + colspan + '">'
      + '<div class="plan-detail">'
      + '<div class="plan-detail-left"><b>发货趋势（箱）· 今年 vs 去年（1–12 月）</b>' + chart + '</div>'
      + '<div class="plan-detail-right">' + metaHtml + basisHtml + noteHtml + logHtml + '</div>'
      + '</div></td></tr>';
  }

  function renderTable() {
    var tb = $('#plan-table tbody'); if (!tb) return;
    var kw = state.keyword.toLowerCase();
    var rows = state.materials.map(rowOf).filter(function (r) {
      if (state.filterStatus === '草稿' && r.plan && r.plan.状态 === '已确认') return false;
      if (state.filterStatus === '已确认' && (!r.plan || r.plan.状态 !== '已确认')) return false;
      var m = r.mat;
      if (kw && [r.code, m.物料名称, m.产品系列, m['子分类(包装形态)']].join(' ').toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="15" class="empty">无符合条件的成品（请先在数据导入中导入成品库存快照）</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (r) {
      var p = r.plan;
      var confirmed = p && p.状态 === '已确认';
      var ck = state.checked[r.code] ? ' checked' : '';
      var diffCls = r.diff == null ? '' : (r.diff < 0 ? ' neg' : ' pos');
      html += '<tr data-code="' + esc(r.code) + '"' + (confirmed ? ' class="plan-row-confirmed"' : '') + '>'
        + '<td><input type="checkbox" class="plan-check" data-code="' + esc(r.code) + '"' + ck + '></td>'
        + '<td class="code">' + esc(r.code) + '</td>'
        + '<td>' + esc(r.mat.物料名称 || '') + '</td>'
        + '<td>' + esc(r.mat.产品系列 || '') + '</td>'
        + '<td class="num">' + fmtNum(r.basis.去年同期) + '</td>'
        + '<td class="num">' + fmtNum(r.basis.今年上月) + '</td>'
        + '<td class="num">' + fmtNum(r.openQty) + '</td>'
        + '<td class="num">' + ratioCell(r.basis) + '</td>'
        + '<td class="num plan-rec">' + fmtNum(r.rec) + '</td>'
        + '<td class="num"><input type="number" min="0" step="1" class="plan-qty-input" data-code="' + esc(r.code) + '" value="' + (r.planQty == null ? '' : r.planQty) + '" placeholder="—"></td>'
        + '<td class="num">' + fmtNum(r.inQty) + '</td>'
        + '<td class="num' + diffCls + '">' + (r.diff == null ? '—' : (r.diff > 0 ? '+' : '') + fmtNum(r.diff)) + '</td>'
        + '<td class="num">' + (r.rate == null ? '—' : Math.round(r.rate * 100) + '%') + '</td>'
        + '<td>' + statusCell(p) + '</td>'
        + '<td class="plan-op">'
        + (confirmed
            ? '<button class="btn btn-sm plan-unconfirm" data-code="' + esc(r.code) + '">撤销</button>'
            : '<button class="btn btn-primary btn-sm plan-confirm" data-code="' + esc(r.code) + '">确认</button>')
        + '<button class="btn btn-link btn-sm plan-toggle" data-code="' + esc(r.code) + '">' + (state.expanded === r.code ? '收起' : '详情') + '</button>'
        + '</td></tr>';
      if (state.expanded === r.code) html += detailRow(r, 15);
    });
    tb.innerHTML = html;
  }

  function renderBatchBar() {
    var bar = $('#plan-batch-bar'); if (!bar) return;
    var n = Object.keys(state.checked).length;
    bar.hidden = n === 0;
    $('#plan-batch-info').textContent = '已选 ' + n + ' 项';
  }

  function renderAll() { renderKpi(); renderTable(); renderBatchBar(); }

  /* ---------------- 写操作 ---------------- */
  function newPlanRow(code, rec, basis) {
    var ts = nowStr();
    return {
      月份: state.month, 物料编码: code,
      推荐数量: rec, 推荐依据: basis,
      计划数量: rec, 状态: '草稿',
      确认人: '', 确认时间: '', 备注: '',
      修改记录: [], 创建时间: ts, 更新时间: ts
    };
  }

  /** 生成/刷新推荐值：新成品建行；草稿行刷新推荐（未手改的计划数量跟随推荐值）；已确认行不动 */
  function generate() {
    var created = 0, refreshed = 0, kept = 0;
    var tasks = state.materials.map(function (m) {
      var code = m.物料编码;
      var r = recommendFor(code);
      var p = state.plans[code];
      if (p && p.状态 === '已确认') { kept++; return null; }
      if (!p) {
        p = newPlanRow(code, r.rec, r.basis);
        created++;
      } else {
        /* 草稿行：计划数量未被手改（等于旧推荐值或为空）时跟随新推荐值 */
        var untouched = p.计划数量 === '' || p.计划数量 == null || +p.计划数量 === +p.推荐数量;
        p.推荐数量 = r.rec;
        p.推荐依据 = r.basis;
        if (untouched) p.计划数量 = r.rec;
        p.更新时间 = nowStr();
        refreshed++;
      }
      return DB.put('plan', p);
    }).filter(Boolean);
    return Promise.all(tasks).then(function () {
      return DB.log({ 操作类型: '生产计划推荐生成', 详情: { 月份: state.month, 新建: created, 刷新草稿: refreshed, 保留已确认: kept } });
    }).then(function () {
      toast('推荐值已生成：新建 ' + created + ' 条，刷新草稿 ' + refreshed + ' 条，保留已确认 ' + kept + ' 条', 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('生成失败：' + (e.message || e), 'err'); });
  }

  function getConfirmer() {
    var inp = $('#plan-confirmer');
    var name = (inp ? inp.value : '').trim();
    if (!name) {
      toast('请先在上方工具栏填写确认人姓名', 'warn');
      if (inp) inp.focus();
      return null;
    }
    try { localStorage.setItem('plan_confirmer', name); } catch (e) {}
    return name;
  }

  function confirmOne(code) {
    var p = state.plans[code];
    if (!p) { toast('该物料尚无计划记录，请先生成推荐值', 'warn'); return; }
    if (p.计划数量 === '' || p.计划数量 == null) { toast('请先填写计划数量再确认', 'warn'); return; }
    var name = getConfirmer();
    if (name == null) return;
    p.状态 = '已确认';
    p.确认人 = name;
    p.确认时间 = nowStr();
    p.更新时间 = p.确认时间;
    DB.put('plan', p).then(function () {
      return DB.log({ 操作类型: '生产计划确认', 详情: { 月份: state.month, 物料编码: code, 计划数量: p.计划数量, 确认人: name } });
    }).then(function () {
      toast(code + ' 已确认（' + name + '）', 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('确认失败：' + (e.message || e), 'err'); });
  }

  function unconfirmOne(code) {
    var p = state.plans[code];
    if (!p) return;
    if (!confirm('将 ' + code + ' 的计划撤销回草稿状态？')) return;
    p.状态 = '草稿';
    p.更新时间 = nowStr();
    DB.put('plan', p).then(function () {
      return DB.log({ 操作类型: '生产计划撤销确认', 详情: { 月份: state.month, 物料编码: code, 原确认人: p.确认人 || '' } });
    }).then(function () {
      toast(code + ' 已撤销为草稿', 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('操作失败：' + (e.message || e), 'err'); });
  }

  function batchConfirm() {
    var codes = Object.keys(state.checked);
    if (!codes.length) return;
    var targets = codes.filter(function (c) {
      var p = state.plans[c];
      return p && p.状态 !== '已确认' && p.计划数量 !== '' && p.计划数量 != null;
    });
    if (!targets.length) { toast('选中项没有可确认的草稿（需已生成且填有计划数量）', 'warn'); return; }
    var name = getConfirmer();
    if (name == null) return;
    if (!confirm('确认选中的 ' + targets.length + ' 条生产计划？确认人：' + name)) return;
    var ts = nowStr();
    Promise.all(targets.map(function (c) {
      var p = state.plans[c];
      p.状态 = '已确认';
      p.确认人 = name;
      p.确认时间 = ts;
      p.更新时间 = ts;
      return DB.put('plan', p);
    })).then(function () {
      return DB.log({ 操作类型: '生产计划批量确认', 详情: { 月份: state.month, 条数: targets.length, 确认人: name, 编码: targets.join(',') } });
    }).then(function () {
      toast('已批量确认 ' + targets.length + ' 条计划', 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('批量确认失败：' + (e.message || e), 'err'); });
  }

  /** 计划数量编辑：草稿/已确认均可改，写修改记录；已确认的调整另写审计日志 */
  function editQty(code, raw, inputEl) {
    var v = raw.trim();
    if (v !== '' && (isNaN(+v) || +v < 0)) { toast('计划数量需为不小于 0 的数字', 'warn'); renderTable(); return; }
    var p = state.plans[code];
    if (!p) {
      if (v === '') return;
      var r = recommendFor(code);
      p = newPlanRow(code, r.rec, r.basis);
      state.plans[code] = p;
    }
    var oldV = p.计划数量 === '' || p.计划数量 == null ? '空' : p.计划数量;
    var newV = v === '' ? '' : +v;
    if (String(oldV) === String(newV)) return;
    var wasConfirmed = p.状态 === '已确认';
    p.修改记录 = p.修改记录 || [];
    p.修改记录.push({ 时间: nowStr(), 操作: wasConfirmed ? '确认后调整' : '草稿编辑', 原值: oldV, 新值: newV === '' ? '空' : newV });
    if (p.修改记录.length > 100) p.修改记录 = p.修改记录.slice(-100);
    p.计划数量 = newV;
    p.更新时间 = nowStr();
    DB.put('plan', p).then(function () {
      if (wasConfirmed) return DB.log({ 操作类型: '生产计划调整', 详情: { 月份: state.month, 物料编码: code, 原值: oldV, 新值: newV === '' ? '空' : newV } });
    }).then(function () {
      toast(code + ' 计划数量已保存', 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  function editNote(code, raw) {
    var p = state.plans[code];
    if (!p) {
      if (!raw.trim()) return;
      var r = recommendFor(code);
      p = newPlanRow(code, r.rec, r.basis);
      p.计划数量 = '';
      state.plans[code] = p;
    }
    p.备注 = raw.trim();
    p.更新时间 = nowStr();
    DB.put('plan', p).then(function () { toast('备注已保存', 'ok'); })
      .catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  /* ---------------- 初始化与事件 ---------------- */
  function init() {
    var monthInput = $('#plan-month');
    if (monthInput) {
      monthInput.value = state.month;
      monthInput.addEventListener('change', function () {
        if (!/^\d{4}-\d{2}$/.test(monthInput.value)) { toast('月份格式不正确', 'warn'); monthInput.value = state.month; return; }
        state.month = monthInput.value;
        loadAll().then(renderAll);
      });
    }
    var btn;
    btn = $('#plan-confirmer');
    if (btn) {
      try { btn.value = localStorage.getItem('plan_confirmer') || ''; } catch (e) {}
      btn.addEventListener('change', function () {
        try { localStorage.setItem('plan_confirmer', btn.value.trim()); } catch (e) {}
      });
    }
    btn = $('#plan-generate');
    if (btn) btn.addEventListener('click', function () {
      if (confirm('按同比趋势法为 ' + state.month + ' 生成/刷新推荐值？\n（已确认的计划不受影响，草稿中手工改过的数量保留）')) generate();
    });
    btn = $('#plan-search');
    if (btn) btn.addEventListener('input', function () { state.keyword = btn.value.trim(); renderTable(); });
    $all('.plan-status-filter button').forEach(function (b) {
      b.addEventListener('click', function () {
        $all('.plan-status-filter button').forEach(function (x) { x.classList.toggle('active', x === b); });
        state.filterStatus = b.getAttribute('data-st') || '';
        renderTable();
      });
    });
    btn = $('#plan-batch-confirm');
    if (btn) btn.addEventListener('click', batchConfirm);
    btn = $('#plan-batch-clear');
    if (btn) btn.addEventListener('click', function () { state.checked = {}; renderTable(); renderBatchBar(); });
    btn = $('#plan-check-all');
    if (btn) btn.addEventListener('change', function () {
      var on = btn.checked;
      state.checked = {};
      if (on) $all('#plan-table tbody .plan-check').forEach(function (c) { state.checked[c.getAttribute('data-code')] = 1; });
      renderTable(); renderBatchBar();
    });

    /* 表格事件委托 */
    var tb = $('#plan-table tbody');
    if (tb) {
      tb.addEventListener('click', function (e) {
        var t = e.target, code;
        if (t.classList.contains('plan-confirm')) { confirmOne(t.getAttribute('data-code')); return; }
        if (t.classList.contains('plan-unconfirm')) { unconfirmOne(t.getAttribute('data-code')); return; }
        if (t.classList.contains('plan-toggle')) {
          code = t.getAttribute('data-code');
          state.expanded = state.expanded === code ? '' : code;
          renderTable();
          return;
        }
        if (t.classList.contains('plan-check')) {
          code = t.getAttribute('data-code');
          if (t.checked) state.checked[code] = 1; else delete state.checked[code];
          renderBatchBar();
        }
      });
      tb.addEventListener('change', function (e) {
        var t = e.target;
        if (t.classList.contains('plan-qty-input')) editQty(t.getAttribute('data-code'), t.value, t);
        if (t.classList.contains('plan-note-input')) editNote(t.getAttribute('data-code'), t.value);
      });
    }
  }

  global.PlanView = {
    init: init,
    render: function () { loadAll().then(renderAll); },
    reload: function () { return loadAll().then(renderAll); }
  };
})(window);
