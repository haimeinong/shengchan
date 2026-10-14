/* ============================================================
 * backup.js — JSON 全量备份/恢复、库存 Excel 导出、导入模板下载
 * ============================================================ */
(function (global) {
  'use strict';

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  function downloadBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- JSON 全量备份 ---------- */
  function exportJSON() {
    return DB.dumpAll().then(function (data) {
      var payload = {
        app: '库存现货与产能看板',
        phase: 1,
        exportedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        tables: data
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      downloadBlob(blob, '看板全部数据备份_' + stamp() + '.json');
    });
  }

  /* ---------- JSON 恢复（整库覆盖） ---------- */
  function restoreJSON(file) {
    return file.text().then(function (text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('备份文件不是有效的 JSON'); }
      var tables = data.tables || data;
      var validNames = Object.keys(DB.STORES).map(function (k) { return DB.STORES[k].name; });
      var matched = validNames.filter(function (n) { return Array.isArray(tables[n]); });
      if (matched.length === 0) throw new Error('备份文件中未找到本系统的数据表');
      return DB.restoreAll(tables).then(function () {
        return DB.log({ 操作类型: '备份恢复', 来源文件: file.name, 详情: { 恢复表数: matched.length, 备份时间: data.exportedAt || '' } });
      }).then(function () { return matched.length; });
    });
  }

  /* ---------- 当前库存导出 Excel（回群流转） ---------- */
  var STOCK_COLS = ['库存类型', '产品系列', '子分类(包装形态)', '产品编码', '产品名称', '规格型号', '箱规',
    '产品形态', '月初库存', '累计入库数量', '累计出库数量', '库存数量', '当日入库', '当日出库', '主单位', '日期(快照)'];

  function latestStockRows(stockAll, matMap) {
    // 各库存类型取各自最新日期的快照
    var latestDate = {};
    stockAll.forEach(function (s) {
      if (!latestDate[s.库存类型] || s.日期 > latestDate[s.库存类型]) latestDate[s.库存类型] = s.日期;
    });
    return stockAll.filter(function (s) { return s.日期 === latestDate[s.库存类型]; }).map(function (s) {
      var m = matMap[s.物料编码] || {};
      return {
        库存类型: s.库存类型,
        产品系列: m.产品系列 || '',
        '子分类(包装形态)': m['子分类(包装形态)'] || '',
        产品编码: s.物料编码,
        产品名称: m.物料名称 || '',
        规格型号: m.规格型号 || '',
        箱规: m.箱规 || '',
        产品形态: m.产品形态 || '',
        月初库存: s.初期库存 == null ? '' : s.初期库存,
        累计入库数量: s.入库数量 || 0,
        累计出库数量: s.出库数量 || 0,
        库存数量: s.数量,
        当日入库: s.当日入库 == null ? '' : s.当日入库,
        当日出库: s.当日出库 == null ? '' : s.当日出库,
        主单位: m.主单位 || '',
        '日期(快照)': s.日期
      };
    }).sort(function (a, b) {
      return (a.库存类型 + a.产品系列 + a.产品编码).localeCompare(b.库存类型 + b.产品系列 + b.产品编码);
    });
  }

  function exportStockXLSX() {
    return Promise.all([DB.all('stock'), DB.all('material')]).then(function (r) {
      var matMap = {};
      r[1].forEach(function (m) { matMap[m.物料编码] = m; });
      var rows = latestStockRows(r[0], matMap);
      if (rows.length === 0) throw new Error('暂无库存快照可导出');
      var ws = XLSX.utils.json_to_sheet(rows, { header: STOCK_COLS });
      ws['!cols'] = STOCK_COLS.map(function (c) { return { wch: c === '产品名称' ? 22 : c === '规格型号' || c === '子分类(包装形态)' ? 16 : 11 }; });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '当前库存');
      XLSX.writeFile(wb, '当前库存_' + stamp() + '.xlsx');
    });
  }

  /* ---------- 导入模板（对齐每日清洗报表） ---------- */
  function downloadFinishTemplate() {
    var headers = ['产品编码', '产品名称', '规格型号', '初期库存', '入库数量', '出库数量', '库存数量', '补货计划'];
    var sample = [
      ['6926502310826', '十里八香香辛料', '1x40gx10x10', 14, 0, 0, 14, ''],
      ['6926502318372', '白胡椒粉', '1x30gx40', 52, 10, 5, 57, '']
    ];
    var ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
    ws['!cols'] = [{ wch: 16 }, { wch: 22 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '成品导入');
    XLSX.writeFile(wb, '成品库存报表模板.xlsx');
  }

  function downloadSemiTemplate() {
    var headers = ['产品编码', '产品名称', '主计量单位', '规格型号', '初期库存', '入库数量', '出库数量', '库存数量', '补货计划'];
    var sample = [
      ['300001', '经典麻辣鲜（半成品）', '公斤', '', 274, 0, 0, 274, ''],
      ['300003', '咖喱粉（半成品）', '公斤', '', 5, 195, 0, 200, '']
    ];
    var ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
    ws['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '半成品导入');
    XLSX.writeFile(wb, '半成品库存报表模板.xlsx');
  }

  function downloadBackorderTemplate() {
    var headers = ['产品编码', '欠货数量(箱)', '需求日期', '订单号', '行号', '客户', '已发数量'];
    var sample = [
      ['6926502310826', 50, '2026-10-10', 'SO-20261007-01', 1, '示例客户A', 0],
      ['6926502316972', 30, '2026-10-12', 'SO-20261007-02', 1, '示例客户B', 10]
    ];
    var ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
    ws['!cols'] = headers.map(function () { return { wch: 16 }; });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '销售欠货');
    XLSX.writeFile(wb, '销售欠货模板(备用).xlsx');
  }

  /* ---------- 半成品 ↔ 成品 对应关系：导出 / 模板 ---------- */
  var BOM_COLS = ['半成品编码', '半成品名称', '成品编码', '成品名称', '单耗(公斤/箱)', '确认状态', '匹配度', '来源', '更新时间'];

  function exportBomLinks() {
    return Promise.all([DB.all('bom'), DB.all('material')]).then(function (r) {
      var links = r[0], mats = r[1];
      var mm = {};
      mats.forEach(function (m) { mm[m.物料编码] = m; });
      if (links.length === 0) throw new Error('暂无半成品↔成品对应关系可导出');
      var rows = links.slice().sort(function (a, b) {
        return a.半成品编码.localeCompare(b.半成品编码) || a.成品编码.localeCompare(b.成品编码);
      }).map(function (l) {
        return {
          半成品编码: l.半成品编码,
          半成品名称: (mm[l.半成品编码] || {}).物料名称 || '',
          成品编码: l.成品编码,
          成品名称: (mm[l.成品编码] || {}).物料名称 || '',
          '单耗(公斤/箱)': l.单耗 == null ? '' : l.单耗,
          确认状态: l.状态 || '待确认',
          匹配度: l.匹配度 == null ? '' : l.匹配度 + '%',
          来源: l.来源 || '',
          更新时间: l.更新时间 || ''
        };
      });
      var ws = XLSX.utils.json_to_sheet(rows, { header: BOM_COLS });
      ws['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 16 }, { wch: 26 }, { wch: 13 }, { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 20 }];
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '半成品成品对应关系');
      XLSX.writeFile(wb, '半成品成品对应关系_' + stamp() + '.xlsx');
    });
  }

  function downloadBomTemplate() {
    var headers = ['半成品编码', '半成品名称', '成品编码', '成品名称', '单耗(公斤/箱)', '确认状态'];
    var sample = [
      ['300006', '乐家客孜然粉（半成品）', '6926502317665', '孜然粉', 12.5, '已确认'],
      ['300008', '辣椒粉（半成品）', '6926502300230', '辣椒粉调味料', 10, '待确认']
    ];
    var ws = XLSX.utils.aoa_to_sheet([headers].concat(sample));
    ws['!cols'] = [{ wch: 12 }, { wch: 24 }, { wch: 16 }, { wch: 22 }, { wch: 13 }, { wch: 10 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '对应关系导入');
    XLSX.writeFile(wb, '半成品成品对应关系模板.xlsx');
  }

  global.Backup = {
    exportJSON: exportJSON,
    restoreJSON: restoreJSON,
    exportStockXLSX: exportStockXLSX,
    downloadFinishTemplate: downloadFinishTemplate,
    downloadSemiTemplate: downloadSemiTemplate,
    downloadBackorderTemplate: downloadBackorderTemplate,
    exportBomLinks: exportBomLinks,
    downloadBomTemplate: downloadBomTemplate
  };
})(window);
