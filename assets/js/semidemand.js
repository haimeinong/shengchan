/* ============================================================
 * semidemand.js — 二期：半成品需求参考
 * 目的：按月度生产计划（仅「已确认」）测算生产所需半成品需求量，并与半成品库存对比。
 * 口径：
 *   待产数量(箱) = 计划数量 − 实际入库数量（已入库 ≥ 计划则记为 0，即不再计算半成品用量）
 *                 （口径可切换：扣除已入库 / 按计划全额）
 *   需求量 = 待产数量 × 单耗(公斤/箱)
 *   实际入库 = 选中月最后一条成品快照的月累计「入库数量」（与月度生产规划口径一致）
 * 汇总：多个成品共用同一半成品时，按半成品汇总合计需求量。
 * 对比：缺口 = 合计需求量 − 半成品当前库存（取最新半成品快照「数量」）。
 * 数据来源（只读）：fact_plan_monthly / mdl_bom_link / mdl_material / fact_stock_daily
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 本地辅助（自包含，风格同 plan.js） ---------------- */
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
  function curMonth() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }

  /* ---------------- 内部状态 ---------------- */
  var state = {
    finByCode: {},       // 成品编码 → 物料
    semiByCode: {},      // 半成品编码 → 物料
    semiStock: {},       // 半成品编码 → 最新快照行
    semiStockDate: '',   // 最新半成品快照日期
    finStockByCode: {},  // 成品编码 → 按日期升序的快照数组
    plans: {},           // 成品编码 → 选中月计划记录
    linksByFin: {},      // 成品编码 → 已确认/已锁定的对应关系数组
    month: curMonth(),   // 选中月份 YYYY-MM
    basis: 'net',        // net=扣除已入库 / plan=按计划全额
    keyword: '',
    showZeroSources: false, // 是否显示「计划数量=0 / 未计划」的成品来源
    expanded: {}         // 展开的半成品编码
  };

  /* ---------------- 数据加载 ---------------- */
  function loadAll() {
    return Promise.all([DB.all('material'), DB.all('stock'), DB.all('plan'), DB.all('bom')]).then(function (r) {
      var mats = r[0] || [], stocks = r[1] || [], plans = r[2] || [], boms = r[3] || [];

      state.finByCode = {}; state.semiByCode = {};
      mats.forEach(function (m) {
        if ((m.库存属性 || '成品') === '半成品') state.semiByCode[m.物料编码] = m;
        else state.finByCode[m.物料编码] = m;
      });

      /* 半成品最新快照 */
      var latest = '';
      stocks.forEach(function (s) { if (s.库存类型 === '半成品' && s.日期 > latest) latest = s.日期; });
      state.semiStockDate = latest; state.semiStock = {};
      stocks.forEach(function (s) { if (s.库存类型 === '半成品' && s.日期 === latest) state.semiStock[s.物料编码] = s; });

      /* 成品快照按编码聚合、按日期升序 */
      state.finStockByCode = {};
      stocks.forEach(function (s) {
        if (s.库存类型 !== '成品') return;
        (state.finStockByCode[s.物料编码] = state.finStockByCode[s.物料编码] || []).push(s);
      });
      Object.keys(state.finStockByCode).forEach(function (c) {
        state.finStockByCode[c].sort(function (a, b) { return a.日期 < b.日期 ? -1 : a.日期 > b.日期 ? 1 : 0; });
      });

      /* 选中月计划 */
      state.plans = {};
      plans.forEach(function (p) { if (p.月份 === state.month) state.plans[p.物料编码] = p; });

      /* 对应关系：仅「已确认/已锁定」参与计算 */
      state.linksByFin = {};
      boms.forEach(function (l) {
        if (l.状态 !== '已确认' && l.状态 !== '已锁定') return;
        (state.linksByFin[l.成品编码] = state.linksByFin[l.成品编码] || []).push(l);
      });

      state.expanded = {};
    });
  }

  /** 成品某月最后一条快照的月累计字段值（入库数量），无快照返回 null */
  function monthQty(code, ym, field) {
    var rows = state.finStockByCode[code] || [], hit = null;
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i];
      if (s.日期 >= ym + '-01' && s.日期 <= ym + '-31') hit = s;
    }
    return hit ? (+hit[field] || 0) : null;
  }

  /* ---------------- 计算：按半成品汇总 + 成品来源明细 ---------------- */
  function compute() {
    /* 已确认且填有计划数量的生产计划 */
    var confirmedCodes = {};
    Object.keys(state.plans).forEach(function (c) {
      var p = state.plans[c];
      if (p && p.状态 === '已确认' && p.计划数量 !== '' && p.计划数量 != null) confirmedCodes[c] = p;
    });

    /* 反查：半成品 → 该半成品可制作的所有成品（仅已确认/已锁定对应关系） */
    var linksBySemi = {};
    Object.keys(state.linksByFin).forEach(function (fc) {
      state.linksByFin[fc].forEach(function (l) {
        (linksBySemi[l.半成品编码] = linksBySemi[l.半成品编码] || []).push(l);
      });
    });

    var semiMap = {};   // 半成品编码 → 汇总项（sources 含该半成品能制作的全部成品）
    Object.keys(linksBySemi).forEach(function (sc) {
      var sm = state.semiByCode[sc] || {};
      var st = state.semiStock[sc];
      var item = {
        code: sc,
        name: sm.物料名称 || (st && st.物料名称) || '',
        unit: sm.主单位 || (st && st.单位) || '公斤',
        inv: st ? (+st.数量 || 0) : null,
        hasStock: !!st,
        demand: 0,
        absentUse: 0,     // 单耗待补充的已确认计划数
        plannedCount: 0,  // 已确认计划的成品数
        sources: []
      };
      linksBySemi[sc].forEach(function (l) {
        var code = l.成品编码;
        var p = confirmedCodes[code];
        var planned = !!p;
        var planQty = planned ? (+p.计划数量 || 0) : null;
        var inQty = monthQty(code, state.month, '入库数量');
        var remain = planned
          ? (state.basis === 'plan' ? planQty : Math.max(0, planQty - (inQty == null ? 0 : inQty)))
          : 0;
        var use = (l.单耗 === '' || l.单耗 == null || isNaN(+l.单耗)) ? null : +l.单耗;
        var demand = (use != null && remain > 0) ? remain * use : 0;
        if (planned) {
          item.plannedCount++;
          if (use == null) item.absentUse++;
        }
        item.demand += demand;
        item.sources.push({
          fin: state.finByCode[code] || {},
          code: code,
          planned: planned,
          planQty: planQty,
          inQty: inQty,
          remain: remain,
          use: use,
          demand: demand
        });
      });
      semiMap[sc] = item;
    });

    /* 主行仅保留「存在已确认计划来源」的半成品 */
    var rows = Object.keys(semiMap).map(function (sc) { return semiMap[sc]; })
      .filter(function (it) { return it.plannedCount > 0; });
    rows.forEach(function (it) {
      var gap = it.demand - (it.hasStock ? it.inv : 0);
      it.gap = gap > 0 ? gap : 0;
      it.status = statusOf(it);
    });

    /* 排序：库存不足的排前，其次缺口/需求量降序 */
    var rank = { '无库存记录': 0, '缺货': 1, '库存不足': 2, '充足': 3, '无需备货': 4 };
    rows.sort(function (a, b) {
      var ra = rank[a.status.txt], rb = rank[b.status.txt];
      if (ra !== rb) return ra - rb;
      if (b.gap !== a.gap) return b.gap - a.gap;
      if (b.demand !== a.demand) return b.demand - a.demand;
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    });

    /* 已确认计划但尚未维护任何已确认/已锁定对应关系的成品（用于日常补充） */
    var missing = [];
    Object.keys(confirmedCodes).forEach(function (code) {
      var q = +confirmedCodes[code].计划数量 || 0;
      if (q <= 0) return;
      if (state.linksByFin[code] && state.linksByFin[code].length) return;
      missing.push({ code: code, mat: state.finByCode[code] || {}, planQty: q });
    });
    missing.sort(function (a, b) { return b.planQty - a.planQty; });

    var finCount = Object.keys(confirmedCodes).filter(function (c) {
      return state.linksByFin[c] && state.linksByFin[c].length;
    }).length;

    return { rows: rows, finCount: finCount, missing: missing };
  }

  function statusOf(it) {
    if (it.demand <= 0) return { cls: 'off', txt: '无需备货' };
    if (!it.hasStock) return { cls: 'urgent', txt: '无库存记录' };
    if (it.inv <= 0) return { cls: 'urgent', txt: '缺货' };
    if (it.inv < it.demand) return { cls: 'warn', txt: '库存不足' };
    return { cls: 'ok', txt: '充足' };
  }

  /* ---------------- 渲染 ---------------- */
  function renderKpi(rows, finCount) {
    var demandSum = 0, shortCnt = 0;
    rows.forEach(function (r) {
      demandSum += r.demand;
      if (r.status.cls === 'urgent' || r.status.cls === 'warn') shortCnt++;
    });
    $('#sd-kpi-semi').textContent = rows.length;
    $('#sd-kpi-demand').textContent = fmtNum(demandSum);
    $('#sd-kpi-short').textContent = shortCnt;
    $('#sd-kpi-fin').textContent = finCount;
  }

  function filterRows(rows) {
    var kw = state.keyword.toLowerCase();
    if (!kw) return rows;
    return rows.filter(function (r) {
      var hay = [r.code, r.name].concat(r.sources.map(function (s) {
        return s.code + ' ' + (s.fin.物料名称 || '');
      })).join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
  }

  function sourceTable(sources) {
    var rows = sources.slice().sort(function (a, b) {
      if (a.demand !== b.demand) return b.demand - a.demand;
      return (b.planQty || 0) - (a.planQty || 0);
    });
    return '<div class="table-wrap" style="margin-top:8px"><table class="grid">'
      + '<thead><tr><th>成品编码</th><th>成品名称</th><th>产品系列</th>'
      + '<th class="num">计划数量(箱)</th><th class="num">实际入库(箱)</th><th class="num">待产数量(箱)</th>'
      + '<th class="num">单耗(公斤/箱)</th><th class="num">需求量</th></tr></thead>'
      + '<tbody>' + rows.map(function (s) {
          return '<tr>'
            + '<td class="code">' + esc(s.code) + '</td>'
            + '<td>' + esc(s.fin.物料名称 || '') + '</td>'
            + '<td>' + esc(s.fin.产品系列 || '') + '</td>'
            + '<td class="num">' + (s.planned ? fmtNum(s.planQty) : '<span class="muted">未计划</span>') + '</td>'
            + '<td class="num">' + (s.planned ? fmtNum(s.inQty) : '—') + '</td>'
            + '<td class="num">' + (s.planned ? fmtNum(s.remain) : '—') + '</td>'
            + '<td class="num">' + (s.use == null ? '<span class="muted">待补充</span>' : fmtNum(s.use)) + '</td>'
            + '<td class="num">' + ((s.use == null || !s.planned) ? '—' : fmtNum(s.demand)) + '</td>'
            + '</tr>';
        }).join('') + '</tbody></table></div>';
  }

  function renderTable(rows) {
    var tb = $('#sd-table tbody'); if (!tb) return;
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="9" class="empty">无可测算的半成品（需先在「月度生产规划」确认计划，并在「半成品管理」维护已确认对应关系）</td></tr>';
      return;
    }
    var html = '';
    rows.forEach(function (r) {
      var open = !!state.expanded[r.code];
      var gapCls = r.gap > 0 ? ' num-red' : '';
      /* 默认只显示「已确认计划且计划数量 > 0」的成品来源；按钮开启后显示该半成品能制作的全部成品 */
      var srcShow = state.showZeroSources
        ? r.sources
        : r.sources.filter(function (s) { return s.planned && s.planQty > 0; });
      var hidden = r.sources.length - srcShow.length;
      html += '<tr data-code="' + esc(r.code) + '" class="' + (r.status.cls === 'urgent' ? 'sd-row-short' : '') + '">'
        + '<td class="code">' + esc(r.code) + '</td>'
        + '<td>' + esc(r.name || '') + '</td>'
        + '<td>' + esc(r.unit) + '</td>'
        + '<td class="num">' + (r.hasStock ? fmtNum(r.inv) : '—') + '</td>'
        + '<td class="num">' + fmtNum(r.demand) + '</td>'
        + '<td class="num' + gapCls + '">' + (r.gap > 0 ? fmtNum(r.gap) : '—') + '</td>'
        + '<td><span class="repl-badge ' + r.status.cls + '">' + r.status.txt + '</span></td>'
        + '<td class="num">' + r.sources.length
          + (r.absentUse ? ' <span class="muted">(待补充 ' + r.absentUse + ')</span>' : '')
          + (hidden > 0 ? ' <span class="muted">(隐藏 ' + hidden + ')</span>' : '')
        + '</td>'
        + '<td><button class="btn btn-link btn-sm sd-toggle" data-code="' + esc(r.code) + '">' + (open ? '收起' : '展开') + '</button></td>'
        + '</tr>';
      if (open) {
        html += '<tr class="plan-detail-row"><td colspan="9"><div class="plan-detail">'
          + '<div class="plan-detail-left" style="flex:1 1 100%"><b>成品来源（' + srcShow.length + ' / ' + r.sources.length + '）</b>'
          + (r.absentUse ? '<span class="muted"> · ' + r.absentUse + ' 条单耗待补充，未计入需求量</span>' : '')
          + (srcShow.length
              ? sourceTable(srcShow)
              : '<div class="muted" style="margin-top:8px">该半成品当前没有「计划数量&gt;0」的成品，可点击上方「显示计划为0的成品」查看全部可制作成品。</div>')
          + '</div></div></td></tr>';
      }
    });
    tb.innerHTML = html;
  }

  /* 已确认计划但未维护半成品对应关系的成品提示 */
  function renderMissing(missing) {
    var panel = $('#sd-missing-panel'); if (!panel) return;
    if (!missing.length) { panel.hidden = true; return; }
    panel.hidden = false;
    var cnt = $('#sd-missing-count'); if (cnt) cnt.textContent = missing.length;
    var tb = $('#sd-missing-table tbody'); if (!tb) return;
    tb.innerHTML = missing.map(function (x) {
      return '<tr>'
        + '<td class="code">' + esc(x.code) + '</td>'
        + '<td>' + esc(x.mat.物料名称 || '') + '</td>'
        + '<td>' + esc(x.mat.产品系列 || '') + '</td>'
        + '<td class="num">' + fmtNum(x.planQty) + '</td>'
        + '<td><span class="repl-badge warn">待补充对应关系</span></td>'
        + '</tr>';
    }).join('');
  }

  function renderAll() {
    var r = compute();
    renderKpi(r.rows, r.finCount);
    renderTable(filterRows(r.rows));
    renderMissing(r.missing);
  }

  /* ---------------- 导出 Excel ---------------- */
  /* 独立窗口(PWA)模式下，游离元素的模拟点击可能被忽略，必须先把 <a> 挂到页面 DOM 再触发 */
  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
  }

  function exportXlsx() {
    if (typeof XLSX === 'undefined') { toast('Excel 组件未加载，请刷新后重试', 'err'); return; }
    var r = compute();
    var rows = filterRows(r.rows);
    if (!rows.length) { toast('当前筛选条件下没有可导出的数据', 'warn'); return; }

    var summaryCols = ['半成品编码', '半成品名称', '单位', '当前库存', '合计需求量', '缺口', '状态', '关联成品数'];
    var summary = rows.map(function (x) {
      return {
        半成品编码: x.code,
        半成品名称: x.name || '',
        单位: x.unit,
        当前库存: x.hasStock ? x.inv : '',
        合计需求量: Math.round(x.demand * 100) / 100,
        缺口: x.gap > 0 ? Math.round(x.gap * 100) / 100 : '',
        状态: x.status.txt,
        关联成品数: x.sources.length
      };
    });
    var detailCols = ['半成品编码', '半成品名称', '成品编码', '成品名称', '产品系列', '计划数量(箱)', '实际入库(箱)', '待产数量(箱)', '单耗(公斤/箱)', '需求量'];
    var detail = [];
    rows.forEach(function (x) {
      x.sources.slice().sort(function (a, b) { return b.demand - a.demand; }).forEach(function (s) {
        detail.push({
          半成品编码: x.code,
          半成品名称: x.name || '',
          成品编码: s.code,
          成品名称: s.fin.物料名称 || '',
          产品系列: s.fin.产品系列 || '',
          '计划数量(箱)': s.planQty,
          '实际入库(箱)': s.inQty == null ? '' : s.inQty,
          '待产数量(箱)': s.remain,
          '单耗(公斤/箱)': s.use == null ? '' : s.use,
          需求量: s.use == null ? '' : Math.round(s.demand * 100) / 100
        });
      });
    });

    try {
      var wb = XLSX.utils.book_new();
      var ws1 = XLSX.utils.json_to_sheet(summary, { header: summaryCols });
      ws1['!cols'] = [{ wch: 16 }, { wch: 22 }, { wch: 8 }, { wch: 11 }, { wch: 12 }, { wch: 10 }, { wch: 11 }, { wch: 11 }];
      XLSX.utils.book_append_sheet(wb, ws1, '半成品需求汇总');
      var ws2 = XLSX.utils.json_to_sheet(detail, { header: detailCols });
      ws2['!cols'] = [{ wch: 16 }, { wch: 20 }, { wch: 16 }, { wch: 24 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 11 }];
      XLSX.utils.book_append_sheet(wb, ws2, '成品来源明细');
      var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      var name = '半成品需求参考_' + state.month + '.xlsx';
      saveBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
      toast('已导出 ' + rows.length + ' 项半成品：' + name, 'ok');
    } catch (err) {
      toast('导出失败：' + (err && err.message ? err.message : err), 'err');
    }
  }

  /* ---------------- 初始化与事件 ---------------- */
  function init() {
    try { state.basis = localStorage.getItem('sd_basis') || 'net'; } catch (e) {}
    try { state.showZeroSources = localStorage.getItem('sd_show_zero') === '1'; } catch (e) {}

    var monthInput = $('#sd-month');
    if (monthInput) {
      monthInput.value = state.month;
      monthInput.addEventListener('change', function () {
        if (!/^\d{4}-\d{2}$/.test(monthInput.value)) { toast('月份格式不正确', 'warn'); monthInput.value = state.month; return; }
        state.month = monthInput.value;
        loadAll().then(renderAll);
      });
    }

    /* 口径切换 */
    function syncBasisBtns() {
      $all('#sd-basis button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-b') === state.basis); });
    }
    syncBasisBtns();
    $all('#sd-basis button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.basis = b.getAttribute('data-b') || 'net';
        try { localStorage.setItem('sd_basis', state.basis); } catch (e) {}
        syncBasisBtns();
        renderAll();
      });
    });

    /* 显示/隐藏「计划数量=0」的成品来源 */
    var zeroBtn = $('#sd-toggle-zero');
    function syncZeroBtn() {
      if (!zeroBtn) return;
      zeroBtn.textContent = state.showZeroSources ? '仅显示有计划的成品' : '显示计划为0的成品';
      zeroBtn.classList.toggle('btn-primary', state.showZeroSources);
    }
    syncZeroBtn();
    if (zeroBtn) zeroBtn.addEventListener('click', function () {
      state.showZeroSources = !state.showZeroSources;
      try { localStorage.setItem('sd_show_zero', state.showZeroSources ? '1' : '0'); } catch (e) {}
      syncZeroBtn();
      renderAll();
    });

    var searchBox = $('#sd-search');
    if (searchBox) searchBox.addEventListener('input', function () { state.keyword = searchBox.value.trim(); renderAll(); });

    var exportBtn = $('#sd-export');
    if (exportBtn) exportBtn.addEventListener('click', exportXlsx);

    var tb = $('#sd-table tbody');
    if (tb) {
      tb.addEventListener('click', function (e) {
        var t = e.target;
        if (t.classList.contains('sd-toggle')) {
          var code = t.getAttribute('data-code');
          state.expanded[code] = !state.expanded[code];
          renderAll();
        }
      });
    }
  }

  global.SemiDemandView = {
    init: init,
    render: function () { loadAll().then(renderAll); },
    reload: function () { return loadAll().then(renderAll); }
  };
})(window);
