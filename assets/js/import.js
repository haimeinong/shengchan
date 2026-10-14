/* ============================================================
 * import.js — Excel/CSV 解析与导入
 *  · 列名模糊匹配（附录 A 约定）
 *  · 三种模式：upsert 按编码更新 / append 仅追加新编码（已存在跳过） / replace 清除当日后导入
 *  · 校验：必填列、重复行合并、负库存标记
 *  · 每次导入生成批次号 + 审计日志 + 导入报告
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 工具 ---------- */
  function todayStr() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function nowStr() { return new Date().toLocaleString('zh-CN', { hour12: false }); }

  function normHeader(s) {
    return String(s == null ? '' : s)
      .replace(/[\s　\(\)（）\[\]【】\*:：\/\\_\-．\.]/g, '')
      .toLowerCase();
  }

  /** 系统字段 => 可接受的表头别名（附录 A + 每日清洗报表实际列名） */
  var ALIASES = {
    物料编码: ['物料编码', '编码', '物料号', '存货编码', '货品编码', '料号', '产品编码', '商品编码', '条码', '货号'],
    数量: ['数量', '结存', '库存量', '库存数量', '现存数量', '数量结存', '结存数量', '期末库存', '库存数'],
    物料名称: ['名称', '品名', '物料名称', '货品名称', '产品名称'],
    产品系列: ['产品系列', '系列'],
    子分类: ['包装形态', '子分类', '规格描述', '子分类包装形态', '包装方式'],
    规格型号: ['规格', '型号', '规格型号'],
    箱规: ['箱规', '每箱', '装箱数'],
    产品形态: ['形态', '产品形态', '类型'],
    包装形式: ['包装形式', '内包装形式'],
    批次号: ['批次', '批号', '批次号'],
    生产日期: ['生产日期', '生产', '生产日'],
    保质期至: ['保质期', '到期', '保质期至', '到期日', '有效期至'],
    单位: ['单位', '计量单位', '主计量单位'],
    入库数量: ['入库数量', '入库', '入库数', '收入数量', '本期入库', '收入'],
    出库数量: ['出库数量', '出库', '出库数', '发出数量', '本期出库', '发出'],
    初期库存: ['初期库存', '期初库存', '上期结存'],
    补货计划: ['补货计划', '计划补货', '补货量', '建议补货']
  };

  /** 形态简写归一 */
  var FORM_MAP = {
    '粉': '粉料', '粉料': '粉料', '粉状': '粉料',
    '块': '块料', '块料': '块料', '块状': '块料',
    '酱': '酱料', '酱料': '酱料', '酱状': '酱料',
    '香辛料': '原始香辛料', '原始香辛料': '原始香辛料', '香料': '原始香辛料'
  };

  function parseNumber(v) {
    if (typeof v === 'number') return v;
    if (v == null) return NaN;
    var m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  }

  function parseDate(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date && !isNaN(v)) {
      return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
    }
    if (typeof v === 'number' && global.XLSX && XLSX.SSF) {
      var dc = XLSX.SSF.parse_date_code(v);
      if (dc) return dc.y + '-' + String(dc.m).padStart(2, '0') + '-' + String(dc.d).padStart(2, '0');
    }
    var s = String(v).trim();
    var m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    return s;
  }

  /** 由文本判断内包装单位：子分类优先（如"…/橙蝴蝶盖瓶装"→瓶、"…/吸嘴袋装"→袋） */
  function innerUnitFromText(t) {
    var s = String(t || '');
    if (/瓶/.test(s)) return '瓶';
    if (/袋/.test(s)) return '袋';
    if (/罐/.test(s)) return '罐';
    if (/盒/.test(s)) return '盒';
    if (/桶/.test(s)) return '桶';
    if (/支/.test(s)) return '支';
    if (/条/.test(s)) return '条';
    return '';
  }

  /**
   * 由规格型号解析箱规（每箱包数）。
   * 规则：去掉前导"1x"，识别单包净重(如40g)，其后所有数字连乘 = 每箱内装件数。
   * 内包装单位（瓶/袋…）优先取 innerHint（通常来自子分类），其次规格文本，缺省"包"。
   * 示例：1x40gx10x10 -> 100包/箱；1x20gx20x5 + 子分类"…/瓶装" -> 100瓶/箱
   * 返回 {箱规数, 箱规文本, 内包装单位, 单包净重}；无法解析返回 null。
   */
  function parseBoxSpec(spec, innerHint) {
    if (spec == null) return null;
    var body = String(spec).trim().replace(/×/g, 'x').replace(/X/g, 'x');
    if (!body) return null;
    body = body.replace(/^[\s]*1[\s]*x[\s]*/, '');
    var wm = body.match(/(\d+(?:\.\d+)?)\s*(kg|g|克|千克|ml|l|毫升|升)/i);
    if (!wm) return null;
    var after = body.slice(wm.index + wm[0].length);
    var nums = after.match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    var qty = nums.reduce(function (a, b) { return a * parseFloat(b); }, 1);
    if (!qty || qty <= 0) return null;
    var inner = innerUnitFromText(innerHint) || innerUnitFromText(after) || '包';
    return { 箱规数: qty, 箱规文本: qty + inner + '/箱', 内包装单位: inner, 单包净重: wm[0] };
  }

  /** 从文件名提取日期（如 成品库存清洗结果_20261004_210638.xlsx -> 2026-10-04） */
  function pickDateFromName(name) {
    var m = String(name || '').match(/(20\d{2})(\d{2})(\d{2})/);
    return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
  }

  /* ---------- 工作簿解析 ---------- */
  function sheetToRows(wb) {
    var sheet = wb.Sheets[wb.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    return { rows: rows, sheetName: wb.SheetNames[0] };
  }

  function readRows(file) {
    var isCsv = /\.csv$/i.test(file.name || '') || file.type === 'text/csv';
    if (isCsv) {
      // CSV 统一按 UTF-8 文本读取，避免中文表头被错误代码页解析
      return file.text().then(function (text) {
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
        var wb = XLSX.read(text, { type: 'string', cellDates: true });
        return sheetToRows(wb);
      });
    }
    return file.arrayBuffer().then(function (buf) {
      var wb = XLSX.read(buf, { type: 'array', cellDates: true });
      return sheetToRows(wb);
    });
  }

  /** 在前 10 行内定位表头并建立 列序号 -> 系统字段 映射 */
  function locateHeader(rows) {
    var aliasNorm = {};
    Object.keys(ALIASES).forEach(function (f) {
      aliasNorm[f] = ALIASES[f].map(normHeader);
    });
    for (var r = 0; r < Math.min(10, rows.length); r++) {
      var map = {}, hitCode = false, hitQty = false;
      for (var c = 0; c < rows[r].length; c++) {
        var h = normHeader(rows[r][c]);
        if (!h) continue;
        for (var field in aliasNorm) {
          if (map[field] !== undefined) continue;
          if (aliasNorm[field].indexOf(h) >= 0) { map[field] = c; break; }
        }
        if (map.物料编码 === c) hitCode = true;
        if (map.数量 === c) hitQty = true;
      }
      if (hitCode && hitQty) return { headerRow: r, colMap: map };
    }
    return null;
  }

  function cell(row, field, colMap) {
    var i = colMap[field];
    return i === undefined ? '' : (row[i] == null ? '' : row[i]);
  }

  /* ---------- 物料主数据合并建档 ---------- */
  function mergeMaterial(code, rec) {
    return DB.get('material', code).then(function (old) {
      var m = old || {
        物料编码: code, 物料名称: '', 产品系列: '', '子分类(包装形态)': '',
        规格型号: '', 箱规: '', 库存属性: '', 产品形态: '', 包装形式: '', 工艺组: '', 工艺路线: '',
        主单位: '', 包装单位: '', 单位换算比: '', 安全水位: '', 目标库存天数: '',
        状态: '启用', 备注: ''
      };
      ['物料名称', '产品系列'].forEach(function (f) { if (rec[f] !== '' && rec[f] != null) m[f] = String(rec[f]).trim(); });
      if (rec.子分类) m['子分类(包装形态)'] = String(rec.子分类).trim();
      if (rec.产品形态) {
        var form = String(rec.产品形态).trim();
        m.产品形态 = FORM_MAP[form] || FORM_MAP[form.replace(/料$/, '')] || form;
      }
      if (rec.包装形式) m.包装形式 = String(rec.包装形式).trim();

      /* 规格型号 → 自动计算箱规；内包装单位优先由子分类（…/瓶装、…/袋装）判断 */
      if (rec.规格型号) {
        m.规格型号 = String(rec.规格型号).trim();
        var box = parseBoxSpec(rec.规格型号, rec.子分类 || m['子分类(包装形态)']);
        if (box) {
          m.箱规 = box.箱规文本;
          m.单位换算比 = box.箱规数;
          m.包装单位 = box.内包装单位;
          /* 包装形式未填时由内包装单位自动推导（瓶→瓶装），可手工改成 玻璃瓶装 等更细描述 */
          if (!m.包装形式 && m.包装单位) m.包装形式 = m.包装单位 + '装';
        }
      }
      if (rec.箱规 && !m.箱规) m.箱规 = String(rec.箱规).trim();

      /* 主计量单位：成品固定"箱"（发货/入库/库存均以箱）；半成品取报表"主计量单位"列，缺省公斤 */
      if (rec.__stockType === '成品') {
        m.主单位 = '箱';
      } else if (rec.单位) {
        m.主单位 = String(rec.单位).trim();
      } else if (!m.主单位) {
        m.主单位 = '公斤';
      }

      if (!m.库存属性) m.库存属性 = rec.__stockType;
      return DB.put('material', m).then(function () { return m; });
    });
  }

  /* ---------- 库存导入主流程 ---------- */
  function importStock(file, stockType, dateStr, mode) {
    dateStr = dateStr || todayStr();
    var batchNo = DB.newBatchNo('IMP');
    var report = {
      批次号: batchNo, 类型: stockType + '库存导入', 来源文件: file.name, 时间: nowStr(),
      模式: mode, 新增: 0, 更新: 0, 跳过: [], 异常: [], 合并行: 0
    };

    return readRows(file).then(function (parsed) {
      var located = locateHeader(parsed.rows);
      if (!located) {
        var e = new Error('未识别到表头：需同时包含"物料编码"与"数量"列（详见模板列名约定）');
        e.code = 'BAD_HEADER';
        throw e;
      }
      var colMap = located.colMap;

      // 逐行解析 + 文件内按 [编码] 合并（一期不区分批次）
      var merged = {};
      var order = [];
      for (var r = located.headerRow + 1; r < parsed.rows.length; r++) {
        var row = parsed.rows[r];
        if (!row || row.every(function (v) { return v === '' || v == null; })) continue;

        var code = String(cell(row, '物料编码', colMap)).trim();
        var qty = parseNumber(cell(row, '数量', colMap));
        if (!code) { report.跳过.push({ 行号: r + 1, 原因: '物料编码为空' }); continue; }
        if (isNaN(qty)) { report.跳过.push({ 行号: r + 1, 编码: code, 原因: '数量缺失或不是数字' }); continue; }

        var key = code;

        var inQty = parseNumber(cell(row, '入库数量', colMap));
        var outQty = parseNumber(cell(row, '出库数量', colMap));
        var initQty = parseNumber(cell(row, '初期库存', colMap));
        var plan = parseNumber(cell(row, '补货计划', colMap));

        if (merged[key]) {
          merged[key].数量 += qty;
          if (!isNaN(inQty)) merged[key].入库数量 += inQty;
          if (!isNaN(outQty)) merged[key].出库数量 += outQty;
          report.合并行++;
        } else {
          merged[key] = {
            物料编码: code,
            数量: qty,
            入库数量: isNaN(inQty) ? 0 : inQty,
            出库数量: isNaN(outQty) ? 0 : outQty,
            初期库存: isNaN(initQty) ? '' : initQty,
            补货计划: isNaN(plan) ? '' : plan,
            单位: String(cell(row, '单位', colMap)).trim(),
            物料名称: String(cell(row, '物料名称', colMap)).trim(),
            产品系列: String(cell(row, '产品系列', colMap)).trim(),
            子分类: String(cell(row, '子分类', colMap)).trim(),
            规格型号: String(cell(row, '规格型号', colMap)).trim(),
            箱规: String(cell(row, '箱规', colMap)).trim(),
            产品形态: String(cell(row, '产品形态', colMap)).trim(),
            包装形式: String(cell(row, '包装形式', colMap)).trim(),
            __row: r + 1
          };
          order.push(key);
        }
        if (qty < 0) report.异常.push({ 编码: code, 原因: '负库存 ' + qty });
      }

      if (order.length === 0 && report.跳过.length === 0) {
        var e2 = new Error('文件中没有可导入的数据行');
        e2.code = 'EMPTY';
        throw e2;
      }

      /* 口径：日报的入库/出库为"月初至快照日累计"。
         取同物料同年月、日期严格早于本次的最近一条快照，差值即当日实际入/出库。
         月内首次快照无上期可减时，当日量=累计量（自月初起）。 */
      var monthOf = function (d) { return String(d).slice(0, 7); };
      function dailyMove(prev, curIn, curOut) {
        function diff(cur, prevV) {
          var d = Math.round((cur - (prevV || 0)) * 100) / 100;
          return d;
        }
        if (!prev) return { in: curIn, out: curOut, first: true };
        return { in: diff(curIn, prev.入库数量), out: diff(curOut, prev.出库数量), first: false };
      }

      // 一次性载入历史快照用于推算；replace 模式先清当日同类型
      var prep = DB.all('stock');
      if (mode === 'replace') {
        prep = prep.then(function (all) {
          return DB.deleteWhere('stock', function (s) {
            return s.日期 === dateStr && s.库存类型 === stockType;
          }).then(function (n) { report.清除当日 = n; return all; });
        });
      }

      return prep.then(function (historyStocks) {
        /* 同类型历史：编码 -> 同月最近一条（日期 < 本次导入日） */
        var prevMap = {};
        historyStocks.forEach(function (s) {
          if (s.库存类型 !== stockType || s.物料编码 == null) return;
          if (s.日期 >= dateStr || monthOf(s.日期) !== monthOf(dateStr)) return;
          var p = prevMap[s.物料编码];
          if (!p || s.日期 > p.日期) prevMap[s.物料编码] = s;
        });

        var chain = Promise.resolve();

        order.forEach(function (key) {
          var rec = merged[key];
          rec.__stockType = stockType;
          chain = chain.then(function () {
            return mergeMaterial(rec.物料编码, rec).then(function () {
              var idbKey = [dateStr, stockType, rec.物料编码];
              return DB.get('stock', idbKey).then(function (old) {
                var effIn = rec.入库数量, effOut = rec.出库数量, effQty = rec.数量;
                if (mode === 'append' && old) {
                  /* 仅追加新编码：已存在的编码跳过，不更新也不累加 */
                  report.跳过.push({ 行号: 0, 编码: rec.物料编码, 原因: '已存在编码，仅追加新编码模式跳过' });
                  return;
                } else if (old && mode !== 'replace') {
                  report.更新++;
                } else {
                  report.新增++;
                }
                /* 当日实际入/出库：以最终落库累计值减上期快照累计值 */
                var mv = dailyMove(prevMap[rec.物料编码], effIn, effOut);
                if (mv.in < 0) report.异常.push({ 编码: rec.物料编码, 原因: '累计入库小于上一快照，推算当日入库为负(' + mv.in + ')，请核对' });
                if (mv.out < 0) report.异常.push({ 编码: rec.物料编码, 原因: '累计出库小于上一快照，推算当日出库为负(' + mv.out + ')，请核对' });

                var stockRec = {
                  导入批次号: batchNo,
                  日期: dateStr,
                  库存类型: stockType,
                  物料编码: rec.物料编码,
                  数量: effQty,
                  入库数量: effIn,
                  出库数量: effOut,
                  初期库存: rec.初期库存,
                  补货计划: rec.补货计划,
                  当日入库: mv.in,
                  当日出库: mv.out,
                  数据来源: '导入',
                  操作时间: nowStr()
                };
                return DB.put('stock', stockRec);
              });
            });
          });
        });

        return chain.then(function () {
          /* 半成品导入后：为尚无任何对应关系的半成品，按名称模糊匹配生成"待确认"候选。
             已有关系（含待确认）一律不动；确认/锁定后的关系绝不因再导入而变化。 */
          if (stockType !== '半成品') return 0;
          return autoGenCandidates(order).then(function (n) { report.自动候选 = n; return n; });
        });
      }).then(function () {
        return DB.log({
          批次号: batchNo,
          操作类型: stockType + '库存导入(' + modeText(mode) + ')',
          来源文件: file.name,
          详情: { 日期: dateStr, 新增: report.新增, 更新: report.更新, 跳过: report.跳过.length, 异常: report.异常.length, 合并行: report.合并行, 自动候选: report.自动候选 || 0 }
        });
      }).then(function () { return report; });
    });
  }

  function modeText(m) {
    return { upsert: '按编码更新', append: '仅追加新编码', replace: '清除当日后导入' }[m] || m;
  }

  /* ============================================================
   * 半成品 ↔ 成品 对应关系
   *  · 名称模糊匹配置信度（0-100），<88 需人工复核
   *  · 自动生成的候选一律"待确认"；确认/锁定后的关系不再被导入改动
   * ============================================================ */
  var BRAND_WORDS = ['十里八香', '乐家客', '客家乐', '香乐多', '非遗传承', '王氏古方', '王氏', '国料'];

  /** 名称归一：去括号说明（半成品/方瓶）、规格净重、品牌前缀、标点空白 */
  function normName(s) {
    var t = String(s == null ? '' : s);
    t = t.replace(/[（(][^）)]*[）)]/g, '');
    t = t.replace(/\d+(\.\d+)?\s*(kg|g|克|千克|ml|l|毫升|升)?\s*[\/／]?\s*(瓶|袋|包|箱|罐|盒|桶)?/gi, '');
    BRAND_WORDS.forEach(function (b) { t = t.split(b).join(''); });
    t = t.replace(/[\s　·/／\-—,，.。:：;；、~～]/g, '');
    return t;
  }

  function bigrams(s) {
    var a = [];
    for (var i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2));
    return a;
  }

  /* 品牌识别：半成品名中的品牌词 → 成品"产品系列"中的系列关键词 */
  var BRAND_SERIES_KW = {
    '乐家客': '乐家客', '十里八香': '十里八香', '香乐多': '香乐多', '客家乐': '客家乐',
    '王氏古方': '王氏', '王氏': '王氏', '国料': '国料', '非遗传承': '非遗'
  };
  function brandOfName(name) {
    var t = String(name || '');
    for (var i = 0; i < BRAND_WORDS.length; i++) {
      if (t.indexOf(BRAND_WORDS[i]) >= 0) return BRAND_WORDS[i];
    }
    return '';
  }
  function sameBrand(semiName, finishName, finishSeries) {
    var b = brandOfName(semiName);
    if (!b) return false;
    var kw = BRAND_SERIES_KW[b] || b;
    return String(finishSeries || '').indexOf(kw) >= 0 || String(finishName || '').indexOf(b) >= 0;
  }

  /** 名称相似度 0-100：bigram Dice 系数(0.3) + 短名覆盖率(0.7) */
  function nameMatchScore(nameA, nameB) {
    var x = normName(nameA), y = normName(nameB);
    if (!x || !y) return 0;
    if (x === y) return 100;
    var bx = bigrams(x), by = bigrams(y);
    if (!bx.length || !by.length) return 0;
    var mark = {};
    bx.forEach(function (g) { mark[g] = 1; });
    var common = by.filter(function (g) { return mark[g]; }).length;
    if (!common) return 0;
    var dice = 2 * common / (bx.length + by.length);
    var cover = common / Math.min(bx.length, by.length);
    return Math.round((0.3 * dice + 0.7 * cover) * 100);
  }

  /**
   * 半成品导入后，为尚无任何关联的半成品匹配最佳成品候选（仅生成"待确认"）。
   * 候选池：优先取"有成品库存快照"的在售成品（清单里有但从未入库的停产/未上架产品不参与）；
   *        若尚未导入过成品库存，则退回全部成品档案。
   * 选择规则：基础名称分（nameMatchScore）之上，优先同品牌、成品名以半成品名开头的候选，
   * 避免"乐家客五香粉"误配到"王氏古方五香粉"、"辣椒粉"误配到"小辣椒粉"。
   */
  function autoGenCandidates(semiCodes) {
    return Promise.all([DB.all('bom'), DB.all('material'), DB.all('stock')]).then(function (r) {
      var links = r[0], mats = r[1], stocks = r[2];
      var linked = {};
      links.forEach(function (l) { linked[l.半成品编码] = 1; });
      var matMap = {};
      mats.forEach(function (m) { matMap[m.物料编码] = m; });
      var stockedCodes = {};
      stocks.forEach(function (s) { if (s.库存类型 === '成品') stockedCodes[s.物料编码] = 1; });
      var hasStock = Object.keys(stockedCodes).length > 0;
      var finish = mats.filter(function (m) {
        var isFinish = m.库存属性 === '成品' || /^(69|20)\d{10,}$/.test(m.物料编码);
        return isFinish && (!hasStock || stockedCodes[m.物料编码]);
      });
      var puts = [];
      semiCodes.forEach(function (code) {
        if (linked[code]) return; /* 已有任何关系（含待确认）都不再自动生成 */
        var semi = matMap[code];
        if (!semi || !semi.物料名称) return;
        var nx = normName(semi.物料名称);
        var sBrand = brandOfName(semi.物料名称);
        var best = null, bestScore = 0, bestKey = -1;
        finish.forEach(function (f) {
          var sc = nameMatchScore(semi.物料名称, f.物料名称);
          if (sc <= 0) return;
          var brand = sameBrand(semi.物料名称, f.物料名称, f.产品系列) ? 1 : 0;
          var ny = normName(f.物料名称);
          var prefix = (ny.indexOf(nx) === 0 || nx.indexOf(ny) === 0) ? 1 : 0;
          /* 成品名称里直接出现"其他品牌词"（如半成品乐家客五香粉 vs 王氏古方五香粉）→ 降权，
             仅系列不同、成品名为通用名（白胡椒粉）不惩罚 */
          var crossBrand = 0;
          if (sBrand) {
            BRAND_WORDS.forEach(function (w) {
              if (w !== sBrand && sBrand.indexOf(w) < 0 && w.indexOf(sBrand) < 0
                  && String(f.物料名称).indexOf(w) >= 0) crossBrand = 1;
            });
          }
          /* 复合排序键：名称前缀/精确一致 > 名称基础分 > 同品牌决胜 > 显式跨品牌降权 */
          var key = prefix * 100000 + sc * 100 + brand - crossBrand * 3000;
          if (key > bestKey) { bestKey = key; best = f; bestScore = sc; }
        });
        if (best && bestScore >= 60) {
          puts.push({
            半成品编码: code, 成品编码: best.物料编码,
            单耗: '', 状态: '待确认', 匹配度: bestScore, 来源: '自动', 更新时间: nowStr()
          });
        }
      });
      return DB.bulkPut('bom', puts).then(function () { return puts.length; });
    });
  }

  /** 新增/更新一条对应关系（手工添加关联用）；已锁定不允许覆盖 */
  function upsertBomLink(semiCode, finishCode, patch) {
    return DB.get('bom', [String(finishCode), String(semiCode)]).then(function (old) {
      if (old && old.状态 === '已锁定') {
        var e = new Error('该对应关系已锁定，请先解锁');
        e.code = 'LOCKED';
        throw e;
      }
      var rec = old || {
        半成品编码: String(semiCode), 成品编码: String(finishCode),
        单耗: '', 状态: '待确认', 匹配度: null, 来源: '手工'
      };
      Object.keys(patch || {}).forEach(function (k) { rec[k] = patch[k]; });
      rec.更新时间 = nowStr();
      return DB.put('bom', rec).then(function () { return rec; });
    });
  }

  var BOM_ALIASES = {
    半成品编码: ['半成品编码', '半成品料号', '半成品物料编码', '子件编码', '半成品'],
    成品编码: ['成品编码', '成品料号', '成品物料编码', '父件编码', '成品'],
    单耗: ['单耗', '单耗(公斤/箱)', '单耗（公斤/箱）', '用量', '耗用量', '每箱耗用量', '公斤/箱'],
    状态: ['确认状态', '确认结果', '状态']
  };

  function normBomStatus(v) {
    var s = String(v || '').trim();
    if (/锁/.test(s)) return '已锁定';
    if (/确认/.test(s) && !/待/.test(s)) return '已确认';
    return '待确认';
  }

  /** 导入"半成品↔成品对应关系"Excel；已锁定的行跳过不覆盖 */
  function importBomLinks(file) {
    var report = { 新增: 0, 更新: 0, 跳过: [], 警告: [], 总数: 0 };
    return readRows(file).then(function (parsed) {
      var norm = {};
      Object.keys(BOM_ALIASES).forEach(function (f) { norm[f] = BOM_ALIASES[f].map(normHeader); });
      var located = null;
      for (var hr = 0; hr < Math.min(10, parsed.rows.length); hr++) {
        var cm = {}, hitS = false, hitF = false;
        for (var c = 0; c < parsed.rows[hr].length; c++) {
          var h = normHeader(parsed.rows[hr][c]);
          if (!h) continue;
          for (var f in norm) {
            if (cm[f] !== undefined) continue;
            if (norm[f].indexOf(h) >= 0) { cm[f] = c; break; }
          }
          if (cm.半成品编码 === c) hitS = true;
          if (cm.成品编码 === c) hitF = true;
        }
        if (hitS && hitF) { located = { headerRow: hr, colMap: cm }; break; }
      }
      if (!located) {
        var e = new Error('未识别到表头：需包含"半成品编码"与"成品编码"列');
        e.code = 'BAD_HEADER';
        throw e;
      }
      var colMap = located.colMap;
      function cv(row, f) { var i = colMap[f]; return i === undefined ? '' : (row[i] == null ? '' : String(row[i]).trim()); }

      return DB.all('material').then(function (mats) {
        var exist = {};
        mats.forEach(function (m) { exist[m.物料编码] = m; });
        var chain = Promise.resolve();
        for (var rr = located.headerRow + 1; rr < parsed.rows.length; rr++) {
          (function (row, line) {
            if (!row || row.every(function (v) { return v === '' || v == null; })) return;
            var sc = cv(row, '半成品编码'), fc = cv(row, '成品编码');
            if (!sc || !fc) return;
            chain = chain.then(function () {
              report.总数++;
              if (!exist[sc]) { report.跳过.push({ 行号: line, 编码: sc, 原因: '半成品编码不在物料档案' }); return; }
              return DB.get('bom', [fc, sc]).then(function (old) {
                if (old && old.状态 === '已锁定') { report.跳过.push({ 行号: line, 编码: sc + '→' + fc, 原因: '已锁定，未覆盖' }); return; }
                var useRaw = cv(row, '单耗');
                var useNum = parseNumber(useRaw);
                var status = colMap.状态 === undefined ? (old ? old.状态 : '待确认') : normBomStatus(cv(row, '状态'));
                var rec = old || { 半成品编码: sc, 成品编码: fc, 匹配度: null, 来源: '导入' };
                if (useRaw !== '') rec.单耗 = isNaN(useNum) ? '' : useNum;
                rec.状态 = status;
                rec.更新时间 = nowStr();
                if (!exist[fc]) report.警告.push({ 行号: line, 编码: fc, 原因: '成品编码不在档案，请核对' });
                if (old) report.更新++; else report.新增++;
                return DB.put('bom', rec);
              });
            });
          })(parsed.rows[rr], rr + 1);
        }
        return chain.then(function () {
          return DB.log({
            批次号: DB.newBatchNo('BOM'),
            操作类型: '对应关系导入',
            来源文件: file.name,
            详情: { 条目: report.总数, 新增: report.新增, 更新: report.更新, 跳过: report.跳过.length, 警告: report.警告.length }
          });
        }).then(function () { return report; });
      });
    });
  }

  /* ---------- 产品清单（品牌系列 / 子分类档案） ---------- */

  var CAT_ALIASES = {
    编码: ['产品编码', '物料编码', '编码', '物料号', '条码', '货号'],
    系列: ['品牌系列', '产品系列', '系列'],
    子分类: ['子分类', '分类', '包装形态', '子分类(包装形态)'],
    名称: ['产品名称', '物料名称', '名称', '品名'],
    规格: ['规格', '规格型号', '型号']
  };

  function locateCatalogHeader(rows) {
    var norm = {};
    Object.keys(CAT_ALIASES).forEach(function (f) { norm[f] = CAT_ALIASES[f].map(normHeader); });
    for (var r = 0; r < Math.min(10, rows.length); r++) {
      var map = {}, hitCode = false, hitSeries = false;
      for (var c = 0; c < rows[r].length; c++) {
        var h = normHeader(rows[r][c]);
        if (!h) continue;
        for (var f in norm) {
          if (map[f] !== undefined) continue;
          if (norm[f].indexOf(h) >= 0) { map[f] = c; break; }
        }
        if (map.编码 === c) hitCode = true;
        if (map.系列 === c) hitSeries = true;
      }
      if (hitCode && hitSeries) return { headerRow: r, colMap: map };
    }
    return null;
  }

  /** 按产品清单条目更新物料主数据（成品档案） */
  function applyCatalogItems(items, source) {
    var report = { 新增: 0, 更新: 0, 跳过: [], 总数: items.length };
    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () {
        var code = String(it.code == null ? '' : it.code).trim();
        if (!code) { report.跳过.push({ 编码: '', 原因: '编码为空' }); return; }
        return DB.get('material', code).then(function (old) {
          var m = old || {
            物料编码: code, 物料名称: '', 产品系列: '', '子分类(包装形态)': '',
            规格型号: '', 箱规: '', 库存属性: '成品', 产品形态: '', 包装形式: '', 工艺组: '', 工艺路线: '',
            主单位: '箱', 包装单位: '', 单位换算比: '', 安全水位: '', 目标库存天数: '',
            状态: '启用', 备注: ''
          };
          if (it.series) m.产品系列 = it.series;
          if (it.sub) m['子分类(包装形态)'] = it.sub;
          if (it.name && !m.物料名称) m.物料名称 = it.name;
          if (it.spec) {
            m.规格型号 = it.spec;
            var box = parseBoxSpec(it.spec, it.sub);
            if (box) {
              m.箱规 = box.箱规文本; m.单位换算比 = box.箱规数; m.包装单位 = box.内包装单位;
              if (!m.包装形式 && m.包装单位) m.包装形式 = m.包装单位 + '装';
            }
          }
          m.库存属性 = '成品';
          if (!m.主单位) m.主单位 = '箱';
          if (old) report.更新++; else report.新增++;
          return DB.put('material', m);
        });
      });
    });
    return chain.then(function () {
      return DB.log({
        批次号: DB.newBatchNo('CAT'),
        操作类型: '产品清单导入',
        来源文件: source || '内置产品清单',
        详情: { 条目: report.总数, 新增: report.新增, 更新: report.更新, 跳过: report.跳过.length }
      });
    }).then(function () { return report; });
  }

  function importCatalog(file) {
    return readRows(file).then(function (parsed) {
      var located = locateCatalogHeader(parsed.rows);
      if (!located) {
        var e = new Error('未识别到产品清单表头：需包含"产品编码"与"品牌系列"列');
        e.code = 'BAD_HEADER';
        throw e;
      }
      var cm = located.colMap;
      function v(row, f) { var i = cm[f]; return i === undefined ? '' : (row[i] == null ? '' : String(row[i]).trim()); }
      var items = [], seen = {};
      for (var r = located.headerRow + 1; r < parsed.rows.length; r++) {
        var row = parsed.rows[r];
        if (!row || row.every(function (x) { return x === '' || x == null; })) continue;
        var code = v(row, '编码');
        if (!code) continue;
        if (seen[code]) continue;
        seen[code] = 1;
        items.push({ code: code, series: v(row, '系列'), sub: v(row, '子分类'), name: v(row, '名称'), spec: v(row, '规格') });
      }
      return applyCatalogItems(items, file.name).then(function (report) {
        try { localStorage.setItem('catalog_ver', 'manual-' + Date.now()); } catch (e) {}
        return report;
      });
    });
  }

  /* ---------- 清除当日 ---------- */
  function clearToday(kind, dateStr) {
    dateStr = dateStr || todayStr();
    var batchNo = DB.newBatchNo('CLR');
    if (kind === '欠货') {
      // 只清"今天录入且仍待排产"的欠货，保护已在跟踪的业务状态
      return DB.deleteWhere('backorder', function (b) {
        return b.录入日期 === dateStr && b.状态 === '待排产';
      }).then(function (n) {
        return DB.log({
          批次号: batchNo, 操作类型: '清除当日欠货',
          详情: { 日期: dateStr, 删除: n, 范围: '今日录入且状态为待排产' }
        }).then(function () { return n; });
      });
    }
    return DB.deleteWhere('stock', function (s) {
      return s.日期 === dateStr && s.库存类型 === kind;
    }).then(function (n) {
      return DB.log({
        批次号: batchNo, 操作类型: '清除当日' + kind,
        详情: { 日期: dateStr, 删除: n }
      }).then(function () { return n; });
    });
  }

  global.Importer = {
    importStock: importStock,
    clearToday: clearToday,
    parseBoxSpec: parseBoxSpec,
    innerUnitFromText: innerUnitFromText,
    pickDateFromName: pickDateFromName,
    importCatalog: importCatalog,
    applyCatalogItems: applyCatalogItems,
    nameMatchScore: nameMatchScore,
    normName: normName,
    autoGenCandidates: autoGenCandidates,
    upsertBomLink: upsertBomLink,
    importBomLinks: importBomLinks,
    todayStr: todayStr,
    nowStr: nowStr,
    modeText: modeText
  };
})(window);
