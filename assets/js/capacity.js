/* ============================================================
 * capacity.js — 二期：产能档案
 *   1. 工段线体档案（dim_worksection CRUD）
 *   2. 产能矩阵（dim_capacity：行=产品形态 列=工段，双击单元格编辑）
 *   3. 每日实际产出（fact_output_daily 录入/删除）
 * 复用一期 DB API（DB.all/get/put/del/deleteWhere/log）
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------------- 本地辅助（app.js 未暴露，自包含） ---------------- */
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
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ---------------- 生产线档案（5 条产线，按产品形态划分） ---------------- */
  var PRODUCTION_LINES = [
    { code: 'L01', name: '整粒香辛料分装线', seq: '①' },
    { code: 'L02', name: '粉碎与固态复合线', seq: '②' },
    { code: 'L03', name: '半固态（炒制/调配）线', seq: '③' },
    { code: 'L04', name: '液态调味料线', seq: '④' },
    { code: 'L05', name: '分装线', seq: '⑤' }
  ];

  function lineNameByCode(code) {
    var f = PRODUCTION_LINES.find(function (l) { return l.code === code; });
    return f ? (f.seq + ' ' + f.name) : '';
  }

  /* 产品形态 → 生产线映射（可扩展：新增形态对应其他产线时在此补充）
   * 粉料/块料 → ②粉碎与固态复合线；酱料 → ③半固态（炒制/调配）线；原始香辛料 → ①整粒香辛料分装线 */
  var FORM_LINE_MAP = {
    '原始香辛料': 'L01',
    '粉料': 'L02',
    '块料': 'L02',
    '酱料': 'L03'
  };
  function lineByFormBase(form) { return FORM_LINE_MAP[String(form || '').trim()] || ''; }

  /* ---------------- 内部状态 ---------------- */
  var state = { worksections: [], capacities: [], outputs: [], materials: [], forms: [], formBase: {}, filterText: '', currentLine: '' };

  function loadAll() {
    return Promise.all([DB.all('worksection'), DB.all('capacity'), DB.all('output'), DB.all('material')])
      .then(function (r) {
        state.worksections = r[0] || [];
        state.capacities = r[1] || [];
        state.outputs = (r[2] || []).slice().sort(function (a, b) {
          if (a.日期 !== b.日期) return a.日期 < b.日期 ? 1 : -1;
          return (b.id || 0) - (a.id || 0);
        });
        state.materials = r[3] || [];
        /* 矩阵行 = 工艺形态（产品形态-包装形式，如 粉料-玻璃瓶装；未填包装形式则仅产品形态） */
        var formSet = {};
        state.materials.forEach(function (m) {
          var base = String(m.产品形态 || '').trim();
          if (!base) return;
          var pack = String(m.包装形式 || '').trim();
          var combo = pack ? (base + '-' + pack) : base;
          formSet[combo] = base;
        });
        state.formBase = formSet;
        state.forms = Object.keys(formSet).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
      });
  }

  function findCapacity(form, secNo) {
    return state.capacities.find(function (c) { return c.产品形态 === form && c.工段编号 === secNo; });
  }

  /* ============================================================
   * 1. 工段线体档案
   * ============================================================ */
  function renderWsTable() {
    var tb = $('#cap-ws-table tbody'); if (!tb) return;
    if (!state.worksections.length) {
      tb.innerHTML = '<tr><td colspan="8" class="empty">暂无工段，点上方"+ 新增工段"开始</td></tr>';
      return;
    }
    var sorted = state.worksections.slice().sort(function (a, b) {
      return (a.工段编号 || '').localeCompare(b.工段编号 || '');
    });
    tb.innerHTML = sorted.map(function (w) {
      return '<tr data-code="' + esc(w.工段编号) + '">'
        + '<td class="code">' + esc(w.工段编号 || '') + '</td>'
        + '<td>' + esc(w.工段名称 || '') + '</td>'
        + '<td>' + esc(lineNameByCode(w.生产线) || esc(w.线体名称 || '') || '') + '</td>'
        + '<td class="num">' + esc(w.工段序号 != null ? w.工段序号 : '') + '</td>'
        + '<td class="route-cell">' + esc(w.工艺路线 || '') + '</td>'
        + '<td>' + esc(w.备注 || '') + '</td>'
        + '<td class="muted">' + esc(w.更新时间 || '') + '</td>'
        + '<td class="op-col">'
        + '<button class="btn btn-sm cap-ws-edit">编辑</button> '
        + '<button class="btn btn-sm btn-danger cap-ws-del">删除</button>'
        + '</td></tr>';
    }).join('');
  }

  function makeSectionCode(lineCode, seq) {
    if (!lineCode || seq === '' || seq == null) return '';
    return lineCode + '-' + String(seq).padStart(2, '0');
  }

  function openWsEditor(existing) {
    var w = existing || {};
    var isEdit = !!(existing && existing.工段编号);   /* 真实有工段编号才算编辑模式 */
    var lineOpts = PRODUCTION_LINES.map(function (l) {
      return '<option value="' + l.code + '">' + l.seq + ' ' + esc(l.name) + ' (' + l.code + ')</option>';
    }).join('');
    var html = '<div class="inline-form">'
      + '<label>生产线* <select id="cap-ws-line">' + (isEdit ? '' : '<option value="">—请选择—</option>') + lineOpts + '</select></label>'
      + '<label>工段序号* <input type="number" min="1" step="1" id="cap-ws-seq" placeholder="如 1、2、3" style="width:90px"></label>'
      + '<label>工段编号 <input type="text" id="cap-ws-no" readonly placeholder="自动生成 L01-01" style="background:#f1f5f9"></label>'
      + '<label>工段名称* <input type="text" id="cap-ws-name" maxlength="40" placeholder="如 粉碎工段 / 包装工段"></label>'
      + '<label>工艺路线 <input type="text" id="cap-ws-route" maxlength="120" placeholder="如 原料→粉碎→混合→半成品入库"></label>'
      + '<label>备注 <input type="text" id="cap-ws-remark" maxlength="80"></label>'
      + '<div class="inline-form-actions">'
      + '<button class="btn btn-primary btn-sm" id="cap-ws-save">保存</button> '
      + '<button class="btn btn-sm" id="cap-ws-cancel">取消</button>'
      + '</div></div>';
    var box = $('#cap-ws-editor');
    box.innerHTML = html;
    box.hidden = false;
    if (isEdit) {
      $('#cap-ws-line').value = w.生产线 || '';
      $('#cap-ws-seq').value = w.工段序号 != null ? w.工段序号 : '';
      $('#cap-ws-no').value = w.工段编号 || '';
      $('#cap-ws-name').value = w.工段名称 || '';
      $('#cap-ws-route').value = w.工艺路线 || '';
      $('#cap-ws-remark').value = w.备注 || '';
      $('#cap-ws-line').disabled = true;
      $('#cap-ws-seq').disabled = true;
    }
    var noInput = $('#cap-ws-no');
    var seqInput = $('#cap-ws-seq');
    var lineSel = $('#cap-ws-line');
    function syncNo() {
      noInput.value = makeSectionCode(lineSel.value, seqInput.value);
    }
    lineSel.addEventListener('change', syncNo);
    seqInput.addEventListener('input', syncNo);
    $('#cap-ws-save').onclick = function () { saveWs(w); };
    $('#cap-ws-cancel').onclick = function () { box.hidden = true; box.innerHTML = ''; };
  }

  function saveWs(existing) {
    var isEdit = !!(existing && existing.工段编号);   /* 空对象不算编辑，避免工段编号被清空 */
    var lineCode = $('#cap-ws-line').value;
    var seqRaw = $('#cap-ws-seq').value.trim();
    var seq = seqRaw === '' ? null : parseInt(seqRaw, 10);
    var no = isEdit ? existing.工段编号 : makeSectionCode(lineCode, seq);
    var name = $('#cap-ws-name').value.trim();
    if (!isEdit) {
      if (!lineCode) { toast('请选择生产线', 'err'); return; }
      if (seq == null || isNaN(seq) || seq < 1) { toast('工段序号需为不小于 1 的整数', 'err'); return; }
      if (!no) { toast('工段编号生成失败，请检查生产线和序号', 'err'); return; }
    }
    if (!name) { toast('工段名称必填', 'err'); return; }
    var row = {
      工段编号: no,
      工段名称: name,
      生产线: lineCode,
      工段序号: seq,
      线体名称: lineNameByCode(lineCode),
      工艺路线: $('#cap-ws-route').value.trim(),
      备注: $('#cap-ws-remark').value.trim(),
      更新时间: nowStr()
    };
    if (!isEdit) {
      if (state.worksections.some(function (x) { return x.工段编号 === no; })) { toast('工段编号已存在：' + no + '（同生产线同序号不可重复）', 'err'); return; }
    }
    DB.put('worksection', row).then(function () {
      return DB.log({ 操作类型: isEdit ? '工段档案修改' : '工段档案新增', 详情: { 工段编号: no, 工段名称: name } });
    }).then(function () {
      toast('工段已保存：' + no, 'ok');
      $('#cap-ws-editor').hidden = true; $('#cap-ws-editor').innerHTML = '';
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  function delWs(code) {
    if (!confirm('确认删除工段 "' + code + '"？\n关联的产能矩阵单元格也将一并清除。')) return;
    DB.del('worksection', code).then(function () {
      return DB.deleteWhere('capacity', function (c) { return c.工段编号 === code; });
    }).then(function () {
      return DB.log({ 操作类型: '工段档案删除', 详情: { 工段编号: code } });
    }).then(function () {
      toast('工段已删除：' + code, 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('删除失败：' + (e.message || e), 'err'); });
  }

  /* ============================================================
   * 2. 产能矩阵（行=产品形态 列=工段，单元格显示借鉴值/实测值）
   * ============================================================ */
  function renderMatrix() {
    var tbl = $('#cap-matrix-table'); if (!tbl) return;
    var thead = tbl.querySelector('thead tr'); var tb = tbl.querySelector('tbody');
    // 按所选生产线过滤工段；同生产线按工段序号升序
    var secs = state.worksections.filter(function (w) {
      return !state.currentLine || w.生产线 === state.currentLine;
    }).sort(function (a, b) {
      var la = a.生产线 || '', lb = b.生产线 || '';
      if (la !== lb) return la.localeCompare(lb);
      return (a.工段序号 || 0) - (b.工段序号 || 0);
    });
    var forms = state.forms.filter(function (f) {
      if (state.filterText && (f || '').toLowerCase().indexOf(state.filterText) < 0) return false;
      /* 按所选生产线过滤行：粉料/块料→② 酱料→③ 原始香辛料→①（未映射形态仅在"全部生产线"显示） */
      if (state.currentLine) return lineByFormBase(state.formBase[f]) === state.currentLine;
      return true;
    });

    var headHtml = '<th class="sticky-col">工艺形态<div class="th-sub">产品形态-包装形式</div></th>';
    if (secs.length) {
      secs.forEach(function (s) {
        headHtml += '<th>' + esc(s.工段编号 || '') + '<div class="th-sub">' + esc(s.工段名称 || '') + '</div></th>';
      });
    } else {
      headHtml += '<th>（请先维护工段）</th>';
    }
    thead.innerHTML = headHtml;

    if (!forms.length) {
      tb.innerHTML = '<tr><td colspan="' + (secs.length + 1) + '" class="empty">'
        + (state.materials.length
          ? (state.currentLine
            ? '该生产线暂无对应的产品形态（映射：原始香辛料→① 粉料/块料→② 酱料→③，可先选"全部生产线"查看）'
            : '暂无产品形态（物料主数据未填 产品形态 字段）')
          : '暂无物料主数据，请先在"物料主数据"或"数据导入"中维护')
        + '</td></tr>';
      return;
    }
    if (!secs.length) {
      tb.innerHTML = '<tr><td colspan="2" class="empty">' + (state.currentLine ? '所选生产线下暂无工段，请先在上方新增' : '请先在上方"工段线体档案"维护工段') + '</td></tr>';
      return;
    }

    tb.innerHTML = forms.map(function (f) {
      var lc = lineByFormBase(state.formBase[f]);
      var lineTag = lc
        ? '<span class="tag tag-blue">' + esc(lineNameByCode(lc)) + '</span>'
        : '<span class="tag tag-gray">未映射产线</span>';
      var rowHtml = '<tr><td class="sticky-col"><div class="form-name">' + esc(f) + '</div>' + lineTag + '</td>';
      secs.forEach(function (s) {
        var cap = findCapacity(f, s.工段编号);
        var refV = cap && cap.借鉴值 != null && cap.借鉴值 !== '' ? esc(cap.借鉴值) : '—';
        var actV = cap && cap.实测值 != null && cap.实测值 !== '' ? esc(cap.实测值) : '—';
        // 副行摘要：领料 / 调试换线清场 / 设备
        var meta = [];
        if (cap && cap.领料时间 != null) meta.push('领料 ' + cap.领料时间 + 'm');
        if (cap && cap.调试换线清场时间 != null) meta.push('换线清场 ' + cap.调试换线清场时间 + 'm');
        if (cap && cap.设备类型) meta.push(esc(cap.设备类型));
        var metaHtml = meta.length ? '<div class="cap-meta">' + meta.join(' · ') + '</div>' : '';
        rowHtml += '<td class="matrix-cell' + (cap ? ' matrix-cell-editable' : ' matrix-cell-empty') + '" '
          + 'data-form="' + esc(f) + '" data-section="' + esc(s.工段编号) + '" title="双击编辑">'
          + '<div class="cap-ref">借鉴 ' + refV + '</div>'
          + '<div class="cap-act">实测 ' + actV + '</div>'
          + metaHtml
          + '</td>';
      });
      return rowHtml + '</tr>';
    }).join('');

    $all('.matrix-cell', tb).forEach(function (cell) {
      cell.addEventListener('dblclick', function () { openCellEditor(cell); });
    });
  }

  function openCellEditor(cell) {
    var form = cell.getAttribute('data-form');
    var sec = cell.getAttribute('data-section');
    var cap = findCapacity(form, sec) || {};
    var curRef = cap.借鉴值 == null ? '' : cap.借鉴值;
    var curAct = cap.实测值 == null ? '' : cap.实测值;
    var curPick = cap.领料时间 == null ? '' : cap.领料时间;
    var curChangeover = cap.调试换线清场时间 == null ? '' : cap.调试换线清场时间;
    var curDevice = cap.设备类型 || '';
    var curRemark = cap.备注 || '';
    cell.innerHTML = '<div class="cell-edit-form">'
      + '<label>借鉴值（每小时产量，可带单位） <input type="text" class="cell-ref" value="' + esc(curRef) + '" maxlength="30" placeholder="如 50箱/h 或 100kg/h"></label>'
      + '<label>实测值（每小时产量，可带单位） <input type="text" class="cell-act" value="' + esc(curAct) + '" maxlength="30" placeholder="如 48箱/h"></label>'
      + '<label>领料时间(分钟) <input type="number" min="0" step="1" class="cell-pick" value="' + curPick + '"></label>'
      + '<label>调试换线/清场时间(分钟) <input type="number" min="0" step="1" class="cell-changeover" value="' + curChangeover + '"></label>'
      + '<label>设备类型 <input type="text" class="cell-device" value="' + esc(curDevice) + '" maxlength="40" placeholder="如 机器包装 / 人工包装"></label>'
      + '<label>备注 <input type="text" class="cell-remark" value="' + esc(curRemark) + '" maxlength="40"></label>'
      + '<div class="cell-edit-actions">'
      + '<button class="btn btn-primary btn-sm cell-save">保存</button> '
      + '<button class="btn btn-sm cell-cancel">取消</button>'
      + (cap.id != null ? '<button class="btn btn-sm btn-danger cell-clear">清空</button>' : '')
      + '</div></div>';
    $('.cell-save', cell).onclick = function () { saveCell(form, sec, cap, cell); };
    $('.cell-cancel', cell).onclick = function () { renderMatrix(); };
    var clr = $('.cell-clear', cell);
    if (clr) clr.onclick = function () {
      if (!confirm('清空此单元格的产能数据？')) return;
      DB.del('capacity', cap.id).then(function () {
        return DB.log({ 操作类型: '产能矩阵清空', 详情: { 产品形态: form, 工段编号: sec } });
      }).then(function () { toast('已清空', 'ok'); return loadAll().then(renderAll); });
    };
  }

  function saveCell(form, sec, cap, cell) {
    var refV = $('.cell-ref', cell).value.trim();
    var actV = $('.cell-act', cell).value.trim();
    var pickV = $('.cell-pick', cell).value.trim();
    var changeoverV = $('.cell-changeover', cell).value.trim();
    var deviceV = $('.cell-device', cell).value.trim();
    var remV = $('.cell-remark', cell).value.trim();
    if (refV === '' && actV === '' && pickV === '' && changeoverV === '' && deviceV === '' && remV === '') {
      if (cap.id != null) {
        DB.del('capacity', cap.id).then(function () { return loadAll().then(renderAll); });
      } else { renderMatrix(); }
      return;
    }
    if (pickV !== '' && (isNaN(+pickV) || +pickV < 0)) { toast('领料时间需为不小于 0 的数字', 'err'); return; }
    if (changeoverV !== '' && (isNaN(+changeoverV) || +changeoverV < 0)) { toast('调试换线/清场时间需为不小于 0 的数字', 'err'); return; }
    var row = {
      产品形态: form, 工段编号: sec,
      借鉴值: refV,
      实测值: actV,
      领料时间: pickV === '' ? null : +pickV,
      调试换线清场时间: changeoverV === '' ? null : +changeoverV,
      设备类型: deviceV,
      启用日期: cap.启用日期 || todayStr(),
      备注: remV, 更新时间: nowStr()
    };
    if (cap.id != null) row.id = cap.id;
    DB.put('capacity', row).then(function () {
      return DB.log({ 操作类型: '产能矩阵编辑', 详情: { 产品形态: form, 工段编号: sec, 借鉴: row.借鉴值, 实测: row.实测值 } });
    }).then(function () {
      toast('产能已保存：' + form + ' / ' + sec, 'ok');
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  /* ============================================================
   * 3. 每日实际产出
   * ============================================================ */
  function renderOutTable() {
    var tb = $('#cap-out-table tbody'); if (!tb) return;
    if (!state.outputs.length) {
      tb.innerHTML = '<tr><td colspan="9" class="empty">暂无产出记录，点上方"+ 录入产出"开始</td></tr>';
      return;
    }
    var list = state.outputs.slice(0, 200);
    tb.innerHTML = list.map(function (o) {
      var ws = state.worksections.find(function (w) { return w.工段编号 === o.工段编号; });
      return '<tr data-id="' + (o.id != null ? o.id : '') + '">'
        + '<td>' + esc(o.日期 || '') + '</td>'
        + '<td>' + esc(o.工段编号 || '') + (ws ? ' / ' + esc(ws.工段名称 || '') : '') + '</td>'
        + '<td>' + esc(o.产品形态 || '') + '</td>'
        + '<td>' + esc(o.物料编码 || '—') + '</td>'
        + '<td class="num">' + fmtNum(o.产出数量) + '</td>'
        + '<td class="num">' + fmtNum(o.生产时间) + '</td>'
        + '<td class="num">' + fmtNum(o.换产清洗次数) + '</td>'
        + '<td>' + esc(o.备注 || '') + '</td>'
        + '<td class="op-col"><button class="btn btn-sm btn-danger cap-out-del">删除</button></td>'
        + '</tr>';
    }).join('');
  }

  function openOutEditor() {
    if (!state.worksections.length) { toast('请先在上方维护工段档案', 'warn'); return; }
    if (!state.forms.length) { toast('物料主数据为空，无法选择产品形态', 'warn'); return; }
    var html = '<div class="inline-form cap-out-form">'
      + '<label>日期* <input type="date" id="cap-out-date" value="' + todayStr() + '"></label>'
      + '<label>工段* <select id="cap-out-section">'
      + state.worksections.map(function (w) { return '<option value="' + esc(w.工段编号) + '">' + esc(w.工段编号) + ' / ' + esc(w.工段名称 || '') + '</option>'; }).join('')
      + '</select></label>'
      + '<label>工艺形态* <select id="cap-out-form">'
      + state.forms.map(function (f) { return '<option value="' + esc(f) + '">' + esc(f) + '</option>'; }).join('')
      + '</select></label>'
      + '<label>物料编码 <input type="text" id="cap-out-code" maxlength="30" placeholder="可选 SKU"></label>'
      + '<label>产出(箱)* <input type="number" min="0" step="1" id="cap-out-qty" value="0"></label>'
      + '<label>生产时间(小时) <input type="number" min="0" step="0.5" id="cap-out-hours" value="8" placeholder="如 8、7.5"></label>'
      + '<label>换产清洗 <input type="number" min="0" step="1" id="cap-out-clean" value="0"></label>'
      + '<label>备注 <input type="text" id="cap-out-remark" maxlength="80"></label>'
      + '<div class="inline-form-actions">'
      + '<button class="btn btn-primary btn-sm" id="cap-out-save">保存</button> '
      + '<button class="btn btn-sm" id="cap-out-cancel">取消</button>'
      + '</div></div>';
    var box = $('#cap-out-editor');
    box.innerHTML = html; box.hidden = false;
    $('#cap-out-save').onclick = saveOut;
    $('#cap-out-cancel').onclick = function () { box.hidden = true; box.innerHTML = ''; };
  }

  function saveOut() {
    var date = $('#cap-out-date').value.trim();
    var sec = $('#cap-out-section').value;
    var form = $('#cap-out-form').value;
    var qty = $('#cap-out-qty').value.trim();
    var hoursV = $('#cap-out-hours').value.trim();
    var cleanV = $('#cap-out-clean').value.trim();
    if (!date) { toast('日期必填', 'err'); return; }
    if (!sec) { toast('工段必选', 'err'); return; }
    if (!form) { toast('产品形态必选', 'err'); return; }
    if (qty === '' || isNaN(+qty) || +qty < 0) { toast('产出数量需为不小于 0 的数字', 'err'); return; }
    if (hoursV !== '' && (isNaN(+hoursV) || +hoursV < 0)) { toast('生产时间需为不小于 0 的数字', 'err'); return; }
    if (cleanV !== '' && (isNaN(+cleanV) || +cleanV < 0)) { toast('换产清洗次数需为不小于 0 的数字', 'err'); return; }
    var row = {
      日期: date, 工段编号: sec, 产品形态: form,
      物料编码: $('#cap-out-code').value.trim() || '',
      产出数量: +qty,
      生产时间: hoursV === '' ? null : +hoursV,
      换产清洗次数: cleanV === '' ? null : +cleanV,
      备注: $('#cap-out-remark').value.trim()
    };
    DB.put('output', row).then(function () {
      return DB.log({ 操作类型: '每日产出录入', 详情: row });
    }).then(function () {
      toast('产出已保存', 'ok');
      $('#cap-out-editor').hidden = true; $('#cap-out-editor').innerHTML = '';
      return loadAll().then(renderAll);
    }).catch(function (e) { toast('保存失败：' + (e.message || e), 'err'); });
  }

  function delOut(id) {
    if (!confirm('确认删除这条产出记录？')) return;
    DB.del('output', id).then(function () {
      return DB.log({ 操作类型: '每日产出删除', 详情: { id: id } });
    }).then(function () { toast('已删除', 'ok'); return loadAll().then(renderAll); })
      .catch(function (e) { toast('删除失败：' + (e.message || e), 'err'); });
  }

  /* ============================================================
   * 总入口
   * ============================================================ */
  function renderAll() { renderWsTable(); renderMatrix(); renderOutTable(); }

  function render() {
    return loadAll().then(renderAll).catch(function (e) { toast('加载失败：' + (e.message || e), 'err'); });
  }

  function init() {
    var root = document.getElementById('view-capacity');
    if (!root) return;
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (t.closest('#cap-ws-add')) { openWsEditor(null); return; }
      if (t.closest('#cap-out-add')) { openOutEditor(); return; }
      var editBtn = t.closest('.cap-ws-edit');
      if (editBtn) {
        var code = editBtn.closest('tr').getAttribute('data-code');
        var w = state.worksections.find(function (x) { return x.工段编号 === code; });
        if (w) openWsEditor(w);
        return;
      }
      var delWsBtn = t.closest('.cap-ws-del');
      if (delWsBtn) { delWs(delWsBtn.closest('tr').getAttribute('data-code')); return; }
      var delOutBtn = t.closest('.cap-out-del');
      if (delOutBtn) { delOut(+delOutBtn.closest('tr').getAttribute('data-id')); return; }
    });
    var search = $('#cap-form-search');
    if (search) {
      search.addEventListener('input', function () {
        state.filterText = (search.value || '').toLowerCase();
        renderMatrix();
      });
    }
    var lineSel = $('#cap-line-filter');
    if (lineSel) {
      // 填充产线选项
      lineSel.innerHTML = '<option value="">全部生产线</option>' + PRODUCTION_LINES.map(function (l) {
        return '<option value="' + l.code + '">' + l.seq + ' ' + esc(l.name) + '</option>';
      }).join('');
      lineSel.addEventListener('change', function () {
        state.currentLine = lineSel.value;
        renderMatrix();
      });
    }
  }

  global.CapacityView = {
    render: render,
    init: init,
    getState: function () { return state; },
    reload: function () { return loadAll(); }
  };
})(window);
