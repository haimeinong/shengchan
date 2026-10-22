/* ============================================================
 * app.js — 视图渲染与交互（一期：库存总览 / 欠货跟踪 / 导入 / 主数据 / 备份）
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 全局状态 ---------------- */
  var state = { materials: [], stocks: [], backorders: [], logs: [], bomLinks: [], matMap: {}, view: 'stock' };
  var BO_STATUSES = ['待排产', '排产中', '可发货', '已结清'];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '0';
    return (Math.round(n * 100) / 100).toLocaleString('zh-CN');
  }

  /* 输入防抖：连续输入时延迟 ms 毫秒后才执行，避免每次按键都全量重算渲染 */
  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }
  function todayStr() { return Importer.todayStr(); }
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    $('#toast-wrap').appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
    setTimeout(function () { el.remove(); }, 3000);
  }

  /* ---------------- 数据装载 ---------------- */
  function reload() {
    movesCache = {};   /* 数据重载后，流水推算缓存失效，下次渲染时重建 */
    return Promise.all([DB.all('material'), DB.all('stock'), DB.all('backorder'), DB.all('oplog'), DB.all('bom')])
      .then(function (r) {
        state.materials = r[0];
        state.stocks = r[1];
        state.backorders = r[2];
        state.logs = r[3];
        state.bomLinks = r[4];
        state.matMap = {};
        r[0].forEach(function (m) { state.matMap[m.物料编码] = m; });
      });
  }

  /* 视图懒渲染：数据变化后只立即重绘"当前视图"，其余视图在切换到它时再渲染。
     renderedView 记录哪些视图的 DOM 与当前 state 是一致的，避免每次数据变更都全量重建 8 个视图。 */
  var renderedView = {};

  function renderView(v) {
    switch (v) {
      case 'stock': renderStock(); break;
      case 'semi': renderSemi(); break;
      case 'backorder': renderBackorder(); break;
      case 'flow': renderFlow(); break;
      case 'import': renderImportLog(); break;
      case 'material': renderMaterial(); break;
      case 'backup': renderOpLog(); break;
    }
    renderedView[v] = true;
  }

  function renderAll() {
    renderedView = {};        /* state 已重新装载，全部视图标记为待渲染 */
    renderView(state.view);   /* 只画当前可见视图 */
  }

  /* ================================================================
   * 视图：库存总览（只展示成品；半成品在"半成品"菜单管理）
   * ================================================================ */
  function finishStocksAt(date) {
    return state.stocks.filter(function (s) { return s.日期 === date && s.库存类型 === '成品'; });
  }

  /** 用已有成品快照日期填充"查看日期"下拉，保留当前选择；返回选中日期 */
  function syncDateSelect(sel) {
    var dates = {};
    state.stocks.forEach(function (s) { if (s.库存类型 === '成品') dates[s.日期] = 1; });
    var list = Object.keys(dates).sort().reverse();
    var cur = sel.value;
    sel.innerHTML = list.length
      ? list.map(function (d) { return '<option value="' + d + '">' + d + '</option>'; }).join('')
      : '<option value="">（暂无快照，请先导入）</option>';
    sel.value = list.indexOf(cur) >= 0 ? cur : (list[0] || '');
    return sel.value;
  }

  function renderStock() {
    var sel = $('#current-date');
    var date = syncDateSelect(sel);
    var rows = finishStocksAt(date);
    var kw = $('#stock-search').value.trim().toLowerCase();
    if (kw) rows = rows.filter(function (s) {
      var m = state.matMap[s.物料编码] || {};
      return [s.物料编码, m.物料名称, m.产品系列, m['子分类(包装形态)']].join(' ').toLowerCase().indexOf(kw) >= 0;
    });

    /* KPI：成品 SKU / 库存（箱）/ 本月累计入出库 / 负库存 */
    var fcodes = {}, qty = 0, neg = 0, mIn = 0, mOut = 0;
    rows.forEach(function (s) {
      fcodes[s.物料编码] = 1;
      qty += +s.数量 || 0;
      if (+s.数量 < 0) neg++;
      mIn += +s.入库数量 || 0;
      mOut += +s.出库数量 || 0;
    });
    $('#kpi-finish-sku').textContent = Object.keys(fcodes).length;
    $('#kpi-finish-qty').textContent = fmtNum(qty);
    $('#kpi-finish-in').textContent = fmtNum(mIn);
    $('#kpi-finish-out').textContent = fmtNum(mOut);
    $('#kpi-negative').textContent = neg;

    renderTrend();

    /* 明细表：按 产品系列 / 子分类 分组（参照日报"库存结构"样式） */
    var groups = {};
    rows.forEach(function (s) {
      var m = state.matMap[s.物料编码] || {};
      var series = m.产品系列 || '';
      var sub = m['子分类(包装形态)'] || '';
      var gKey = series + '|' + sub;
      if (!groups[gKey]) groups[gKey] = {
        key: gKey, series: series, sub: sub,
        title: series ? (series + (sub ? ' / ' + sub : '')) : '未在产品清单中匹配到系列的成品',
        rows: [], qty: 0, codes: {}
      };
      groups[gKey].rows.push(s);
      groups[gKey].qty += +s.数量 || 0;
      groups[gKey].codes[s.物料编码] = 1;
    });

    var tbody = $('#stock-table tbody');
    var gKeys = Object.keys(groups).sort(function (a, b) {
      var ga = groups[a], gb = groups[b];
      var sa = ga.series || '￿', sb = gb.series || '￿';
      return sa === sb ? (ga.sub || '￿').localeCompare(gb.sub || '￿', 'zh-CN') : sa.localeCompare(sb, 'zh-CN');
    });
    if (gKeys.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">' + (state.stocks.some(function (s) { return s.库存类型 === '成品'; }) ? '该日期暂无成品快照，请用"查看日期"切换' : '暂无数据，请先到【数据导入】拖入成品库存报表') + '</td></tr>';
    } else {
      tbody.innerHTML = gKeys.map(function (gk) {
        var g = groups[gk];
        var n = Object.keys(g.codes).length;
        var head = '<tr class="group-row cat-group grp-finish" data-g="' + esc(gk) + '"><td colspan="8">'
          + '<span class="gi">▾</span>' + esc(g.title)
          + ' <span class="g-count">（' + n + ' 项）</span>'
          + '<span class="hint">库存合计 ' + fmtNum(g.qty) + ' 箱</span></td></tr>';
        var body = g.rows.sort(function (a, b) { return a.物料编码 < b.物料编码 ? -1 : a.物料编码 > b.物料编码 ? 1 : 0; }).map(function (s) {
          var m = state.matMap[s.物料编码] || {};
          var neg = (+s.数量 < 0);
          function num(v) { return v === '' || v == null ? '' : fmtNum(v); }
          return '<tr class="detail-row" data-g="' + esc(gk) + '">'
            + '<td class="code">' + esc(s.物料编码) + '</td>'
            + '<td>' + esc(m.物料名称 || s.物料名称) + '</td>'
            + '<td>' + esc(m.规格型号) + '</td>'
            + '<td>' + esc(m.箱规) + '</td>'
            + '<td class="num">' + num(s.初期库存) + '</td>'
            + '<td class="num">' + num(s.入库数量) + '</td>'
            + '<td class="num">' + num(s.出库数量) + '</td>'
            + '<td class="num' + (neg ? ' neg' : '') + '">' + fmtNum(s.数量) + (neg ? ' <span class="tag tag-red">负</span>' : '') + '</td></tr>';
        }).join('');
        return head + body;
      }).join('');

      $all('.group-row', tbody).forEach(function (tr) {
        tr.addEventListener('click', function () {
          var k = tr.getAttribute('data-g');
          tr.classList.toggle('collapsed');
          var hide = tr.classList.contains('collapsed');
          $all('.detail-row[data-g="' + CSS.escape(k) + '"]', tbody).forEach(function (r) { r.style.display = hide ? 'none' : ''; });
        });
      });
    }
  }

  /* 成品数量趋势：库存 / 入库 / 出库 三线（纯 SVG，箱）。
   * 默认近 30 天，支持筛选（编码/名称/系列/子分类）与日期区间。
   * 口径：库存=当日快照合计（缺日延续前值）；入库/出库=当日实际发生量
   *（导入时已落库"当日入库/当日出库"，旧数据按同月上一快照累计差分回退）。 */
  function shiftDate(d, n) {
    var t = new Date(d + 'T00:00:00');
    t.setDate(t.getDate() + n);
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }

  /** 按物料分组全量成品快照（升序），推算每条快照的当日入库/出库挂到 __din/__dout。
   *  口径：优先导入时落库的"当日入库/当日出库"；旧数据按同月上一快照累计差分回退，月内首条=累计值。 */
  function dailyMovesByCode(finishStocks) {
    var byCode = {};
    finishStocks.forEach(function (s) { (byCode[s.物料编码] = byCode[s.物料编码] || []).push(s); });
    Object.keys(byCode).forEach(function (code) {
      var prevIn = null, prevOut = null, prevMonth = '';
      byCode[code].sort(function (a, b) { return a.日期 < b.日期 ? -1 : a.日期 > b.日期 ? 1 : 0; }).forEach(function (s) {
        var month = s.日期.slice(0, 7);
        if (month !== prevMonth) { prevIn = null; prevOut = null; prevMonth = month; }
        var din = s.当日入库, dout = s.当日出库;
        if (din == null || din === '') din = prevIn == null ? (+s.入库数量 || 0) : Math.max(0, (+s.入库数量 || 0) - prevIn);
        if (dout == null || dout === '') dout = prevOut == null ? (+s.出库数量 || 0) : Math.max(0, (+s.出库数量 || 0) - prevOut);
        prevIn = +s.入库数量 || 0;
        prevOut = +s.出库数量 || 0;
        s.__din = +din || 0;
        s.__dout = +dout || 0;
      });
    });
    return byCode;
  }

  /* 推算结果缓存：按库存类型缓存分组排序+差分结果（byCode）与数据最新日期（maxDate）。
   * 只在数据重载（reload）后重建，避免每次渲染/筛选都对全量历史重复分组排序推算。 */
  var movesCache = {};
  function dailyMovesCached(stockType) {
    var c = movesCache[stockType];
    if (!c) {
      var paneStocks = state.stocks.filter(function (s) { return s.库存类型 === stockType; });
      var maxDate = '';
      paneStocks.forEach(function (s) { if (s.日期 > maxDate) maxDate = s.日期; });
      c = movesCache[stockType] = { byCode: dailyMovesByCode(paneStocks), maxDate: maxDate };
    }
    return c;
  }

  function renderTrend() {
    var box = $('#trend-chart');
    if (!box) return;
    var finishStocks = state.stocks.filter(function (s) { return s.库存类型 === '成品'; });
    var maxDate = finishStocks.reduce(function (a, s) { return s.日期 > a ? s.日期 : a; }, '');

    /* 日期区间：默认近 30 天（输入框为空时初始化一次，之后沿用用户选择） */
    var fromI = $('#trend-from'), toI = $('#trend-to');
    if (fromI && toI && !fromI.value && !toI.value && maxDate) {
      fromI.value = shiftDate(maxDate, -29);
      toI.value = maxDate;
    }
    var from = (fromI && fromI.value) || (maxDate ? shiftDate(maxDate, -29) : '');
    var to = (toI && toI.value) || maxDate;
    if (from && to && from > to) { var tmp = from; from = to; to = tmp; }

    if (finishStocks.length === 0 || !from || !to) {
      box.innerHTML = '<div class="empty">暂无成品历史快照，导入数据后自动生成趋势</div>';
      return;
    }

    /* 筛选：编码/名称/系列/子分类 */
    var kw = ($('#trend-search') ? $('#trend-search').value : '').trim().toLowerCase();
    function hit(m) {
      if (!kw) return true;
      return [m.物料编码, m.物料名称, m.产品系列, m['子分类(包装形态)']].join(' ').toLowerCase().indexOf(kw) >= 0;
    }

    /* 按物料分组（全量快照）：先算出每条快照的当日入库/出库，避免区间截断导致差分失真 */
    var byCode = dailyMovesCached('成品').byCode;

    var sumStock = {}, sumIn = {}, sumOut = {}, hasData = false;
    Object.keys(byCode).forEach(function (code) {
      if (!hit(state.matMap[code] || {})) return;
      byCode[code].forEach(function (s) {
        if (s.日期 < from || s.日期 > to) return;
        sumStock[s.日期] = (sumStock[s.日期] || 0) + (+s.数量 || 0);
        sumIn[s.日期] = (sumIn[s.日期] || 0) + s.__din;
        sumOut[s.日期] = (sumOut[s.日期] || 0) + s.__dout;
        hasData = true;
      });
    });

    if (!hasData) {
      box.innerHTML = '<div class="empty">所选区间/筛选条件下暂无成品快照数据</div>';
      return;
    }

    /* 逐日序列：库存缺日延续前值；入/出库缺日为 0 */
    var days = [];
    for (var d = from; d && d <= to; d = shiftDate(d, 1)) days.push(d);
    var last = 0;
    var s0 = days.map(function (x) { if (sumStock[x] != null) last = sumStock[x]; return last; });
    var s1 = days.map(function (x) { return sumIn[x] || 0; });
    var s2 = days.map(function (x) { return sumOut[x] || 0; });

    var maxV = Math.max(1, Math.max.apply(null, s0.concat(s1, s2)));

    var W = 760, H = 240, PL = 52, PR = 14, PT = 16, PB = 30;
    var iw = W - PL - PR, ih = H - PT - PB;
    var step = Math.max(1, days.length - 1);
    function X(i) { return PL + i * iw / step; }
    function Y(v) { return PT + ih - v / maxV * ih; }
    function path(data) { return data.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join(' '); }

    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var y = PT + ih * g / 4, val = Math.round(maxV * (4 - g) / 4);
      grid += '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y + '" stroke="#eef2f7"/>'
        + '<text x="' + (PL - 8) + '" y="' + (y + 4) + '" text-anchor="end" font-size="10" fill="#94a3b8">' + val + '</text>';
    }
    var labels = '';
    var labelEvery = days.length > 12 ? 5 : 1;
    days.forEach(function (dt, i) {
      if (i % labelEvery === 0 || i === days.length - 1) labels += '<text x="' + X(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="#94a3b8">' + dt.slice(5) + '</text>';
    });

    box.innerHTML = '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'
      + grid
      + '<path d="' + path(s0) + '" fill="none" stroke="#2563eb" stroke-width="2.2"/>'
      + '<path d="' + path(s1) + '" fill="none" stroke="#16a34a" stroke-width="1.8"/>'
      + '<path d="' + path(s2) + '" fill="none" stroke="#ea580c" stroke-width="1.8"/>'
      + labels + '</svg>';
  }

  /* ================================================================
   * 视图：库存流水及数据对比（每日入/出库报表 + 成品物料对比表）
   * ================================================================ */
  function monthOf(d) { return String(d).slice(0, 7); }
  function prevMonthOf(ym) {
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
    if (m <= 0) { m = 12; y--; }
    return y + '-' + String(m).padStart(2, '0');
  }
  function lastYearMonthOf(ym) { return (+ym.slice(0, 4) - 1) + ym.slice(4); }

  /* 流水视图当前子页：finish=成品 / semi=半成品 */
  var flowTab = 'finish';

  /* 流水行数保护：默认仅显示近 31 天（以数据最新日期为锚点）；
   * 筛选命中编码数不超过 FLOW_LIFT_CODES 个时自动放开限制，展示全部历史流水 */
  var FLOW_DEFAULT_DAYS = 31, FLOW_LIFT_CODES = 5;

  /* 单次渲染行数上限：无论筛选结果多少，DOM 一次最多插入 FLOW_PAGE 行，其余点"显示更多"追加。
   * 保证主线程不会被上万行 innerHTML 长时间阻塞（这是长时间卡顿/无响应的直接原因之一）。 */
  var FLOW_PAGE = 300;
  var flowLimit = { finish: FLOW_PAGE, semi: FLOW_PAGE };
  var flowSig = { finish: '', semi: '' };
  var flowReplLimit = { finish: FLOW_PAGE, semi: FLOW_PAGE };
  var flowReplSig = { finish: '', semi: '' };

  /* 只渲染当前可见子页；隐藏的子页不计算不渲染，切换子页时再补渲染 */
  function renderFlow() { renderFlowPane(flowTab); }

  /** 成品/半成品流水对比渲染（type: 'finish' | 'semi'）。
   *  成品计量单位固定为箱；半成品取物料档案"主单位"（缺省公斤），流水表多一列"单位"。 */
  function renderFlowPane(type) {
    var isSemi = type === 'semi';
    var stockType = isSemi ? '半成品' : '成品';
    var idPrefix = isSemi ? '#flow-semi' : '#flow';          /* 筛选与对比表 id 前缀 */
    var inTbl = isSemi ? '#flow-semi-in-table tbody' : '#flow-in-table tbody';
    var outTbl = isSemi ? '#flow-semi-out-table tbody' : '#flow-out-table tbody';

    var flowCache = dailyMovesCached(stockType);
    var byCode = flowCache.byCode;

    /* 半成品计量单位：物料档案主单位 > 快照单位 > 默认公斤；成品恒为箱 */
    function unitOf(code, snap) {
      if (!isSemi) return '箱';
      var m = state.matMap[code];
      return (m && m.主单位) || (snap && snap.单位) || '公斤';
    }

    /* ---- 每日出入库流水（物料明细行）：筛选 编码/名称 + 可选指定日期 ---- */
    var moveKw = ($(idPrefix + '-move-search') ? $(idPrefix + '-move-search').value : '').trim().toLowerCase();
    var moveDate = $(idPrefix + '-move-date') ? $(idPrefix + '-move-date').value : '';

    /* 筛选命中的编码集合：命中数少（查具体产品）时放开日期限制看全部历史，
       命中数多（或不筛选）时默认仅近 FLOW_DEFAULT_DAYS 天，避免行数随数据累积无限膨胀 */
    var hitCodes = {};
    Object.keys(byCode).forEach(function (code) {
      var m = state.matMap[code] || {};
      if (moveKw && [code, m.物料名称 || ''].join(' ').toLowerCase().indexOf(moveKw) < 0) return;
      hitCodes[code] = 1;
    });
    var moveFrom = '';
    if (!moveDate && flowCache.maxDate && Object.keys(hitCodes).length > FLOW_LIFT_CODES) {
      moveFrom = shiftDate(flowCache.maxDate, -(FLOW_DEFAULT_DAYS - 1));
    }

    /* 筛选条件变化时回到第一页，避免沿用上次"显示更多"后的大行数 */
    var sig = moveKw + '|' + moveDate;
    if (flowSig[type] !== sig) { flowSig[type] = sig; flowLimit[type] = FLOW_PAGE; }
    var limit = flowLimit[type];

    function moveRows(field) {
      var rows = [];
      Object.keys(hitCodes).forEach(function (code) {
        var m = state.matMap[code] || {};
        var name = m.物料名称 || '', spec = m.规格型号 || '';
        byCode[code].forEach(function (s) {
          if (moveDate) { if (s.日期 !== moveDate) return; }
          else if (moveFrom && s.日期 < moveFrom) return;
          var v = field === '__din' ? s.__din : s.__dout;
          if (!v) return;   /* 当日无发生量不显示 */
          rows.push({ d: s.日期, code: code, name: name, spec: spec, unit: unitOf(code, s), v: v });
        });
      });
      return rows.sort(function (a, b) {
        return a.d < b.d ? 1 : a.d > b.d ? -1 : (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
      });
    }

    function moveTable(tbodySel, rows, emptyText) {
      var tb = $(tbodySel);
      if (!tb) return;
      var cols = isSemi ? 6 : 5;
      if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="' + cols + '" class="empty">' + (moveFrom ? '近 ' + FLOW_DEFAULT_DAYS + ' 天' : '') + emptyText + '</td></tr>';
        return;
      }
      var total = 0;
      rows.forEach(function (r) { total += r.v; });          /* 合计按全部结果算，不受分页影响 */
      var shown = rows.slice(0, limit);
      var html = shown.map(function (r) {
        var unitCell = isSemi ? '<td>' + esc(r.unit) + '</td>' : '';
        return '<tr><td>' + r.d + '</td><td class="code">' + esc(r.code) + '</td><td>' + esc(r.name) + '</td>'
          + '<td>' + esc(r.spec) + '</td>' + unitCell + '<td class="num">' + fmtNum(r.v) + '</td></tr>';
      }).join('');
      html += '<tr class="group-row"><td colspan="' + (cols - 1) + '">合计</td><td class="num">' + fmtNum(total) + '</td></tr>';
      if (rows.length > shown.length) {
        html += '<tr class="more-row"><td colspan="' + cols + '">'
          + '<button type="button" class="btn flow-more" style="width:100%">显示更多（已显示 '
          + shown.length + ' / 共 ' + rows.length + ' 行）</button></td></tr>';
      }
      if (moveFrom) {
        html += '<tr><td colspan="' + cols + '" class="empty">仅显示近 ' + FLOW_DEFAULT_DAYS + ' 天流水，上方筛选具体产品（≤' + FLOW_LIFT_CODES + ' 个编码）可查看全部历史</td></tr>';
      }
      tb.innerHTML = html;
      $all('.flow-more', tb).forEach(function (btn) {
        btn.addEventListener('click', function () {
          flowLimit[type] += FLOW_PAGE;
          renderFlowPane(type);
        });
      });
    }
    moveTable(inTbl, moveRows('__din'), '暂无入库流水');
    moveTable(outTbl, moveRows('__dout'), '暂无出库流水');

    /* ---- 物料主数据与出入库对比（最新库存状态） ---- */
    var kw = ($(idPrefix + '-search') ? $(idPrefix + '-search').value : '').trim().toLowerCase();
    var replF = $(idPrefix + '-repl-filter') ? $(idPrefix + '-repl-filter').value : '';

    /** 每物料最新一条该库存类型快照（byCode 内已按日期升序，取末位即可，无需再全表扫描） */
    var latestSnap = {};
    Object.keys(byCode).forEach(function (code) {
      var arr = byCode[code];
      if (arr.length) latestSnap[code] = arr[arr.length - 1];
    });

    /** 某物料在某月"月末最后一条快照"的累计字段值 */
    function monthEndQty(code, month, field) {
      var rows = byCode[code] || [], hitR = null;
      for (var i = 0; i < rows.length; i++) {
        var s = rows[i];
        if (s.日期 >= month + '-01' && s.日期 <= month + '-31') hitR = s;
      }
      return hitR ? (+hitR[field] || 0) : null;
    }

    var list = state.materials.filter(function (m) { return m.库存属性 === stockType; })
      .slice().sort(function (a, b) { return a.物料编码.localeCompare(b.物料编码); });
    if (kw) list = list.filter(function (m) {
      return [m.物料编码, m.物料名称, m.产品系列, m['子分类(包装形态)']].join(' ').toLowerCase().indexOf(kw) >= 0;
    });
    list = list.filter(function (m) {
      var repl = +m.计划补货数量 || 0;
      if (replF === 'yes') return repl > 0;
      if (replF === 'no') return !(repl > 0);
      return true;
    });

    var tb = $(idPrefix + '-table tbody');
    if (!tb) return;
    if (!list.length) { tb.innerHTML = '<tr><td colspan="13" class="empty">暂无符合条件的' + stockType + '物料</td></tr>'; return; }

    /* 对比表同样限制单次渲染行数（每行含输入框，物料多时整表重建很重）；
       筛选条件变化时回到第一页。其余行点"显示更多"分批补上。 */
    var sig2 = kw + '|' + replF;
    if (flowReplSig[type] !== sig2) { flowReplSig[type] = sig2; flowReplLimit[type] = FLOW_PAGE; }
    var replShown = list.slice(0, flowReplLimit[type]);

    var html = replShown.map(function (m) {
      var code = m.物料编码;
      var snap = latestSnap[code] || null;
      var stock = snap ? +snap.数量 : null;
      var pm = null, lym = null;
      if (snap) {
        var ym = monthOf(snap.日期);
        pm = monthEndQty(code, prevMonthOf(ym), '出库数量');
        lym = monthEndQty(code, lastYearMonthOf(ym), '出库数量');
      }
      var replVal = m.计划补货数量 == null ? '' : m.计划补货数量;
      /* 成品第6列=箱规；半成品第6列=计量单位 */
      var specCell = isSemi
        ? '<td>' + esc(unitOf(code, snap)) + '</td>'
        : '<td>' + esc(m.箱规 || '') + '</td>';
      function num(v) { return v == null || v === '' ? '—' : fmtNum(v); }
      return '<tr data-code="' + esc(code) + '"><td class="code">' + esc(code) + '</td>'
        + '<td>' + esc(m.物料名称 || '') + '</td>'
        + '<td>' + esc(m.产品系列 || '') + '</td>'
        + '<td>' + esc(m['子分类(包装形态)'] || '') + '</td>'
        + '<td>' + esc(m.规格型号 || '') + '</td>'
        + specCell
        + '<td class="num">' + num(snap ? snap.初期库存 : null) + '</td>'
        + '<td class="num">' + num(snap ? +snap.入库数量 : null) + '</td>'
        + '<td class="num">' + num(snap ? +snap.出库数量 : null) + '</td>'
        + '<td class="num">' + num(pm) + '</td>'
        + '<td class="num">' + num(lym) + '</td>'
        + '<td class="num' + (stock != null && stock < 0 ? ' neg' : '') + '">' + num(stock) + '</td>'
        + '<td class="num"><input type="number" min="0" step="1" class="flow-repl-input" value="' + esc(replVal) + '" placeholder="—"></td></tr>';
    }).join('');

    if (list.length > replShown.length) {
      html += '<tr class="more-row"><td colspan="13"><button type="button" class="btn flow-more" style="width:100%">显示更多（已显示 '
        + replShown.length + ' / 共 ' + list.length + ' 个物料）</button></td></tr>';
    }
    tb.innerHTML = html;
    $all('.flow-more', tb).forEach(function (btn) {
      btn.addEventListener('click', function () {
        flowReplLimit[type] += FLOW_PAGE;
        renderFlowPane(type);
      });
    });
    $all('.flow-repl-input', tb).forEach(function (inp) {
      inp.addEventListener('change', function () {
        var tr = inp.closest('tr');
        var code = tr.getAttribute('data-code');
        var v = inp.value.trim();
        if (v !== '' && (isNaN(+v) || +v < 0)) { toast('补货数量需为不小于 0 的数字', 'warn'); inp.value = (state.matMap[code] || {}).计划补货数量 || ''; return; }
        DB.get('material', code).then(function (m) {
          if (!m) { inp.value = ''; throw new Error('物料档案不存在'); }
          m.计划补货数量 = v === '' ? '' : +v;
          return DB.put('material', m).then(function () {
            if (state.matMap[code]) state.matMap[code].计划补货数量 = m.计划补货数量;
            return DB.log({ 操作类型: '计划补货录入', 详情: { 库存类型: stockType, 物料编码: code, 计划补货数量: m.计划补货数量 } });
          });
        }).then(function () { toast(code + ' 计划补货数量已保存：' + (v === '' ? '空' : v), 'ok'); })
          .catch(function (e) { toast(e.message, 'err'); });
      });
    });
  }

  /* 流水视图子页切换 */
  function switchFlowTab(tab) {
    flowTab = tab === 'semi' ? 'semi' : 'finish';
    $all('#view-flow .flow-tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-flowtab') === flowTab);
    });
    var f = $('#flow-pane-finish'), s = $('#flow-pane-semi');
    if (f) f.hidden = flowTab !== 'finish';
    if (s) s.hidden = flowTab !== 'semi';
    renderFlowPane(flowTab);   /* 切到哪个子页才渲染哪个（renderFlow 只渲染当前可见子页） */
  }

  /* ================================================================
   * 视图：半成品（库存 + 半成品↔成品对应维护）
   * ================================================================ */
  function semiSnapshot() {
    var latest = '';
    state.stocks.forEach(function (s) { if (s.库存类型 === '半成品' && s.日期 > latest) latest = s.日期; });
    var map = {};
    state.stocks.forEach(function (s) { if (s.库存类型 === '半成品' && s.日期 === latest) map[s.物料编码] = s; });
    return { latest: latest, map: map };
  }

  function matchClass(sc) {
    if (sc === null || sc === undefined || sc === '') return 'sc-none';
    if (+sc >= 88) return 'sc-high';
    if (+sc >= 70) return 'sc-mid';
    return 'sc-low';
  }

  function renderSemi() {
    var snap = semiSnapshot();
    var byCode = {};
    state.materials.filter(function (m) { return m.库存属性 === '半成品'; }).forEach(function (m) { byCode[m.物料编码] = m; });
    Object.keys(snap.map).forEach(function (c) { if (!byCode[c]) byCode[c] = { 物料编码: c, 物料名称: '', 主单位: '' }; });

    var linksBy = {};
    state.bomLinks.forEach(function (l) { (linksBy[l.半成品编码] = linksBy[l.半成品编码] || []).push(l); });

    var kw = ($('#semi-search') ? $('#semi-search').value : '').trim().toLowerCase();
    var fv = $('#semi-filter') ? $('#semi-filter').value : '';

    function kwHit(code, name, links) {
      if (!kw) return true;
      var hay = [code, name].concat(links.map(function (l) {
        return l.成品编码 + ' ' + ((state.matMap[l.成品编码] || {}).物料名称 || '');
      })).join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    }
    function statusHit(links, v) {
      if (!v) return true;
      if (v === '一对多') return links.length > 1;
      if (v === '有关联') return links.length >= 1;
      if (v === '无关联') return links.length === 0;
      if (v === '含已确认') return links.some(function (l) { return l.状态 === '已确认' || l.状态 === '已锁定'; });
      if (v === '待确认') return links.some(function (l) { return l.状态 === '待确认'; });
      if (v === '已锁定') return links.some(function (l) { return l.状态 === '已锁定'; });
      return true;
    }

    var rows = Object.keys(byCode).sort().map(function (c) {
      return { m: byCode[c], links: (linksBy[c] || []).slice().sort(function (a, b) { return a.成品编码.localeCompare(b.成品编码); }) };
    }).filter(function (r) {
      return kwHit(r.m.物料编码, r.m.物料名称, r.links) && statusHit(r.links, fv);
    });

    /* 统计 */
    var decided = rows.filter(function (r) { return r.links.some(function (l) { return l.状态 === '已确认' || l.状态 === '已锁定'; }); }).length;
    var multi = rows.filter(function (r) { return r.links.length > 1; }).length;
    $('#semi-stat').textContent = '当前筛选 ' + rows.length + ' 条 | 已定案 ' + decided + ' 条 | 一对多 ' + multi + ' 条' + (snap.latest ? '（库存取 ' + snap.latest + ' 半成品快照）' : '（暂无半成品快照）');

    /* 成品候选 datalist */
    var dl = $('#finish-list');
    if (dl) {
      dl.innerHTML = state.materials.filter(function (m) { return m.库存属性 === '成品'; }).map(function (m) {
        return '<option value="' + esc(m.物料编码) + '">' + esc(m.物料名称) + '</option>';
      }).join('');
    }

    var tb = $('#semi-table tbody');
    if (!tb) return;
    if (rows.length === 0) {
      tb.innerHTML = '<tr><td colspan="9" class="empty">暂无半成品数据，请先到【数据导入】拖入半成品库存报表</td></tr>';
      return;
    }

    function statusCtrl(l) {
      if (l.状态 === '已锁定') return '<span class="tag tag-blue">🔒 已锁定</span>';
      return '<select class="semi-bom-status" data-s="' + esc(l.半成品编码) + '" data-f="' + esc(l.成品编码) + '">'
        + ['待确认', '已确认'].map(function (s) { return '<option ' + (l.状态 === s ? 'selected' : '') + '>' + s + '</option>'; }).join('')
        + '</select>';
    }

    tb.innerHTML = rows.map(function (r) {
      var code = r.m.物料编码, name = r.m.物料名称 || snap.map[code] && (snap.map[code].物料名称 || '');
      var st = snap.map[code];
      var unit = r.m.主单位 || (st && st.单位) || '';
      var n = Math.max(1, r.links.length);

      var headCells = '<td class="code" rowspan="' + n + '">' + esc(code) + '</td>'
        + '<td rowspan="' + n + '">' + esc(name) + '</td>'
        + '<td class="num" rowspan="' + n + '">' + (st ? fmtNum(st.数量) : '—') + '</td>'
        + '<td rowspan="' + n + '">' + esc(unit) + '</td>';

      var linkRows;
      if (r.links.length === 0) {
        linkRows = '<tr>' + headCells
          + '<td class="muted">未关联任何成品</td><td class="num">—</td>'
          + '<td><select disabled><option>待确认</option></select></td><td></td>'
          + '<td><button class="btn btn-sm semi-bom-add" data-s="' + esc(code) + '">＋ 添加关联</button></td></tr>';
      } else {
        linkRows = r.links.map(function (l) {
          var fm = state.matMap[l.成品编码];
          var finishCell = '<div class="finish-cell"><span class="code">' + esc(l.成品编码) + '</span>'
            + (fm ? '<span class="finish-name">' + esc(fm.物料名称) + '</span>'
                   : '<span class="finish-missing">（编码不在档案，请核对）</span>') + '</div>';
          var score = (l.匹配度 === null || l.匹配度 === undefined || l.匹配度 === '')
            ? '—' : '<span class="' + matchClass(l.匹配度) + '">' + l.匹配度 + '%</span>';
          var useCtrl = l.状态 === '已锁定'
            ? '<input type="number" step="0.0001" class="semi-bom-use" value="' + esc(l.单耗) + '" disabled style="width:92px;text-align:right">'
            : '<input type="number" step="0.0001" class="semi-bom-use" data-s="' + esc(l.半成品编码) + '" data-f="' + esc(l.成品编码) + '" value="' + esc(l.单耗) + '" placeholder="公斤/箱" style="width:92px;text-align:right">';
          var ops = '<div class="row-actions">'
            + '<button class="icon-btn semi-bom-add" data-s="' + esc(l.半成品编码) + '" title="再关联一个成品">＋</button>';
          if (l.状态 !== '已锁定') ops += '<button class="icon-btn del semi-bom-del" data-s="' + esc(l.半成品编码) + '" data-f="' + esc(l.成品编码) + '" title="删除该关联">🗑</button>';
          ops += '</div>';
          return '<tr>' + (l === r.links[0] ? headCells : '')
            + '<td>' + finishCell + '</td>'
            + '<td class="num">' + score + '</td>'
            + '<td>' + statusCtrl(l) + '</td>'
            + '<td>' + useCtrl + '</td>'
            + '<td>' + ops + '</td></tr>';
        }).join('');
      }
      return linkRows;
    }).join('');

    /* 事件绑定 */
    $all('.semi-bom-status', tb).forEach(function (sel) {
      sel.addEventListener('change', function () {
        Importer.upsertBomLink(sel.getAttribute('data-s'), sel.getAttribute('data-f'), { 状态: sel.value })
          .then(function () {
            return DB.log({ 操作类型: '对应关系确认', 详情: { 半成品: sel.getAttribute('data-s'), 成品: sel.getAttribute('data-f'), 状态: sel.value } });
          })
          .then(function () { afterChange(); toast(sel.value === '已确认' ? '已定案，后续导入不会改变该关系' : '已改为待确认', 'ok'); })
          .catch(function (e) { toast(e.message, 'err'); afterChange(); });
      });
    });
    $all('.semi-bom-use', tb).forEach(function (inp) {
      inp.addEventListener('change', function () {
        var v = inp.value.trim();
        var patch = { 单耗: v === '' ? '' : (isNaN(parseFloat(v)) ? '' : parseFloat(v)) };
        Importer.upsertBomLink(inp.getAttribute('data-s'), inp.getAttribute('data-f'), patch)
          .then(function () { afterChange(); toast('已保存单耗', 'ok'); })
          .catch(function (e) { toast(e.message, 'err'); afterChange(); });
      });
    });
    $all('.semi-bom-del', tb).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var s = btn.getAttribute('data-s'), f = btn.getAttribute('data-f');
        if (!confirm('确认删除 ' + s + ' → ' + f + ' 的对应关系？')) return;
        DB.del('bom', [f, s]).then(function () {
          return DB.log({ 操作类型: '对应关系删除', 详情: { 半成品: s, 成品: f } });
        }).then(function () { afterChange(); toast('已删除', 'ok'); });
      });
    });
    $all('.semi-bom-add', tb).forEach(function (btn) {
      btn.addEventListener('click', function () { openAddBom(btn.getAttribute('data-s')); });
    });
  }

  /** 弹窗：为半成品新增一个成品关联（一对多） */
  function openAddBom(semiCode) {
    var m = state.matMap[semiCode] || {};
    openModal('添加对应关系 · 半成品 ' + semiCode,
      '<div style="margin-bottom:10px;color:#475569">' + esc(m.物料名称 || '') + '（一个半成品可关联多个成品，每箱成品耗用半成品按"单耗"填写）</div>'
      + '<div style="display:flex;flex-direction:column;gap:10px">'
      + '<label>成品编码 * <input id="bom-add-finish" list="finish-list" placeholder="输入或粘贴 13 位成品编码" style="width:100%;padding:7px;border:1px solid #cbd5e1;border-radius:7px"></label>'
      + '<label>单耗（公斤/箱，做 1 箱成品耗用多少公斤该半成品，可后补） <input id="bom-add-use" type="number" step="0.0001" style="width:100%;padding:7px;border:1px solid #cbd5e1;border-radius:7px"></label>'
      + '<label class="hint"><input type="checkbox" id="bom-add-confirm"> 保存即为"已确认"定案（不勾选则保持待确认）</label>'
      + '</div>'
      + '<div class="btn-row" style="margin-top:14px;justify-content:flex-end"><button class="btn" id="bom-add-cancel">取消</button><button class="btn btn-primary" id="bom-add-ok">保存关联</button></div>');
    $('#bom-add-cancel').addEventListener('click', closeModal);
    $('#bom-add-ok').addEventListener('click', function () {
      var fc = $('#bom-add-finish').value.trim();
      if (!fc) { toast('请填写成品编码', 'err'); return; }
      var useV = $('#bom-add-use').value.trim();
      var patch = { 来源: '手工' };
      if (useV !== '') patch.单耗 = parseFloat(useV) || '';
      if ($('#bom-add-confirm').checked) patch.状态 = '已确认';
      Importer.upsertBomLink(semiCode, fc, patch)
        .then(function () {
          return DB.log({ 操作类型: '对应关系手工新增', 详情: { 半成品: semiCode, 成品: fc } });
        })
        .then(function () { closeModal(); afterChange(); toast('已添加关联' + (state.matMap[fc] ? '' : '（成品编码不在档案，请核对）'), state.matMap[fc] ? 'ok' : 'warn'); })
        .catch(function (e) { toast(e.message, 'err'); });
    });
    setTimeout(function () { var el = $('#bom-add-finish'); if (el) el.focus(); }, 50);
  }

  function initSemi() {
    $('#semi-search').addEventListener('input', renderSemi);
    $('#semi-filter').addEventListener('change', renderSemi);

    $('#btn-bom-lock').addEventListener('click', function () {
      var n = 0;
      state.bomLinks.filter(function (l) { return l.状态 === '已确认'; }).forEach(function (l) { l.状态 = '已锁定'; l.更新时间 = Importer.nowStr(); n++; });
      if (!n) { toast('没有"已确认"待锁定的关系', 'warn'); return; }
      if (!confirm('将把 ' + n + ' 条已确认关系批量锁定。\n锁定后不随导入更新、也不被备份恢复覆盖，仅可人工解锁。确认？')) return;
      DB.bulkPut('bom', state.bomLinks.filter(function (l) { return l.状态 === '已锁定'; })).then(function () {
        return DB.log({ 操作类型: '对应关系批量锁定', 详情: { 数量: n } });
      }).then(function () { afterChange(); toast('已锁定 ' + n + ' 条', 'ok'); });
    });
    $('#btn-bom-unlock').addEventListener('click', function () {
      var locked = state.bomLinks.filter(function (l) { return l.状态 === '已锁定'; });
      if (!locked.length) { toast('没有已锁定的关系', 'warn'); return; }
      if (!confirm('将解锁 ' + locked.length + ' 条关系（解锁后恢复为"已确认"，可继续编辑）。确认？')) return;
      locked.forEach(function (l) { l.状态 = '已确认'; l.更新时间 = Importer.nowStr(); });
      DB.bulkPut('bom', locked).then(function () {
        return DB.log({ 操作类型: '对应关系批量解锁', 详情: { 数量: locked.length } });
      }).then(function () { afterChange(); toast('已解锁 ' + locked.length + ' 条', 'ok'); });
    });
    $('#btn-bom-export').addEventListener('click', function () {
      Backup.exportBomLinks().then(function () { toast('对应关系已导出', 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
    });
    $('#tpl-bom').addEventListener('click', function () { Backup.downloadBomTemplate(); });
    $('#btn-bom-import').addEventListener('click', function () { $('#bom-import-file').click(); });
    $('#bom-import-file').addEventListener('change', function () {
      if (!this.files.length) return;
      var f = this.files[0];
      Importer.importBomLinks(f).then(function (r) {
        var html = '<div class="report-summary">'
          + '<div class="report-chip add">新增 <b>' + r.新增 + '</b></div>'
          + '<div class="report-chip upd">更新 <b>' + r.更新 + '</b></div>'
          + '<div class="report-chip skip">跳过 <b>' + r.跳过.length + '</b></div>'
          + '<div class="report-chip">警告 <b>' + r.警告.length + '</b></div></div>'
          + (r.跳过.length ? '<div class="report-list">' + r.跳过.slice(0, 30).map(function (x) {
            return '<div class="rl-item"><span class="rl-tag rl-skip">跳过</span><span>' + esc(x.编码) + '：' + esc(x.原因) + '</span></div>'; }).join('') + '</div>' : '')
          + (r.警告.length ? '<div class="report-list">' + r.警告.slice(0, 30).map(function (x) {
            return '<div class="rl-item"><span class="rl-tag" style="background:#fef3c7;color:#b45309">警告</span><span>' + esc(x.编码) + '：' + esc(x.原因) + '</span></div>'; }).join('') + '</div>' : '');
        afterChange();
        openModal('对应关系导入完成', html);
      }).catch(function (e) { toast('导入失败：' + e.message, 'err'); });
      this.value = '';
    });
  }


  /* ================================================================
   * 视图：欠货跟踪
   * ================================================================ */
  function isOpenBO(b) { return b.状态 !== '已结清'; }

  function isOverdueBO(b) { return b.需求日期 && b.需求日期 < todayStr() && b.状态 !== '已结清' && b.状态 !== '可发货'; }

  function diffDays(a, b) { return Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 86400000); }

  /* 箱规数字：物料档案"箱规"文本（如 40包/箱 -> 40）；无法解析返回 0 */
  function boxQty(code) {
    var m = state.matMap[code] || {};
    var n = parseInt(String(m.箱规 || ''), 10);
    return n > 0 ? n : 0;
  }

  /* 主计数量：记录自带优先；否则 件数×每箱装量（无箱规按件数原值） */
  function mainQty(b) {
    if (b.主计数量 != null && b.主计数量 !== '') return +b.主计数量 || 0;
    return (+b.欠货数量 || 0) * (boxQty(b.物料编码) || 1);
  }

  /* 成品最新快照的库存 map {编码: 数量} */
  function finishStockMap() {
    var latest = '';
    state.stocks.forEach(function (s) {
      if (s.库存类型 === '成品' && s.日期 > latest) latest = s.日期;
    });
    var map = {};
    state.stocks.forEach(function (s) {
      if (s.库存类型 === '成品' && s.日期 === latest) map[s.物料编码] = +s.数量 || 0;
    });
    return map;
  }

  var boSel = {};   // 明细勾选 {id: 1}

  function renderBackorder() {
    var all = state.backorders;
    var open = all.filter(isOpenBO);
    var codes = {}; var qty = 0;
    open.forEach(function (b) { codes[b.物料编码] = 1; qty += +b.欠货数量 || 0; });
    $('#kpi-bo-items').textContent = Object.keys(codes).length;
    $('#kpi-bo-qty').textContent = fmtNum(qty);
    $('#kpi-bo-overdue').textContent = open.filter(isOverdueBO).length;
    $('#kpi-bo-pending').textContent = open.filter(function (b) { return b.状态 === '待排产'; }).length;

    /* 未结清按物料汇总（箱） */
    var agg = {};
    open.forEach(function (b) { agg[b.物料编码] = (agg[b.物料编码] || 0) + (+b.欠货数量 || 0); });

    /* 欠货 Top 10（按物料汇总，箱） */
    var top = Object.keys(agg).map(function (c) { return { code: c, qty: agg[c] }; })
      .sort(function (a, b) { return b.qty - a.qty; }).slice(0, 10);
    $('#bo-top-table tbody').innerHTML = top.length ? top.map(function (t) {
      var m = state.matMap[t.code] || {};
      return '<tr><td>' + esc(t.code) + '</td><td>' + esc(m.物料名称 || '（未建档）') + '</td>'
        + '<td class="num num-red">' + fmtNum(t.qty) + '</td></tr>';
    }).join('') : '<tr><td colspan="3" class="empty">暂无欠货数据</td></tr>';

    /* 超期未发提醒 */
    var over = open.filter(isOverdueBO).sort(function (a, b) { return String(a.需求日期).localeCompare(String(b.需求日期)); });
    $('#bo-overdue-box').innerHTML = over.length
      ? '<table class="grid"><thead><tr><th class="col-code">编码</th><th class="col-name">名称</th><th class="num col-qty">欠货(箱)</th><th class="col-date">需求日期</th><th class="col-over">超期</th></tr></thead><tbody>'
        + over.map(function (b) {
          var m = state.matMap[b.物料编码] || {};
          return '<tr><td>' + esc(b.物料编码) + '</td><td>' + esc(m.物料名称 || '') + '</td>'
            + '<td class="num num-red">' + fmtNum(+b.欠货数量 || 0) + '</td>'
            + '<td>' + esc(b.需求日期) + '</td><td><span class="tag tag-red">超 ' + diffDays(todayStr(), b.需求日期) + ' 天</span></td></tr>';
        }).join('') + '</tbody></table>'
      : '<div class="empty">没有已设需求日期且超期的欠货</div>';

    /* 欠货产品 · 库存对比（全部欠货物料）：按 产品系列 + 子分类 分组 */
    var finMap = finishStockMap();
    var cmp = Object.keys(agg).map(function (c) {
      var m = state.matMap[c] || {};
      var hasRec = Object.prototype.hasOwnProperty.call(finMap, c);
      var st = hasRec ? finMap[c] : 0;
      var lvl = (!hasRec || st <= 0) ? 0 : (st < agg[c] ? 1 : 2);
      return {
        code: c, name: m.物料名称 || '（未建档）', spec: m.规格型号 || '',
        series: m.产品系列 || '未分类', sub: m['子分类(包装形态)'] || '未分类',
        bo: agg[c], stock: st, gap: Math.max(0, agg[c] - st), lvl: lvl
      };
    });

    /* 按 产品系列 / 子分类 分组，组内排序：缺 → 不足 → 充足，同组按缺口从大到小 */
    var groups = {};
    cmp.forEach(function (r) {
      var gk = r.series + ' / ' + r.sub;
      (groups[gk] = groups[gk] || []).push(r);
    });
    Object.keys(groups).forEach(function (gk) {
      groups[gk].sort(function (a, b) {
        return (a.lvl - b.lvl) || (b.gap - a.gap) || a.code.localeCompare(b.code);
      });
    });
    var gKeys = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });

    var n0 = 0, n1 = 0, n2 = 0, boSum = 0, stSum = 0;
    cmp.forEach(function (r) {
      if (r.lvl === 0) n0++; else if (r.lvl === 1) n1++; else n2++;
      boSum += r.bo; stSum += r.stock;
    });
    $('#bo-cmp-summary').innerHTML = cmp.length
      ? '共 <b>' + cmp.length + '</b> 种欠货产品：<span class="tag tag-red">缺货 ' + n0 + '</span> '
        + '<span class="tag tag-amber">不足 ' + n1 + '</span> <span class="tag tag-green">充足 ' + n2 + '</span>'
        + '&ensp;｜&ensp;欠货合计 <b>' + fmtNum(boSum) + '</b> 箱，库存合计 <b>' + fmtNum(stSum) + '</b> 箱'
      : '';
    var LVL_TAG = ['<span class="tag tag-red">缺货</span>', '<span class="tag tag-amber">不足</span>', '<span class="tag tag-green">充足</span>'];
    var tbCmp = $('#bo-cmp-table tbody');
    if (!cmp.length) {
      tbCmp.innerHTML = '<tr><td colspan="7" class="empty">暂无欠货数据</td></tr>';
    } else {
      tbCmp.innerHTML = gKeys.map(function (gk) {
        var rows = groups[gk];
        var allFin = rows.every(function (r) { return r.lvl !== 0; });
        var allSemi = rows.every(function (r) { return r.lvl === 0; });
        var gcls = allSemi ? 'grp-red' : (allFin ? 'grp-green' : '');
        var head = '<tr class="group-row bo-cmp-group ' + gcls + '" data-g="' + esc(gk) + '"><td colspan="7">'
          + '<span class="gi">▾</span>' + esc(gk)
          + ' <span class="g-count">（' + rows.length + ' 项）</span></td></tr>';
        var body = rows.map(function (r) {
          return '<tr class="bo-cmp-row ' + (r.lvl === 0 ? 'row-red' : r.lvl === 1 ? 'row-amber' : '') + '" data-g="' + esc(gk) + '">'
            + '<td>' + esc(r.code) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.spec) + '</td>'
            + '<td class="num">' + fmtNum(r.bo) + '</td><td class="num">' + fmtNum(r.stock) + '</td>'
            + '<td class="num ' + (r.gap > 0 ? 'num-red' : '') + '">' + fmtNum(r.gap) + '</td>'
            + '<td>' + LVL_TAG[r.lvl] + '</td></tr>';
        }).join('');
        return head + body;
      }).join('');
      /* 分组行点击折叠 */
      $all('.bo-cmp-group', tbCmp).forEach(function (tr) {
        tr.addEventListener('click', function () {
          var k = tr.getAttribute('data-g');
          tr.classList.toggle('collapsed');
          var hide = tr.classList.contains('collapsed');
          $all('.bo-cmp-row[data-g="' + CSS.escape(k) + '"]', tbCmp).forEach(function (r) { r.style.display = hide ? 'none' : ''; });
        });
      });
    }

    /* 明细表：最新录入在前；双击改单元格；勾选批量 */
    var statusF = $('#bo-status-filter').value;
    var kw = $('#bo-search').value.trim().toLowerCase();
    var list = all.slice().sort(function (a, b) {
      return String(b.录入日期 || '').localeCompare(String(a.录入日期 || ''))
        || String(a.需求日期).localeCompare(String(b.需求日期))
        || (b.id - a.id);
    });
    if (statusF) list = list.filter(function (b) { return b.状态 === statusF; });
    if (kw) list = list.filter(function (b) {
      var m = state.matMap[b.物料编码] || {};
      return [b.物料编码, m.物料名称].join(' ').toLowerCase().indexOf(kw) >= 0;
    });

    var tb = $('#bo-table tbody');
    if (list.length === 0) {
      tb.innerHTML = '<tr><td colspan="12" class="empty">暂无欠货记录，使用上方"欠货快照"添加</td></tr>';
    } else {
      tb.innerHTML = list.map(function (b) {
        var m = state.matMap[b.物料编码] || {};
        var overdue = isOverdueBO(b);
        return '<tr class="' + (overdue ? 'row-overdue' : '') + '" data-id="' + b.id + '">'
          + '<td><input type="checkbox" class="bo-ck"' + (boSel[b.id] ? ' checked' : '') + '></td>'
          + '<td class="bo-edit" data-f="录入日期" data-t="date" data-v="' + esc(b.录入日期 || '') + '">' + esc(b.录入日期 || '') + '</td>'
          + '<td>' + esc(b.物料编码) + '</td><td>' + esc(m.物料名称 || '（未建档）') + '</td>'
          + '<td>' + esc(m.规格型号 || '') + '</td>'
          + '<td class="num bo-edit" data-f="欠货数量" data-t="num" data-v="' + esc(b.欠货数量) + '">' + esc(b.欠货数量) + '</td>'
          + '<td class="num bo-edit" data-f="主计数量" data-t="num" data-v="' + mainQty(b) + '">' + fmtNum(mainQty(b)) + '</td>'
          + '<td>' + esc(b.单位 || '件') + '</td>'
          + '<td class="bo-edit" data-f="需求日期" data-t="date" data-v="' + esc(b.需求日期 || '') + '">' + esc(b.需求日期 || '') + (overdue ? ' <span class="tag tag-red">超期</span>' : '') + '</td>'
          + '<td class="bo-edit" data-f="订单号" data-t="text" data-v="' + esc(b.订单号 || '') + '">' + esc(b.订单号 || '') + '</td>'
          + '<td><select class="bo-status">'
          + BO_STATUSES.map(function (s) { return '<option ' + (b.状态 === s ? 'selected' : '') + '>' + s + '</option>'; }).join('')
          + '</select></td>'
          + '<td><button class="icon-btn del" title="删除该行">×</button></td></tr>';
      }).join('');

      $all('tr[data-id]', tb).forEach(function (tr) {
        var id = +tr.getAttribute('data-id');
        $('.bo-ck', tr).addEventListener('change', function () {
          if (this.checked) boSel[id] = 1; else delete boSel[id];
          updateBatchBar();
        });
        $all('.bo-edit', tr).forEach(function (td) {
          td.addEventListener('dblclick', function () { beginEditBO(td, id); });
        });
        $('.bo-status', tr).addEventListener('change', function () { updateBO(id, { 状态: this.value, 状态变更时间: Importer.nowStr() }); });
        $('.del', tr).addEventListener('click', function () {
          if (confirm('确认删除该欠货行？此操作不可恢复。')) DB.del('backorder', id).then(afterChange);
        });
      });
    }
    updateBatchBar();
  }

  /* 双击编辑明细单元格（date/num/text），Enter 或失焦保存，Esc 取消 */
  function beginEditBO(td, id) {
    if (td.getAttribute('data-editing') === '1') return;
    var rec = null;
    state.backorders.forEach(function (b) { if (b.id === id) rec = b; });
    if (!rec) return;
    var field = td.getAttribute('data-f'), type = td.getAttribute('data-t');
    var input = document.createElement('input');
    input.type = type === 'date' ? 'date' : type === 'num' ? 'number' : 'text';
    if (type === 'num') { input.step = '0.01'; input.min = '0'; }
    input.value = td.getAttribute('data-v') || '';
    input.className = 'cell-edit';
    td.setAttribute('data-editing', '1');
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    try { input.select(); } catch (e) {}

    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      td.removeAttribute('data-editing');
      if (save === false) { renderBackorder(); return; }
      var v = input.value.trim();
      var patch = {};
      if (type === 'num') {
        var n = parseFloat(v);
        if (isNaN(n)) n = 0;
        if (field === '欠货数量') {
          patch.欠货数量 = n;
          var bq = boxQty(rec.物料编码);
          if (bq > 0) patch.主计数量 = n * bq;   // 件数变动联动重算主计数量
        } else {
          patch[field] = n;
        }
      } else {
        patch[field] = v;
      }
      updateBO(id, patch);
    }
    input.addEventListener('change', function () { commit(); });
    input.addEventListener('blur', function () { commit(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      else if (e.key === 'Escape') { commit(false); }
    });
  }

  function updateBatchBar() {
    var bar = $('#bo-batch-bar');
    if (!bar) return;
    var n = Object.keys(boSel).length;
    bar.hidden = n === 0;
    $('#bo-batch-info').textContent = n ? '已选 ' + n + ' 行' : '';
  }

  function initBOBatch() {
    $('#bo-check-all').addEventListener('change', function () {
      var on = this.checked;
      $all('#bo-table tbody tr[data-id]').forEach(function (tr) {
        var id = +tr.getAttribute('data-id');
        $('.bo-ck', tr).checked = on;
        if (on) boSel[id] = 1; else delete boSel[id];
      });
      updateBatchBar();
    });
    $('#bo-batch-clear').addEventListener('click', function () {
      var ids = Object.keys(boSel).map(Number);
      if (!ids.length) return;
      Promise.all(ids.map(function (id) {
        return DB.get('backorder', id).then(function (b) {
          if (!b || b.状态 === '已结清') return;
          b.状态 = '已结清';
          b.状态变更时间 = Importer.nowStr();
          b.操作时间 = Importer.nowStr();
          return DB.put('backorder', b);
        });
      })).then(function () {
        return DB.log({ 操作类型: '欠货批量结清', 详情: { 行数: ids.length } });
      }).then(function () {
        boSel = {};
        afterChange();
        toast('已标记 ' + ids.length + ' 行为已结清', 'ok');
      });
    });
    $('#bo-batch-del').addEventListener('click', function () {
      var ids = Object.keys(boSel).map(Number);
      if (!ids.length) return;
      if (!confirm('确认删除选中的 ' + ids.length + ' 行欠货？此操作不可恢复。')) return;
      Promise.all(ids.map(function (id) { return DB.del('backorder', id); }))
        .then(function () { return DB.log({ 操作类型: '欠货批量删除', 详情: { 行数: ids.length } }); })
        .then(function () {
          boSel = {};
          afterChange();
          toast('已删除 ' + ids.length + ' 行', 'ok');
        });
    });
  }

  function parseQty(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  function updateBO(id, patch) {
    DB.get('backorder', id).then(function (b) {
      if (!b) return;
      Object.assign(b, patch);
      b.操作时间 = Importer.nowStr();
      return DB.put('backorder', b).then(function () {
        return DB.log({ 操作类型: '欠货手改', 详情: { id: id, 改动: patch } });
      }).then(afterChange);
    });
  }

  function initBOForm() {
    var f = $('#bo-form');
    var codeInput = $('#bo-code-input');
    var acList = $('#bo-ac-list');
    var info = $('#bo-form-info');
    var INFO_DEF = '选中编码后自动带出产品名称、规格与每箱装量';
    f.需求日期.value = todayStr();

    function pickInfo(code) {
      var m = state.matMap[code];
      if (!m) { info.textContent = INFO_DEF; return; }
      var bq = boxQty(code);
      info.innerHTML = '已选：<b>' + esc(m.物料名称 || '（未命名）') + '</b>&ensp;｜&ensp;规格 ' + esc(m.规格型号 || '—')
        + '&ensp;｜&ensp;每箱装量 ' + (bq ? esc(m.箱规) : '<span style="color:var(--amber)">未设箱规，主计数量将按件数原值折算</span>');
    }

    codeInput.addEventListener('input', function () {
      var kw = this.value.trim().toLowerCase();
      if (state.matMap[this.value.trim()]) pickInfo(this.value.trim());
      if (!kw) { acList.style.display = 'none'; return; }
      var cands = state.materials.filter(function (m) { return m.库存属性 !== '半成品'; })
        .filter(function (m) {
          var c = String(m.物料编码).toLowerCase(), n = String(m.物料名称 || '').toLowerCase();
          return c.indexOf(kw) >= 0 || n.indexOf(kw) >= 0;
        })
        .sort(function (a, b) {   // 编码前缀 > 编码包含 > 仅名称匹配
          var ca = String(a.物料编码).toLowerCase(), cb = String(b.物料编码).toLowerCase();
          var pa = ca.indexOf(kw) === 0 ? 0 : (ca.indexOf(kw) > 0 ? 1 : 2);
          var pb = cb.indexOf(kw) === 0 ? 0 : (cb.indexOf(kw) > 0 ? 1 : 2);
          return pa - pb || ca.localeCompare(cb);
        })
        .slice(0, 12);
      acList.innerHTML = cands.length ? cands.map(function (m) {
        return '<div class="ac-item" data-code="' + esc(m.物料编码) + '">'
          + '<span class="c">' + esc(m.物料编码) + '</span>'
          + '<span class="n">' + esc(m.物料名称 || '') + '</span>'
          + '<span class="s">' + esc(m.规格型号 || '') + (m.箱规 ? ' · ' + esc(m.箱规) : '') + '</span></div>';
      }).join('') : '<div class="ac-empty">无匹配产品，可直接使用新编码</div>';
      acList.style.display = 'block';
    });

    acList.addEventListener('mousedown', function (e) {   // mousedown 先于输入框 blur
      var item = e.target.closest('.ac-item');
      if (!item) return;
      e.preventDefault();
      codeInput.value = item.getAttribute('data-code');
      acList.style.display = 'none';
      pickInfo(codeInput.value);
    });
    codeInput.addEventListener('blur', function () { setTimeout(function () { acList.style.display = 'none'; }, 120); });

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = codeInput.value.trim();
      var n = parseQty(f.欠货数量.value);
      if (!code || n <= 0) { toast('请填写产品编码和件数(箱)', 'warn'); return; }
      if (!state.matMap[code] && !/^[0-9A-Za-z\-]+$/.test(code)) {
        toast('未找到产品「' + code + '」，请从联想列表选择或输入完整编码', 'warn');
        return;
      }
      // 提交时从库中现读档案折算主计数量，避免内存档案过期；档案不存在才新建
      DB.get('material', code).then(function (m) {
        if (m) return m;
        var nm = { 物料编码: code, 物料名称: '', 产品系列: '', '子分类(包装形态)': '', 规格型号: '', 箱规: '', 库存属性: '成品', 产品形态: '', 包装形式: '', 主单位: '箱', 包装单位: '', 单位换算比: '', 安全水位: '', 目标库存天数: '', 状态: '启用' };
        return DB.put('material', nm).then(function () { return nm; });
      }).then(function (m) {
        var bq = parseInt(String(m.箱规 || ''), 10) || 0;
        var rec = {
          订单号: f.订单号.value.trim(),
          行号: '',
          物料编码: code,
          订单数量: n,
          已发数量: 0,
          欠货数量: n,
          主计数量: n * (bq || 1),
          单位: '件',
          需求日期: f.需求日期.value,
          客户: '',
          录入方式: '手录',
          状态: '待排产',
          状态变更时间: Importer.nowStr(),
          录入日期: todayStr(),
          操作时间: Importer.nowStr(),
          备注: ''
        };
        return DB.put('backorder', rec)
          .then(function () { return DB.log({ 操作类型: '欠货快录', 详情: { 物料编码: code, 件数: n, 主计数量: rec.主计数量, 箱规: m.箱规 || '', 需求日期: rec.需求日期, 订单号: rec.订单号 } }); })
          .then(function () {
            f.reset();
            f.需求日期.value = todayStr();
            info.textContent = INFO_DEF;
            afterChange();
            toast('已加入欠货清单：' + code + '（' + n + ' 箱）', 'ok');
          });
      });
    });
  }

  /* ================================================================
   * 视图：数据导入
   * ================================================================ */
  function initDropzone(divId, stockType) {
    var zone = $('#' + divId);
    var input = $('input[type=file]', zone);
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('drag'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); zone.classList.remove('drag');
      if (e.dataTransfer.files.length) handleStockFile(e.dataTransfer.files[0], stockType);
    });
    input.addEventListener('change', function () {
      if (input.files.length) handleStockFile(input.files[0], stockType);
      input.value = '';
    });
  }

  /* 产品清单（品牌系列/子分类档案）拖入 */
  function initCatalogDropzone(divId) {
    var zone = $('#' + divId);
    var input = $('input[type=file]', zone);
    if (!zone || !input) return;
    zone.addEventListener('click', function () { input.click(); });
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('drag'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault(); zone.classList.remove('drag');
      if (e.dataTransfer.files.length) handleCatalogFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', function () {
      if (input.files.length) handleCatalogFile(input.files[0]);
      input.value = '';
    });
  }

  function handleCatalogFile(file) {
    toast('正在解析产品清单 ' + file.name + ' …');
    Importer.importCatalog(file)
      .then(function (r) {
        afterChange();
        openModal('产品清单导入完成',
          '<div class="report-summary">'
          + '<div class="report-chip add">新增 <b>' + r.新增 + '</b></div>'
          + '<div class="report-chip upd">更新 <b>' + r.更新 + '</b></div>'
          + '<div class="report-chip">条目 <b>' + r.总数 + '</b></div></div>'
          + '<div style="color:#15803d;margin-top:8px">产品系列 / 子分类 / 箱规（瓶、袋等内包装单位）已按清单写入物料主数据，再导入成品日报即自动分组。</div>');
      })
      .catch(function (err) {
        console.error(err);
        openModal('导入失败', '<div style="color:#b91c1c">' + esc(err.message || err) + '</div>');
      });
  }

  /* 首次打开（或内置清单版本更新）自动载入随应用分发的产品清单 */
  function seedCatalog() {
    var CATALOG_URL = 'assets/data/product-catalog.json';
    var ver = '';
    try { ver = localStorage.getItem('catalog_ver') || ''; } catch (e) {}
    if (ver.indexOf('manual-') === 0) return Promise.resolve(null);
    return fetch(CATALOG_URL + '?v=' + (window.CATALOG_VERSION || ''))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (cat) {
        if (ver === cat.version) return null;
        return Importer.applyCatalogItems(cat.items, '内置产品清单 ' + cat.version).then(function (rep) {
          try { localStorage.setItem('catalog_ver', cat.version); } catch (e) {}
          return { count: cat.items.length, report: rep };
        });
      })
      .catch(function (err) { console.warn('内置产品清单加载失败：', err); return null; });
  }

  function handleStockFile(file, stockType) {
    // 文件名含 8 位日期（如"清洗结果_20261004_210638"）时自动作为导入日期，可在界面再改
    var nameDate = Importer.pickDateFromName(file.name);
    if (nameDate) {
      $('#import-date').value = nameDate;
      toast('已按文件名识别导入日期：' + nameDate, 'ok');
    }
    var date = $('#import-date').value || todayStr();
    var mode = $all('input[name=import-mode]').filter(function (r) { return r.checked; })[0].value;
    toast('正在解析 ' + file.name + ' …');
    Importer.importStock(file, stockType, date, mode)
      .then(function (report) {
        afterChange();
        showReport(report);
      })
      .catch(function (err) {
        console.error(err);
        openModal('导入失败', '<div style="color:#b91c1c">' + esc(err.message || err) + '</div>');
      });
  }

  function showReport(r) {
    var html = '<div class="report-summary">'
      + '<div class="report-chip add">新增 <b>' + r.新增 + '</b></div>'
      + '<div class="report-chip upd">更新 <b>' + r.更新 + '</b></div>'
      + '<div class="report-chip skip">跳过 <b>' + r.跳过.length + '</b></div>'
      + '<div class="report-chip">异常 <b>' + r.异常.length + '</b></div></div>'
      + '<div style="color:#64748b;margin-bottom:10px">批次号 ' + esc(r.批次号) + ' · ' + esc(r.来源文件) + ' · ' + esc(Importer.modeText(r.模式))
      + (r.清除当日 ? ' · 已清除当日旧数据 ' + r.清除当日 + ' 行' : '') + '</div>';
    if (r.合并行) html += '<div style="margin-bottom:8px;color:#b45309">文件内同编码同批次 ' + r.合并行 + ' 行已合并累加</div>';
    if (r.异常.length) {
      html += '<div style="font-weight:600;margin:6px 0">异常（已导入，请核对）：</div><div class="report-list">'
        + r.异常.slice(0, 50).map(function (x) {
          return '<div class="rl-item"><span class="rl-tag rl-skip">异常</span><span>' + esc(x.编码) + ' / ' + esc(x.批次) + '：' + esc(x.原因) + '</span></div>';
        }).join('') + '</div>';
    }
    if (r.跳过.length) {
      html += '<div style="font-weight:600;margin:10px 0 6px">跳过明细：</div><div class="report-list">'
        + r.跳过.slice(0, 50).map(function (x) {
          return '<div class="rl-item"><span class="rl-tag rl-skip">跳过</span><span>第 ' + x.行号 + ' 行' + (x.编码 ? ' ' + esc(x.编码) : '') + '：' + esc(x.原因) + '</span></div>';
        }).join('') + '</div>';
    }
    if (!r.异常.length && !r.跳过.length) html += '<div style="color:#15803d">全部行校验通过 ✔</div>';
    openModal('导入报告 · ' + r.类型, html);
  }

  function renderImportLog() {
    var list = state.logs.filter(function (l) { return l.操作类型.indexOf('导入') >= 0; })
      .sort(function (a, b) { return String(b.时间).localeCompare(String(a.时间)); }).slice(0, 10);
    var tb = $('#import-log-table tbody');
    if (!list.length) { tb.innerHTML = '<tr><td colspan="8" class="empty">暂无导入记录</td></tr>'; return; }
    tb.innerHTML = list.map(function (l) {
      var d = safeJson(l.详情) || {};
      return '<tr><td>' + esc(l.批次号) + '</td><td>' + esc(l.时间) + '</td><td>' + esc(l.操作类型) + '</td>'
        + '<td>' + esc(l.来源文件) + '</td><td>' + (d.新增 != null ? d.新增 : '-') + '</td>'
        + '<td>' + (d.更新 != null ? d.更新 : '-') + '</td>'
        + '<td>' + (d.跳过 != null ? d.跳过 : '-') + '</td>'
        + '<td>' + esc(l.详情) + '</td></tr>';
    }).join('');
  }

  function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  function initClearButtons() {
    $all('[data-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.getAttribute('data-clear');
        var date = $('#import-date').value || todayStr();
        var scope = kind === '欠货' ? '今天录入且仍为"待排产"的欠货' : ('"' + kind + '"在 ' + date + ' 的全部快照');
        if (!confirm('确认清除' + scope + '？\n历史日期数据不会被删除。')) return;
        Importer.clearToday(kind, date).then(function (n) {
          afterChange();
          toast('已清除 ' + n + ' 条' + kind + '数据', 'warn');
        });
      });
    });
  }

  /* ================================================================
   * 视图：物料主数据
   * ================================================================ */
  var MAT_FIELDS = ['物料编码', '物料名称', '产品系列', '子分类(包装形态)', '规格型号', '箱规', '库存属性', '产品形态', '包装形式', '主单位', '安全水位', '目标库存天数'];

  /* 库存属性快速筛选：''=全部 / 成品 / 半成品 */
  var matAttrFilter = '';

  function renderMaterial() {
    var kw = $('#mat-search').value.trim().toLowerCase();
    var list = state.materials.slice().sort(function (a, b) { return a.物料编码.localeCompare(b.物料编码); });
    if (matAttrFilter) list = list.filter(function (m) { return (m.库存属性 || '') === matAttrFilter; });
    if (kw) list = list.filter(function (m) {
      return [m.物料编码, m.物料名称, m.产品系列, m['子分类(包装形态)'], m.产品形态, m.包装形式].join(' ').toLowerCase().indexOf(kw) >= 0;
    });
    var tb = $('#mat-table tbody');
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="11" class="empty">暂无物料，请先在【数据导入】建档或点"＋ 新增物料"</td></tr>';
      return;
    }
    /* 按 产品系列 + 子分类 分组展示（可折叠），组色随库存属性：全成品紫 / 全半成品绿 / 混合灰 */
    var groups = {};
    list.forEach(function (m) {
      var gk = (m.产品系列 || '未分类') + ' / ' + (m['子分类(包装形态)'] || '未分类');
      (groups[gk] = groups[gk] || []).push(m);
    });
    var gKeys = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
    tb.innerHTML = gKeys.map(function (gk) {
      var rows = groups[gk];
      var allFin = rows.every(function (m) { return m.库存属性 !== '半成品'; });
      var allSemi = rows.every(function (m) { return m.库存属性 === '半成品'; });
      var gcls = allSemi ? 'grp-semi' : (allFin ? 'grp-finish' : '');
      var head = '<tr class="group-row cat-group ' + gcls + '" data-g="' + esc(gk) + '"><td colspan="11">'
        + '<span class="gi">▾</span>' + esc(gk)
        + ' <span class="g-count">（' + rows.length + ' 项）</span></td></tr>';
      /* 行内仅保留 4 个常用字段可直接编辑（产品形态/包装形式/安全水位/目标库存天数），
       * 其余字段只读展示，点 ✎ 打开弹窗做详细编辑（含 产品系列/子分类 分组字段） */
      var body = rows.map(function (m) {
        return '<tr class="detail-row" data-g="' + esc(gk) + '" data-code="' + esc(m.物料编码) + '">'
          + '<td class="ro code">' + esc(m.物料编码) + '</td>'
          + '<td class="ro name">' + esc(m.物料名称 || '') + '</td>'
          + '<td class="ro">' + esc(m.规格型号 || '') + '</td>'
          + '<td class="ro">' + esc(m.箱规 || '') + '</td>'
          + '<td class="ro">' + esc(m.库存属性 || '—') + '</td>'
          + '<td>' + selectVal(['', '粉料', '块料', '酱料', '原始香辛料'], m.产品形态, '产品形态') + '</td>'
          + matInput(m, '包装形式')
          + '<td class="ro">' + esc(m.主单位 || '—') + '</td>'
          + matInput(m, '安全水位') + matInput(m, '目标库存天数')
          + '<td><div class="row-actions"><button class="icon-btn edit" title="详细编辑（含产品系列/子分类）">✎</button><button class="icon-btn save" title="保存行内修改">✓</button><button class="icon-btn del" title="删除">🗑</button></div></td></tr>';
      }).join('');
      return head + body;
    }).join('');

    $all('.group-row', tb).forEach(function (tr) {
      tr.addEventListener('click', function () {
        var k = tr.getAttribute('data-g');
        tr.classList.toggle('collapsed');
        var hide = tr.classList.contains('collapsed');
        $all('.detail-row[data-g="' + CSS.escape(k) + '"]', tb).forEach(function (r) { r.style.display = hide ? 'none' : ''; });
      });
    });
    $all('tr[data-code]', tb).forEach(function (tr) {
      var code = tr.getAttribute('data-code');
      $('.edit', tr).addEventListener('click', function () { openMatEditor(code); });
      $('.save', tr).addEventListener('click', function () { saveMaterial(tr, code); });
      $('.del', tr).addEventListener('click', function () {
        if (confirm('删除物料 "' + code + '" 不会删除其库存快照，确认删除主数据？')) {
          DB.del('material', code).then(function () { return DB.log({ 操作类型: '物料删除', 详情: { 物料编码: code } }); }).then(afterChange);
        }
      });
    });
  }

  function matInput(m, f) {
    return '<td><input data-f="' + esc(f) + '" value="' + esc(m[f]) + '"></td>';
  }
  function selectVal(opts, val, f) {
    return '<select data-f="' + esc(f) + '">' + opts.map(function (o) {
      return '<option value="' + esc(o) + '" ' + (m_eq(o, val) ? 'selected' : '') + '>' + (o || '未填') + '</option>';
    }).join('') + '</select>';
  }
  function m_eq(a, b) { return String(a == null ? '' : a) === String(b == null ? '' : b); }

  function readRow(tr) {
    var o = {};
    $all('[data-f]', tr).forEach(function (el) { o[el.getAttribute('data-f')] = el.value.trim(); });
    return o;
  }

  function saveMaterial(tr, code) {
    var o = readRow(tr);
    if (!o.物料编码 && !code) { toast('物料编码不能为空', 'err'); return; }
    var old = state.matMap[code] || {};
    var rec = Object.assign({}, old, o);
    DB.put('material', rec).then(function () { return DB.log({ 操作类型: '物料编辑', 详情: { 物料编码: code } }); })
      .then(function () { afterChange(); toast('已保存 ' + code, 'ok'); });
  }

  /* ---------------- 物料编辑弹窗（新增 / 详细编辑共用，含 产品系列/子分类 分组字段） ---------------- */
  function meEl(f) { return document.getElementById('me-' + f); }  /* id 含括号，用 getElementById 而非 querySelector */

  function openMatEditor(code) {
    var isNew = !code;
    var m = isNew ? {} : (state.matMap[code] || {});
    $('#mat-edit-title').textContent = isNew ? '新增物料' : ('编辑物料 · ' + code);
    MAT_FIELDS.forEach(function (f) {
      var el = meEl(f);
      if (el) el.value = m[f] == null ? '' : m[f];
    });
    var codeEl = meEl('物料编码');
    codeEl.readOnly = !isNew;
    codeEl.classList.toggle('ro-input', !isNew);
    $('#mat-edit-save').onclick = function () { saveMatEditor(isNew ? '' : code); };
    $('#mat-edit-mask').hidden = false;
  }
  function closeMatEditor() { $('#mat-edit-mask').hidden = true; }

  function saveMatEditor(origCode) {
    var o = {};
    MAT_FIELDS.forEach(function (f) { var el = meEl(f); if (el) o[f] = el.value.trim(); });
    if (!o.物料编码) { toast('物料编码不能为空', 'err'); return; }
    var isNew = !origCode;
    if (isNew && state.matMap[o.物料编码]) { toast('该编码已存在', 'err'); return; }
    var old = isNew
      ? { 工艺组: '', 工艺路线: '', 包装单位: '', 单位换算比: '', 状态: '启用', 备注: '' }
      : (state.matMap[origCode] || {});
    var rec = Object.assign({}, old, o);
    DB.put('material', rec).then(function () {
      return DB.log({ 操作类型: isNew ? '物料新增' : '物料编辑', 详情: { 物料编码: rec.物料编码 } });
    }).then(function () {
      closeMatEditor();
      afterChange();
      toast((isNew ? '已新增 ' : '已保存 ') + rec.物料编码, 'ok');
    }).catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  function initMaterial() {
    $('#btn-mat-add').addEventListener('click', function () { openMatEditor(null); });
    $('#mat-edit-close').addEventListener('click', closeMatEditor);
    $('#mat-edit-cancel').addEventListener('click', closeMatEditor);
    $('#mat-edit-mask').addEventListener('click', function (e) { if (e.target === this) closeMatEditor(); });
    $('#mat-search').addEventListener('input', renderMaterial);
    /* 库存属性快速筛选（分段按钮） */
    var seg = $('#mat-attr-filter');
    if (seg) {
      $all('button', seg).forEach(function (b) {
        b.addEventListener('click', function () {
          matAttrFilter = b.getAttribute('data-v') || '';
          $all('button', seg).forEach(function (x) { x.classList.toggle('active', x === b); });
          renderMaterial();
        });
      });
    }
  }

  /* ================================================================
   * 视图：备份与审计
   * ================================================================ */
  function renderOpLog() {
    var list = state.logs.slice().sort(function (a, b) { return String(b.时间).localeCompare(String(a.时间)); }).slice(0, 80);
    var tb = $('#op-log-table tbody');
    tb.innerHTML = list.length ? list.map(function (l) {
      return '<tr><td style="white-space:nowrap">' + esc(l.时间) + '</td><td>' + esc(l.批次号) + '</td><td>' + esc(l.操作类型) + '</td>'
        + '<td style="color:#64748b">' + esc(l.来源文件 || '') + ' ' + esc(l.详情) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">暂无日志</td></tr>';
  }

  function initBackup() {
    function doExport() { Backup.exportJSON().then(function () { toast('备份文件已下载', 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); }
    $('#btn-backup-json').addEventListener('click', doExport);
    $('#btn-backup-json2').addEventListener('click', doExport);

    $('#btn-restore-json').addEventListener('click', function () { $('#restore-file').click(); });
    $('#restore-file').addEventListener('change', function () {
      if (!this.files.length) return;
      if (!confirm('恢复将【覆盖】本机当前全部数据，建议先导出备份。确认继续？')) { this.value = ''; return; }
      Backup.restoreJSON(this.files[0]).then(function () {
        toast('恢复完成', 'ok');
        location.reload();
      }).catch(function (e) { toast('恢复失败：' + e.message, 'err'); });
      this.value = '';
    });

    function doXlsx() { Backup.exportStockXLSX().then(function () { toast('Excel 已导出', 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); }
    $('#btn-export-xlsx').addEventListener('click', doXlsx);
    $('#btn-export-xlsx-nav').addEventListener('click', doXlsx);

    $('#btn-clear-log').addEventListener('click', function () {
      if (confirm('确认清空全部审计日志？')) DB.clear('oplog').then(afterChange);
    });

    $('#tpl-finish').addEventListener('click', function () { Backup.downloadFinishTemplate(); });
    $('#tpl-semi').addEventListener('click', function () { Backup.downloadSemiTemplate(); });
    $('#tpl-bo').addEventListener('click', function () { Backup.downloadBackorderTemplate(); });
  }

  /* ================================================================
   * 弹窗 / 导航 / 公共
   * ================================================================ */
  function openModal(title, html) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = html;
    $('#modal-mask').hidden = false;
  }
  function closeModal() { $('#modal-mask').hidden = true; }

  var TITLES = { stock: '库存总览', semi: '半成品管理', backorder: '欠货跟踪', flow: '库存流水及数据对比', import: '数据导入', material: '物料主数据', backup: '备份与审计', replenish: '备货建议', plan: '月度生产规划', semidemand: '半成品需求参考', schedule: '排产分析', capacity: '产能档案' };

  function switchView(v) {
    state.view = v;
    $all('.nav-item').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-view') === v && !a.classList.contains('disabled')); });
    $all('.view').forEach(function (s) { s.classList.toggle('active', s.id === 'view-' + v); });
    $('#page-title').textContent = TITLES[v] || '';
    $('#sidebar').classList.remove('open');
    /* 查看日期仅库存总览需要，其他视图隐藏 */
    var datePicker = $('#current-date');
    if (datePicker && datePicker.closest('.date-picker')) datePicker.closest('.date-picker').style.display = (v === 'stock') ? '' : 'none';
    if (v === 'capacity' && window.CapacityView) CapacityView.render();
    if (v === 'replenish' && window.ReplenishView) ReplenishView.render();
    if (v === 'plan' && window.PlanView) PlanView.render();
    if (v === 'semidemand' && window.SemiDemandView) SemiDemandView.render();
    /* 主视图按需渲染：只有数据变化过（renderedView 无标记）才重建，避免每次切菜单都重绘 */
    if (!renderedView[v]) renderView(v);
  }

  function afterChange() { return reload().then(renderAll); }

  function initNav() {
    $all('.nav-item').forEach(function (a) {
      a.addEventListener('click', function () {
        if (a.classList.contains('disabled')) { toast('该视图为二期功能，一期仅占位', 'warn'); return; }
        switchView(a.getAttribute('data-view'));
      });
    });
    $('#btn-menu').addEventListener('click', function () { $('#sidebar').classList.toggle('open'); });
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal-ok').addEventListener('click', closeModal);
    $('#modal-mask').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  }

  function initFilters() {
    $('#stock-search').addEventListener('input', renderStock);
    $('#current-date').addEventListener('change', renderStock);
    $('#trend-search').addEventListener('input', renderTrend);
    $('#trend-from').addEventListener('change', renderTrend);
    $('#trend-to').addEventListener('change', renderTrend);
    $('#bo-status-filter').addEventListener('change', renderBackorder);
    $('#bo-search').addEventListener('input', renderBackorder);
    /* 流水页筛选：搜索框加 300ms 防抖，避免每次按键都全量重算+重建表格 */
    $('#flow-move-search').addEventListener('input', debounce(renderFlow, 300));
    $('#flow-move-date').addEventListener('change', renderFlow);
    $('#flow-search').addEventListener('input', debounce(renderFlow, 300));
    $('#flow-repl-filter').addEventListener('change', renderFlow);
    /* 流水视图：半成品子页筛选 + 成品/半成品切换 */
    $('#flow-semi-move-search').addEventListener('input', debounce(renderFlow, 300));
    $('#flow-semi-move-date').addEventListener('change', renderFlow);
    $('#flow-semi-search').addEventListener('input', debounce(renderFlow, 300));
    $('#flow-semi-repl-filter').addEventListener('change', renderFlow);
    $all('#view-flow .flow-tabs button').forEach(function (b) {
      b.addEventListener('click', function () { switchFlowTab(b.getAttribute('data-flowtab')); });
    });
  }

  /* ---------------- 启动 ---------------- */
  window.BO_VER = '20261022b';
  function init() {
    $('#import-date').value = todayStr();
    initNav();
    initFilters();
    initDropzone('drop-finish', '成品');
    initDropzone('drop-semi', '半成品');
    initCatalogDropzone('drop-catalog');
    initClearButtons();
    initBOForm();
    initBOBatch();
    initMaterial();
    initSemi();
    initBackup();
    if (window.CapacityView) CapacityView.init();
    if (window.ReplenishView) ReplenishView.init();
    if (window.PlanView) PlanView.init();
    if (window.SemiDemandView) SemiDemandView.init();

    seedCatalog().then(function (seeded) {
      return reload().then(function () {
        // 查看日期下拉默认定位到最新成品快照（由 renderStock.syncDateSelect 处理）
        renderAll();
        if (seeded) toast('已按内置产品清单初始化 ' + seeded.count + ' 个产品的系列/子分类档案', 'ok');
      });
    });

    // 长时间离开页面再回来时才重新读取数据（防多标签数据陈旧）；
    // 不再监听 window focus —— 每次切换窗口都全量读写会让日志/快照累积后卡死。
    var hiddenAt = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 60000) { hiddenAt = 0; reload().then(renderAll); }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
