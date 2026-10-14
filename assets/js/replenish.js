/* ============================================================
 * replenish.js — 二期：备货建议
 * 算法：近 N 天出库总量/N = 日均消耗 → 可用天数 = 当前库存/日均消耗
 *       目标库存 = 日均消耗 × 目标天数(物料主数据"目标库存天数"，未填用全局参数，填 0 = 不参与备货)
 *       缺口 = max(0, 目标库存 - 当前库存)
 *       建议补库量 = 按箱规向上取整
 * 同步策略：手动同步——点「同步到主数据」+ 二次确认后才覆盖物料主数据"计划补货数量"
 * 参数存 mdl_replenish_cfg：consume_window(消耗窗口天数,默认30) / safety_days(默认目标天数,默认7)
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 本地辅助（自包含，风格同 capacity.js） ---------------- */
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

  /* ---------------- 内部状态 ---------------- */
  var state = {
    materials: [],   // 成品物料
    snapshots: [],   // 成品快照
    cfg: { consume_window: 30, safety_days: 7 },
    rows: [],        // 计算结果（供同步与排产复用）
    filterStatus: '', // ''|紧急|预警|充足
    keyword: ''
  };

  /* ---------------- 参数读写 ---------------- */
  function loadCfg() {
    return DB.all('replenish_cfg').then(function (rows) {
      (rows || []).forEach(function (r) {
        var v = +r.值;
        if (r.参数键 === 'consume_window' && v >= 1) state.cfg.consume_window = v;
        if (r.参数键 === 'safety_days' && v >= 1) state.cfg.safety_days = v;
      });
    });
  }

  function saveCfg() {
    var win = parseInt($('#repl-cfg-window').value, 10);
    var days = parseInt($('#repl-cfg-days').value, 10);
    if (!(win >= 1 && win <= 365)) { toast('消耗窗口天数需为 1~365 的整数', 'err'); return; }
    if (!(days >= 1 && days <= 365)) { toast('默认目标库存天数需为 1~365 的整数', 'err'); return; }
    var ts = nowStr();
    Promise.all([
      DB.put('replenish_cfg', { 参数键: 'consume_window', 值: win, 更新时间: ts }),
      DB.put('replenish_cfg', { 参数键: 'safety_days', 值: days, 更新时间: ts }),
      DB.log({ 操作类型: '备货参数修改', 详情: { consume_window: win, safety_days: days } })
    ]).then(function () {
      state.cfg.consume_window = win;
      state.cfg.safety_days = days;
      toast('参数已保存，建议已重新计算', 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  /* ---------------- 数据加载与计算 ---------------- */
  function loadAll() {
    return Promise.all([DB.all('material'), DB.all('stock'), loadCfg()]).then(function (r) {
      state.materials = (r[0] || []).filter(function (m) { return (m.库存属性 || '成品') === '成品'; });
      state.snapshots = (r[1] || []).filter(function (s) { return s.库存类型 === '成品'; });
      compute();
    });
  }

  /* 近 N 天出库总量：快照"出库数量"为当月初至快照日累计，
   * 相邻同月快照做差得日增量；跨月时该月首条快照以累计值本身作为增量（近似）。 */
  function totalOutInWindow(code, anchorDate, days) {
    var start = new Date(anchorDate.getTime() - (days - 1) * 86400000);
    var startStr = start.getFullYear() + '-' + pad2(start.getMonth() + 1) + '-' + pad2(start.getDate());
    var list = state.snapshots.filter(function (s) { return s.物料编码 === code && s.日期 >= startStr; });
    if (!list.length) return 0;
    list.sort(function (a, b) { return a.日期 < b.日期 ? -1 : 1; });
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

  function compute() {
    /* 以最新快照日期为锚点（数据可能滞后于当天）；无快照时用当天 */
    var anchor = '';
    state.snapshots.forEach(function (s) { if (s.日期 > anchor) anchor = s.日期; });
    if (!anchor) {
      var d0 = new Date();
      anchor = d0.getFullYear() + '-' + pad2(d0.getMonth() + 1) + '-' + pad2(d0.getDate());
    }
    var anchorDate = new Date(anchor + 'T00:00:00');
    var N = state.cfg.consume_window;

    state.rows = state.materials.map(function (m) {
      var code = m.物料编码;
      var latest = null;
      state.snapshots.forEach(function (s) {
        if (s.物料编码 === code && (!latest || s.日期 > latest.日期)) latest = s;
      });
      var stock = latest ? (+latest.数量 || 0) : 0;
      var totalOut = totalOutInWindow(code, anchorDate, N);
      var dailyAvg = totalOut / N;
      /* 目标天数：主数据填 0 = 不参与备货；填正数 = 用主数据值；未填 = 用全局默认 */
      var rawDays = String(m.目标库存天数 == null ? '' : m.目标库存天数).trim();
      var excluded = rawDays !== '' && +rawDays === 0;
      var targetDays = excluded ? 0 : ((+rawDays > 0) ? +rawDays : state.cfg.safety_days);
      var availDays = dailyAvg > 0 ? stock / dailyAvg : Infinity;
      var targetStock = dailyAvg * targetDays;
      var gap = excluded ? 0 : Math.max(0, targetStock - stock);
      var box = +m.箱规 > 0 ? +m.箱规 : 1;
      var suggested = gap > 0 ? Math.ceil(gap / box) * box : 0;
      var status = excluded ? '不备货' : (availDays === Infinity ? '充足' : (availDays < 3 ? '紧急' : (availDays < targetDays ? '预警' : '充足')));
      return {
        code: code, name: m.物料名称 || '', series: m.产品系列 || '', sub: m['子分类(包装形态)'] || '',
        stock: stock, dailyAvg: dailyAvg, availDays: availDays, targetDays: targetDays,
        gap: gap, box: box, suggested: suggested, status: status,
        manual: (m.计划补货数量 === '' || m.计划补货数量 == null) ? null : +m.计划补货数量,
        syncTime: m.补货同步时间 || '',
        synced: (m.计划补货数量 != null && m.计划补货数量 !== '' && +m.计划补货数量 === suggested && !!m.补货同步时间)
      };
    }).sort(function (a, b) {
      /* 紧急 > 预警 > 充足 > 不备货；同级按可用天数升序 */
      var rank = { '紧急': 0, '预警': 1, '充足': 2, '不备货': 3 };
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      var av = a.availDays === Infinity ? 1e9 : a.availDays;
      var bv = b.availDays === Infinity ? 1e9 : b.availDays;
      return av - bv;
    });
  }

  /* ---------------- 渲染 ---------------- */
  function renderKpi() {
    var rows = state.rows;
    var need = rows.filter(function (r) { return r.suggested > 0; });
    var urgent = rows.filter(function (r) { return r.status === '紧急'; });
    var totalQty = need.reduce(function (s, r) { return s + r.suggested; }, 0);
    $('#repl-kpi-sku').textContent = rows.length;
    $('#repl-kpi-need').textContent = need.length;
    $('#repl-kpi-qty').textContent = fmtNum(totalQty);
    $('#repl-kpi-urgent').textContent = urgent.length;
  }

  function statusBadge(st) {
    var cls = st === '紧急' ? 'repl-badge urgent' : (st === '预警' ? 'repl-badge warn' : (st === '不备货' ? 'repl-badge off' : 'repl-badge ok'));
    return '<span class="' + cls + '">' + st + '</span>';
  }

  function renderTable() {
    var tb = $('#repl-table tbody'); if (!tb) return;
    var kw = state.keyword.toLowerCase();
    var list = state.rows.filter(function (r) {
      if (state.filterStatus && r.status !== state.filterStatus) return false;
      if (kw && (r.code + ' ' + r.name + ' ' + r.series + ' ' + r.sub).toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="13" class="empty">无符合条件的成品（请先在数据导入中导入成品库存快照）</td></tr>';
      return;
    }
    tb.innerHTML = list.map(function (r) {
      var syncCell = r.synced
        ? '<span class="repl-sync-tag">已同步 ' + esc((r.syncTime || '').slice(5, 16)) + '</span>'
        : (r.suggested > 0 ? '<span class="repl-sync-tag pending">待同步</span>' : '<span class="muted">—</span>');
      return '<tr class="' + (r.status === '紧急' ? 'repl-row-urgent' : '') + '">'
        + '<td class="code">' + esc(r.code) + '</td>'
        + '<td>' + esc(r.name) + '</td>'
        + '<td>' + esc(r.series) + '</td>'
        + '<td class="num' + (r.stock < 0 ? ' neg' : '') + '">' + fmtNum(r.stock) + '</td>'
        + '<td class="num">' + (r.dailyAvg > 0 ? (Math.round(r.dailyAvg * 100) / 100) : '—') + '</td>'
        + '<td class="num">' + (r.availDays === Infinity ? '∞' : (Math.round(r.availDays * 10) / 10)) + '</td>'
        + '<td class="num">' + r.targetDays + '</td>'
        + '<td class="num">' + (r.gap > 0 ? fmtNum(Math.round(r.gap * 100) / 100) : '—') + '</td>'
        + '<td class="num repl-suggested">' + (r.suggested > 0 ? fmtNum(r.suggested) : '—') + '</td>'
        + '<td class="num">' + (r.box > 1 ? r.box : '—') + '</td>'
        + '<td class="num muted">' + (r.manual == null ? '—' : fmtNum(r.manual)) + '</td>'
        + '<td>' + statusBadge(r.status) + '</td>'
        + '<td>' + syncCell + '</td></tr>';
    }).join('');
  }

  function renderCfg() {
    $('#repl-cfg-window').value = state.cfg.consume_window;
    $('#repl-cfg-days').value = state.cfg.safety_days;
  }

  function renderAll() { renderKpi(); renderTable(); renderCfg(); }

  /* ---------------- 同步到主数据（手动 + 二次确认） ---------------- */
  function syncToMaterial() {
    var targets = state.rows.filter(function (r) { return r.suggested > 0 && !r.synced; });
    if (!targets.length) { toast('没有需要同步的建议（建议补库量为 0 或均已同步）', 'warn'); return; }
    if (!confirm('将把 ' + targets.length + ' 个 SKU 的"计划补货数量"覆盖为系统建议值（一期手工录入值会被覆盖）。\n是否继续？')) return;
    var ts = nowStr();
    Promise.all(targets.map(function (r) {
      return DB.get('material', r.code).then(function (m) {
        if (!m) return;
        m.计划补货数量 = r.suggested;
        m.补货同步时间 = ts;
        return DB.put('material', m);
      });
    })).then(function () {
      return DB.log({ 操作类型: '备货建议同步', 详情: { SKU数: targets.length, 编码: targets.map(function (r) { return r.code; }).join(',') } });
    }).then(function () {
      toast('已同步 ' + targets.length + ' 个 SKU 的计划补货数量', 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('同步失败：' + (e.message || e), 'err'); });
  }

  /* ---------------- 初始化与导出 ---------------- */
  function init() {
    var btn;
    btn = $('#repl-cfg-save'); if (btn) btn.addEventListener('click', saveCfg);
    btn = $('#repl-sync'); if (btn) btn.addEventListener('click', syncToMaterial);
    btn = $('#repl-search');
    if (btn) btn.addEventListener('input', function () { state.keyword = btn.value.trim(); renderTable(); });
    $all('.repl-status-filter button').forEach(function (b) {
      b.addEventListener('click', function () {
        $all('.repl-status-filter button').forEach(function (x) { x.classList.toggle('active', x === b); });
        state.filterStatus = b.getAttribute('data-st') || '';
        renderTable();
      });
    });
  }

  global.ReplenishView = {
    init: init,
    render: function () { loadAll().then(renderAll); },
    reload: function () { return loadAll().then(renderAll); },
    /* 供阶段3排产分析复用计算结果 */
    getResult: function () { return state.rows; }
  };
})(window);
