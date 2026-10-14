/* ============================================================
 * db.js — IndexedDB 封装
 * 8 张业务表 + 1 张操作日志表（对应需求文档数据模型）
 *   mdl_material       物料主数据        key: 物料编码
 *                      字段：…/库存属性/产品形态(粉料|块料|酱料|原始香辛料)/包装形式(如 玻璃瓶装，
 *                            与产品形态组合成工艺形态用于产线映射与设备选型)/主单位/安全水位/目标库存天数 等
 *   fact_stock_daily   库存快照          key: [日期,库存类型,物料编码]（v2 起不再区分批次）
 *   fact_backorder     销售欠货          key: id (auto)
 *   dim_worksection     工段线体档案(二期) key: 工段编号
 *                      字段：工段编号、工段名称、生产线(L01..L05)、线体名称、工段序号、
 *                            工艺路线、备注、更新时间（去班次模式，统一白班，按时间计量产量）
 *   dim_capacity        产能台账(二期)    key: id (auto)  索引: idx_form_section=[产品形态,工段编号]
 *                      字段：借鉴值(可带单位,默认每小时产量)/实测值(可带单位)/领料时间(分钟)
 *                            /调试换线清场时间(分钟)/设备类型/启用日期/备注
 *   fact_output_daily   实际产出(二期)    key: id (auto)  索引: idx_date, idx_section_date
 *                      字段：日期/工段编号/产品形态/物料编码/产出数量(箱)/生产时间(小时)
 *                            /换产清洗次数/备注（去班次，统一白班，按时间计量产量）
 *   mdl_bom_link        成品↔半成品对应关系 key: [成品编码,半成品编码]
 *                      字段：单耗(公斤/箱)、状态(待确认/已确认/已锁定)、匹配度、来源、更新时间
 *   mdl_replenish_cfg   备货参数(二期)    key: 参数键  v3 新增
 *   fact_plan_monthly   月度生产计划(二期) key: [月份,物料编码]  v4 新增  索引: idx_month
 *                      字段：推荐数量/推荐依据{去年同期,今年上月,去年上月,系数}/计划数量/
 *                            状态(草稿|已确认)/确认人/确认时间/备注/修改记录[]/创建时间/更新时间
 *   op_log              操作审计日志      key: id (auto)
 * ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'inventory_dashboard';
  var DB_VERSION = 4;

  var STORES = {
    material:      { name: 'mdl_material',      keyPath: '物料编码' },
    stock:         { name: 'fact_stock_daily',  keyPath: ['日期', '库存类型', '物料编码'] },
    backorder:     { name: 'fact_backorder',    keyPath: 'id', auto: true },
    worksection:   { name: 'dim_worksection',   keyPath: '工段编号' },
    capacity:      { name: 'dim_capacity',      keyPath: 'id', auto: true },
    output:        { name: 'fact_output_daily', keyPath: 'id', auto: true },
    bom:           { name: 'mdl_bom_link',      keyPath: ['成品编码', '半成品编码'] },
    replenish_cfg: { name: 'mdl_replenish_cfg', keyPath: '参数键' },
    plan:          { name: 'fact_plan_monthly', keyPath: ['月份', '物料编码'] },
    oplog:         { name: 'op_log',            keyPath: 'id', auto: true }
  };

  var dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        var oldV = e.oldVersion;

        /* v1 → v2：库存快照主键去掉"批次号"（一期不管理批次/效期），重建快照表 */
        if (oldV < 2 && db.objectStoreNames.contains('fact_stock_daily')) {
          db.deleteObjectStore('fact_stock_daily');
        }

        Object.keys(STORES).forEach(function (k) {
          var s = STORES[k];
          if (!db.objectStoreNames.contains(s.name)) {
            db.createObjectStore(s.name, s.auto ? { keyPath: s.keyPath, autoIncrement: true } : { keyPath: s.keyPath });
          }
        });
        // 库存按日期、物料建索引便于查询
        var tx = e.target.transaction;
        try {
          var stockStore = tx.objectStore(STORES.stock.name);
          if (!stockStore.indexNames.contains('idx_date')) stockStore.createIndex('idx_date', '日期');
          if (!stockStore.indexNames.contains('idx_code')) stockStore.createIndex('idx_code', '物料编码');
          if (!stockStore.indexNames.contains('idx_type_date')) stockStore.createIndex('idx_type_date', ['库存类型', '日期']);
        } catch (err) { /* 索引已存在时忽略 */ }

        /* v2 → v3：二期产能与产出表加索引 */
        if (oldV < 3) {
          try {
            var capStore = tx.objectStore(STORES.capacity.name);
            if (!capStore.indexNames.contains('idx_form_section')) capStore.createIndex('idx_form_section', ['产品形态', '工段编号']);
            var outStore = tx.objectStore(STORES.output.name);
            if (!outStore.indexNames.contains('idx_date')) outStore.createIndex('idx_date', '日期');
            if (!outStore.indexNames.contains('idx_section_date')) outStore.createIndex('idx_section_date', ['工段编号', '日期']);
          } catch (err2) { /* 索引已存在或表刚创建时忽略 */ }
        }

        /* v3 → v4：月度生产计划表加月份索引 */
        if (oldV < 4) {
          try {
            var planStore = tx.objectStore(STORES.plan.name);
            if (!planStore.indexNames.contains('idx_month')) planStore.createIndex('idx_month', '月份');
          } catch (err3) { /* 索引已存在或表刚创建时忽略 */ }
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  function tx(storeKey, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORES[storeKey].name, mode);
        var store = t.objectStore(STORES[storeKey].name);
        var result;
        Promise.resolve(fn(store)).then(function (r) { result = r; }).catch(reject);
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  var DB = {
    STORES: STORES,
    ready: open,

    /** 读取整表 */
    all: function (storeKey) {
      return tx(storeKey, 'readonly', function (store) { return reqToPromise(store.getAll()); });
    },

    /** 按主键读取 */
    get: function (storeKey, key) {
      return tx(storeKey, 'readonly', function (store) { return reqToPromise(store.get(key)); });
    },

    /** 写入/覆盖单条 */
    put: function (storeKey, value) {
      return tx(storeKey, 'readwrite', function (store) { return reqToPromise(store.put(value)); });
    },

    /** 批量写入（同一事务） */
    bulkPut: function (storeKey, values) {
      return tx(storeKey, 'readwrite', function (store) {
        return Promise.all(values.map(function (v) { return reqToPromise(store.put(v)); }));
      });
    },

    /** 删除单条 */
    del: function (storeKey, key) {
      return tx(storeKey, 'readwrite', function (store) { return reqToPromise(store.delete(key)); });
    },

    /** 清空整表 */
    clear: function (storeKey) {
      return tx(storeKey, 'readwrite', function (store) { return reqToPromise(store.clear()); });
    },

    /** 游标删除：返回删除条数。predicate(record) => true 删除 */
    deleteWhere: function (storeKey, predicate) {
      return tx(storeKey, 'readwrite', function (store) {
        return new Promise(function (resolve, reject) {
          var count = 0;
          var curReq = store.openCursor();
          curReq.onsuccess = function (e) {
            var cursor = e.target.result;
            if (!cursor) { resolve(count); return; }
            if (predicate(cursor.value)) { cursor.delete(); count++; }
            cursor.continue();
          };
          curReq.onerror = function () { reject(curReq.error); };
        });
      });
    },

    /** 多表整库读取（备份用） */
    dumpAll: function () {
      var keys = Object.keys(STORES);
      return Promise.all(keys.map(function (k) { return DB.all(k); })).then(function (lists) {
        var out = {};
        keys.forEach(function (k, i) { out[STORES[k].name] = lists[i]; });
        return out;
      });
    },

    /** 整库覆盖恢复（备份恢复用）；"已锁定"的半成品↔成品关系不被覆盖 */
    restoreAll: function (data) {
      var keys = Object.keys(STORES);
      /* 先抢救当前库中已锁定的对应关系 */
      return DB.all('bom').then(function (curBom) {
        var locked = curBom.filter(function (b) { return b.状态 === '已锁定'; });
        return open().then(function (db) {
          return new Promise(function (resolve, reject) {
            var t = db.transaction(keys.map(function (k) { return STORES[k].name; }), 'readwrite');
            t.oncomplete = function () { resolve(locked.length); };
            t.onerror = function () { reject(t.error); };
            t.onabort = function () { reject(t.error); };
            keys.forEach(function (k) {
              var rows = data[STORES[k].name] || [];
              var store = t.objectStore(STORES[k].name);
              store.clear();
              rows.forEach(function (row) { store.put(row); });
              /* 锁定关系原样写回（即便备份里同主键是旧状态也以锁定版为准） */
              if (k === 'bom') locked.forEach(function (b) { store.put(b); });
            });
          });
        });
      });
    },

    /** 生成导入批次号：IMP-YYYYMMDD-HHMMSS-XYZ */
    newBatchNo: function (prefix) {
      var d = new Date();
      function p(n) { return String(n).padStart(2, '0'); }
      var s = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
              '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
      var rnd = Math.random().toString(36).slice(2, 5).toUpperCase();
      return (prefix || 'IMP') + '-' + s + '-' + rnd;
    },

    /** 写审计日志 */
    log: function (entry) {
      var row = {
        时间: new Date().toLocaleString('zh-CN', { hour12: false }),
        批次号: entry.批次号 || '',
        操作类型: entry.操作类型 || '',
        来源文件: entry.来源文件 || '',
        详情: typeof entry.详情 === 'string' ? entry.详情 : JSON.stringify(entry.详情 || {})
      };
      return DB.put('oplog', row).catch(function (e) { console.warn('日志写入失败', e); });
    }
  };

  global.DB = DB;
})(window);
