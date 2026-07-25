// ==UserScript==
// @name         集思录欧美/商品QDII T-1估值(95%指数)
// @namespace    https://github.com/local/jisilu-qdiia-lof
// @version      1.1.1
// @description  在集思录 QDII #qdiie 欧美(flex_qdiie)与商品(flex_qdiic)表增加 T-1日估值/T-1日估值溢价率
// @author       local
// @match        https://www.jisilu.cn/data/qdii/*
// @icon         https://www.jisilu.cn/favicon.ico
// @grant        none
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    HASH: '#qdiie',
    TABLES: [
      { id: 'flex_qdiie', label: '欧美' },
      { id: 'flex_qdiic', label: '商品' },
    ],
    ESTIMATE_HEADER: 'T-1日估值',
    PREMIUM_HEADER: 'T-1日估值溢价率',
    STOCK_RATIO: 0.95,
    POSITIVE_COLOR: '#c0392b',
    NEGATIVE_COLOR: '#27ae60',
    DEBOUNCE_MS: 400,
    POLL_FAST_MS: 600,
  };

  const MARK_EST = 'data-jsl-t1-estimate';
  const MARK_PREM = 'data-jsl-t1-premium';
  const MARK_HEADER_EST = 'data-jsl-t1-estimate-header';
  const MARK_HEADER_PREM = 'data-jsl-t1-premium-header';

  let debounceTimer = null;
  /** @type {Map<string, MutationObserver>} */
  const gridObservers = new Map();
  /** @type {Map<string, 'asc'|'desc'|null>} */
  const sortDirs = new Map();
  let hashListenerBound = false;
  let enhancing = false;
  let pollTimer = null;
  /** @type {Record<string, Record<string, number>>} */
  let frozenColMaps = {};

  const status = {
    version: '1.1.1',
    sessionDay: '',
    pageOk: false,
    tables: /** @type {Record<string, {found:boolean,ready:boolean,rows:number,error:string}>} */ ({}),
    rows: 0,
    lastError: '',
    lastOk: '',
  };

  function normalizeText(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/[−－]/g, '-')
      .trim();
  }

  function parseNumber(s) {
    const t = normalizeText(s);
    if (!t || t === '--' || t === '-') return null;
    const n = parseFloat(t.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function parsePercent(s) {
    const t = normalizeText(s);
    if (!t || t === '--' || t === '-') return null;
    const m = t.match(/^(-?\d+(?:\.\d+)?)%?$/);
    if (!m) return null;
    return parseFloat(m[1]) / 100;
  }

  function isIndexUnavailable(raw) {
    const t = normalizeText(raw);
    if (!t) return true;
    if (t === '-' || t === '--') return true;
    return parsePercent(raw) == null;
  }

  const UNAVAILABLE = '-';

  function formatEstimate(v, indexUnavailable) {
    if (indexUnavailable) return UNAVAILABLE;
    if (v == null) return '--';
    return v.toFixed(4);
  }

  function formatPremium(v, indexUnavailable) {
    if (indexUnavailable) return UNAVAILABLE;
    if (v == null) return '--';
    const sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(2) + '%';
  }

  function calcT1Estimate(t2Nav, indexRatio) {
    if (t2Nav == null || indexRatio == null || t2Nav <= 0) return null;
    return t2Nav * (1 + indexRatio * CONFIG.STOCK_RATIO);
  }

  function calcPremium(price, estimate) {
    if (price == null || estimate == null || estimate <= 0) return null;
    return ((price - estimate) / estimate) * 100;
  }

  const SHANGHAI_TZ = 'Asia/Shanghai';

  function getShanghaiCalendarParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: SHANGHAI_TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const pick = (type) => Number(parts.find((p) => p.type === type).value);
    return { y: pick('year'), m: pick('month'), d: pick('day') };
  }

  function weekdayShanghai(now = new Date()) {
    const w = new Intl.DateTimeFormat('en-US', {
      timeZone: SHANGHAI_TZ,
      weekday: 'short',
    }).format(now);
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[w] ?? 0;
  }

  function ymdToString(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function addCalendarDays(y, m, d, delta) {
    const t = Date.UTC(y, m - 1, d + delta);
    const dt = new Date(t);
    return {
      y: dt.getUTCFullYear(),
      m: dt.getUTCMonth() + 1,
      d: dt.getUTCDate(),
    };
  }

  function shiftYmd(ymd, deltaDays) {
    const [y, m, d] = ymd.split('-').map(Number);
    const p = addCalendarDays(y, m, d, deltaDays);
    return ymdToString(p.y, p.m, p.d);
  }

  function getSessionDayYmd(now = new Date()) {
    const parts = getShanghaiCalendarParts(now);
    const wd = weekdayShanghai(now);
    if (wd === 6) {
      const p = addCalendarDays(parts.y, parts.m, parts.d, -1);
      return ymdToString(p.y, p.m, p.d);
    }
    if (wd === 0) {
      const p = addCalendarDays(parts.y, parts.m, parts.d, -2);
      return ymdToString(p.y, p.m, p.d);
    }
    return ymdToString(parts.y, parts.m, parts.d);
  }

  function inferYearForMonthDay(m, d, refY, refM, refD) {
    let y = refY;
    const navOrd = m * 100 + d;
    const refOrd = refM * 100 + refD;
    if (navOrd > refOrd + 50) y = refY - 1;
    return y;
  }

  function parseTwoDigitYear(yy) {
    const n = Number(yy);
    if (!Number.isFinite(n)) return null;
    return n >= 70 ? 1900 + n : 2000 + n;
  }

  function parseNavDateYmd(raw, refSessionYmd) {
    const t = normalizeText(raw);
    if (!t || t === '-' || t === '--') return null;

    let y;
    let m;
    let d;

    const full = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (full) {
      y = Number(full[1]);
      m = Number(full[2]);
      d = Number(full[3]);
    } else {
      const yymd = t.match(/^(\d{2})[-/.](\d{1,2})[-/.](\d{1,2})$/);
      if (yymd) {
        y = parseTwoDigitYear(yymd[1]);
        m = Number(yymd[2]);
        d = Number(yymd[3]);
      } else {
        const md = t.match(/^(\d{1,2})[-/.](\d{1,2})$/);
        if (!md) return null;
        m = Number(md[1]);
        d = Number(md[2]);
        if (!refSessionYmd) return null;
        const [refY, refM, refD] = refSessionYmd.split('-').map(Number);
        y = inferYearForMonthDay(m, d, refY, refM, refD);
      }
    }

    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return ymdToString(y, m, d);
  }

  function shouldUseT1IndexEstimate(navDateYmd, sessionDayYmd) {
    if (!navDateYmd || !sessionDayYmd) return true;
    const cutoff = shiftYmd(sessionDayYmd, -1);
    return navDateYmd < cutoff;
  }

  function isActivePage() {
    if (!window.location.pathname.includes('/data/qdii')) return false;
    const hash = window.location.hash || '';
    return hash === CONFIG.HASH || hash.startsWith(CONFIG.HASH + '&');
  }

  function resolveGrid(tableRootId) {
    const root = document.getElementById(tableRootId);
    if (!root) return null;

    if (root.tagName === 'TABLE') {
      return { root, headerTable: root, bodyTable: root, tableId: tableRootId };
    }

    const grid = root.classList.contains('flexigrid')
      ? root
      : root.querySelector('.flexigrid') || root;

    const headerTable =
      grid.querySelector('.hDiv table') ||
      grid.querySelector('.hDiv thead')?.closest('table') ||
      null;

    const bodyTable =
      grid.querySelector('.bDiv table') ||
      grid.querySelector('tbody')?.closest('table') ||
      root.querySelector('table') ||
      null;

    if (!bodyTable && root.querySelector('table')) {
      const t = root.querySelector('table');
      return {
        root: grid,
        headerTable: headerTable || t,
        bodyTable: t,
        tableId: tableRootId,
      };
    }

    return {
      root: grid,
      headerTable: headerTable || bodyTable,
      bodyTable: bodyTable || headerTable,
      tableId: tableRootId,
    };
  }

  function getHeaderRow(headerTable) {
    if (!headerTable) return null;
    const thead = headerTable.querySelector('thead');
    if (!thead) {
      return headerTable.querySelector('tr') || null;
    }
    const rows = thead.querySelectorAll('tr');
    for (let i = rows.length - 1; i >= 0; i--) {
      const ths = rows[i].querySelectorAll('th');
      if (ths.length >= 5) return rows[i];
    }
    return rows[rows.length - 1] || null;
  }

  function headerLabel(th) {
    return normalizeText(th.textContent).replace(/[↑↓]/g, '');
  }

  function buildColumnMap(headerRow) {
    const map = { indexColName: 'T-1指数涨幅' };
    const ths = headerRow.querySelectorAll('th');
    ths.forEach((th, i) => {
      if (th.hasAttribute(MARK_HEADER_EST) || th.hasAttribute(MARK_HEADER_PREM)) {
        return;
      }
      const label = headerLabel(th);
      if (!label) return;
      if (label.includes('参考标的期间涨幅')) {
        map.indexPct = i;
        map.indexColName = '参考标的期间涨幅';
      } else if (label.includes('T-1') && label.includes('指数涨幅')) {
        map.indexPct = i;
        map.indexColName = 'T-1指数涨幅';
      } else if (label === '现价' || label.endsWith('现价')) map.price = i;
      else if (label === '名称' || label.includes('名称')) map.name = i;
      else if (label.includes('净值日期')) map.navDate = i;
      else if (
        label.includes('T-2') &&
        label.includes('净值') &&
        !label.includes('溢价')
      ) {
        map.nav = i;
      }
    });
    return map;
  }

  function tableReady(grid) {
    const headerRow = getHeaderRow(grid.headerTable);
    const tbody = grid.bodyTable?.querySelector('tbody');
    if (!headerRow || !tbody) return false;
    const firstRow = tbody.querySelector('tr');
    if (!firstRow) return false;
    const text = firstRow.textContent || '';
    if (text.includes('登录') && text.includes('查看')) return false;
    return firstRow.querySelectorAll('td').length >= 5;
  }

  function findAnchorHeader(headerRow, colMap) {
    const ths = headerRow.querySelectorAll('th');
    if (colMap.indexPct != null && ths[colMap.indexPct]) {
      return ths[colMap.indexPct];
    }
    if (colMap.nav != null && ths[colMap.nav]) {
      return ths[colMap.nav];
    }
    return ths[ths.length - 1] || null;
  }

  function injectStyles() {
    let style = document.querySelector('style[data-jsl-qdiie-t1-styles]');
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('data-jsl-qdiie-t1-styles', 'true');
      document.head.appendChild(style);
    }
    style.textContent = `
      th[${MARK_HEADER_EST}], th[${MARK_HEADER_PREM}],
      td[${MARK_EST}], td[${MARK_PREM}] {
        text-align: center; white-space: nowrap;
        width: 1%; min-width: 72px; max-width: 96px;
        padding: 2px 5px !important;
        box-sizing: border-box;
      }
      td[${MARK_EST}], td[${MARK_PREM}] {
        font-size: 14px !important;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        line-height: 1.25;
      }
      th[${MARK_HEADER_EST}], th[${MARK_HEADER_PREM}] {
        background: linear-gradient(180deg, #1565c0 0%, #0d47a1 100%) !important;
        color: #fff !important;
        font-weight: 700 !important;
        font-size: 13px !important;
        line-height: 1.2;
        text-shadow: 0 1px 0 rgba(0,0,0,.15);
      }
      th[${MARK_HEADER_PREM}] { cursor: pointer; user-select: none; }
      #jsl-qdiie-t1-refresh {
        margin: 4px 0; padding: 4px 12px; font-size: 12px; cursor: pointer;
        border: 1px solid #86c5e3; background: #f0f9ff; border-radius: 3px;
      }
      #jsl-qdiie-t1-status {
        position: fixed; left: 8px; bottom: 8px; z-index: 99998;
        max-width: 440px; font-size: 11px; line-height: 1.45;
        background: rgba(255,255,255,0.96); border: 1px solid #86c5e3;
        border-radius: 6px; padding: 8px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.12);
        color: #333;
      }
      #jsl-qdiie-t1-status .ok { color: #15803d; }
      #jsl-qdiie-t1-status .err { color: #b45309; }
    `;
  }

  function updateStatusPanel() {
    injectStyles();
    let el = document.getElementById('jsl-qdiie-t1-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'jsl-qdiie-t1-status';
      document.body.appendChild(el);
    }
    const tableLines = CONFIG.TABLES.map((t) => {
      const s = status.tables[t.id] || {};
      const mark = s.ready ? '✓' : s.found ? '…' : '✗';
      const extra = s.error ? ` <span class="err">${s.error}</span>` : ` ${s.rows || 0}行`;
      return `#${t.id}(${t.label}): ${mark}${extra}`;
    });
    const lines = [
      `<b>欧美/商品 T-1 估值 v${status.version}</b>`,
      `页面: ${status.pageOk ? '<span class="ok">#qdiie ✓</span>' : '<span class="err">请打开 欧美市场 (#qdiie)</span>'}`,
      ...tableLines,
      `会话日(沪): ${status.sessionDay || getSessionDayYmd()}`,
      `合计行: ${status.rows}`,
      status.lastOk ? `<span class="ok">${status.lastOk}</span>` : '',
      status.lastError ? `<span class="err">${status.lastError}</span>` : '',
      '<button type="button" id="jsl-qdiie-t1-refresh">立即插入/刷新两列</button>',
    ].filter(Boolean);
    el.innerHTML = lines.join('<br>');
    const btn = el.querySelector('#jsl-qdiie-t1-refresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        frozenColMaps = {};
        runEnhance(true);
      });
    }
  }

  function ensureHeaders(headerRow, anchorTh, bodyTable, tableId) {
    let estTh = headerRow.querySelector(`th[${MARK_HEADER_EST}]`);
    let premTh = headerRow.querySelector(`th[${MARK_HEADER_PREM}]`);

    if (!estTh) {
      estTh = document.createElement('th');
      estTh.className = 'header sticky';
      estTh.setAttribute(MARK_HEADER_EST, 'true');
      anchorTh.after(estTh);
    }
    estTh.textContent = CONFIG.ESTIMATE_HEADER;
    estTh.title =
      'T-2净值 × (1 + T-1指数涨幅 × 95%)，不含汇率；商品表用「参考标的期间涨幅」(会员)';

    if (!premTh) {
      premTh = document.createElement('th');
      premTh.className = 'header sticky';
      premTh.setAttribute(MARK_HEADER_PREM, 'true');
      estTh.after(premTh);
      premTh.addEventListener('click', () =>
        sortByPremium(bodyTable, headerRow, tableId)
      );
    }
    syncPremiumHeaderLabel(premTh);
    premTh.title = '(现价 − T-1日估值) / T-1日估值 × 100%';
  }

  function syncPremiumHeaderLabel(premTh) {
    const span = premTh.querySelector('.jsl-t1-prem-sort-indicator');
    const sortMark = span ? span.textContent : '';
    premTh.innerHTML =
      CONFIG.PREMIUM_HEADER +
      ' <span class="jsl-t1-prem-sort-indicator">' +
      sortMark +
      '</span>';
  }

  function getCustomColumnIndexes(headerRow) {
    const estTh = headerRow.querySelector(`th[${MARK_HEADER_EST}]`);
    return {
      estIdx: estTh ? Array.from(headerRow.children).indexOf(estTh) : -1,
    };
  }

  function ensureBodyCells(row, estIdx) {
    let estCell = row.querySelector(`td[${MARK_EST}]`);
    let premCell = row.querySelector(`td[${MARK_PREM}]`);
    if (estCell && premCell) return { estCell, premCell };

    const cells = row.querySelectorAll('td');
    estCell = document.createElement('td');
    premCell = document.createElement('td');
    estCell.setAttribute(MARK_EST, 'true');
    premCell.setAttribute(MARK_PREM, 'true');
    if (cells[0]?.className) {
      estCell.className = cells[0].className;
      premCell.className = cells[0].className;
    }

    const insertAt =
      estIdx >= 0 && estIdx <= cells.length ? estIdx : cells.length;
    if (insertAt >= cells.length) {
      row.appendChild(estCell);
      row.appendChild(premCell);
    } else {
      row.insertBefore(estCell, cells[insertAt]);
      row.insertBefore(premCell, estCell.nextSibling);
    }
    return { estCell, premCell };
  }

  function setBothUnavailable(estCell, premCell, title) {
    estCell.textContent = UNAVAILABLE;
    premCell.textContent = UNAVAILABLE;
    premCell.style.color = '';
    premCell.removeAttribute('data-premium-val');
    estCell.title = title;
    premCell.title = title;
  }

  function fillRow(row, colMap, headerRow, sessionDayYmd) {
    try {
      const cells = row.querySelectorAll('td');
      if (cells.length < 3 || colMap.nav == null || colMap.indexPct == null) {
        return false;
      }

      const name =
        colMap.name != null
          ? (cells[colMap.name]?.textContent || '').trim()
          : (cells[1]?.textContent || '').trim();
      const price =
        colMap.price != null
          ? parseNumber(cells[colMap.price]?.textContent)
          : null;
      const t2Nav =
        colMap.nav != null ? parseNumber(cells[colMap.nav]?.textContent) : null;
      const navDateRaw =
        colMap.navDate != null ? cells[colMap.navDate]?.textContent : null;
      const navDateYmd = parseNavDateYmd(navDateRaw, sessionDayYmd);
      const indexRaw =
        colMap.indexPct != null ? cells[colMap.indexPct]?.textContent : null;
      const indexUnavailable = isIndexUnavailable(indexRaw);
      const indexR = indexUnavailable ? null : parsePercent(indexRaw);
      const indexName = colMap.indexColName || 'T-1指数涨幅';

      const { estIdx } = getCustomColumnIndexes(headerRow);
      const pair = ensureBodyCells(row, estIdx);
      if (!pair) return false;

      const { estCell, premCell } = pair;

      if (indexUnavailable) {
        const reason =
          indexName === '参考标的期间涨幅'
            ? '参考标的期间涨幅不可用（非会员或暂无数据）'
            : 'T-1指数涨幅不可用';
        setBothUnavailable(
          estCell,
          premCell,
          [
            name ? `名称: ${name}` : '',
            `不计算原因: ${reason}`,
            'T-1日估值、T-1日估值溢价率均无法计算',
          ]
            .filter(Boolean)
            .join('\n')
        );
        return true;
      }

      const useIndex = shouldUseT1IndexEstimate(navDateYmd, sessionDayYmd);
      const cutoff = shiftYmd(sessionDayYmd, -1);

      if (!useIndex) {
        setBothUnavailable(
          estCell,
          premCell,
          [
            `名称: ${name || '--'}`,
            `会话日(沪): ${sessionDayYmd}`,
            `T-2净值日期: ${navDateYmd || (navDateRaw || '').trim() || '--'}`,
            `阈值: 须严格早于 会话日−1（${cutoff}）才估 T-1`,
            '不计算原因: T-2净值日期已滚到新日期（如周末已更新到周四）',
            'T-2×T-1指数 模型失效；T-1日估值与 T-1日估值溢价率均无意义',
            '（真实折溢价需结合更新后净值与后续交易日指数，本脚本不展示）',
          ].join('\n')
        );
        return true;
      }

      const estimate = calcT1Estimate(t2Nav, indexR);
      const premium = calcPremium(price, estimate);
      estCell.textContent = formatEstimate(estimate, false);
      premCell.textContent = formatPremium(premium, false);
      if (premium != null) {
        premCell.style.color =
          premium >= 0 ? CONFIG.POSITIVE_COLOR : CONFIG.NEGATIVE_COLOR;
        premCell.setAttribute('data-premium-val', String(premium));
      } else {
        premCell.style.color = '';
        premCell.removeAttribute('data-premium-val');
      }

      const tip = [
        `名称: ${name || '--'}`,
        `会话日: ${sessionDayYmd}`,
        `T-2净值日期: ${navDateYmd || (navDateRaw || '').trim() || '--'} (< 会话日−1 ${cutoff})`,
        `现价: ${price ?? '--'}`,
        `T-2净值: ${t2Nav ?? '--'}`,
        `${indexName}: ${(indexRaw || '').trim() || '--'}`,
        `T-1日估值 = T-2净值 × (1 + ${indexName} × ${CONFIG.STOCK_RATIO})`,
        estimate != null ? `= ${formatEstimate(estimate, false)}` : '',
        `T-1日估值溢价率 = (现价 - T-1日估值) / T-1日估值`,
        premium != null ? `= ${formatPremium(premium, false)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      estCell.title = tip;
      premCell.title = tip;

      return true;
    } catch (err) {
      console.warn('[集思录T-1估值] 单行跳过:', err);
      return false;
    }
  }

  function sortByPremium(bodyTable, headerRow, tableId) {
    const tbody = bodyTable.querySelector('tbody');
    if (!tbody || !headerRow) return;

    let sortDir = sortDirs.get(tableId) ?? null;
    sortDir = sortDir === null ? 'desc' : sortDir === 'desc' ? 'asc' : null;
    sortDirs.set(tableId, sortDir);

    const indicator = headerRow.querySelector('.jsl-t1-prem-sort-indicator');
    if (indicator) {
      indicator.textContent =
        sortDir === 'desc' ? '↓' : sortDir === 'asc' ? '↑' : '';
    }
    if (!sortDir) return;

    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort((a, b) => {
      const av = parseFloat(
        a.querySelector(`td[${MARK_PREM}]`)?.getAttribute('data-premium-val') ||
          'NaN'
      );
      const bv = parseFloat(
        b.querySelector(`td[${MARK_PREM}]`)?.getAttribute('data-premium-val') ||
          'NaN'
      );
      if (Number.isNaN(av) && Number.isNaN(bv)) return 0;
      if (Number.isNaN(av)) return 1;
      if (Number.isNaN(bv)) return -1;
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    rows.forEach((r) => tbody.appendChild(r));
  }

  function disconnectAllObservers() {
    for (const ob of gridObservers.values()) ob.disconnect();
    gridObservers.clear();
  }

  function observeBody(bodyTable, headerTable, colMap, tableId) {
    const tbody = bodyTable.querySelector('tbody');
    if (!tbody) return;
    const headerRow = getHeaderRow(headerTable);
    if (!headerRow) return;

    const prev = gridObservers.get(tableId);
    if (prev) prev.disconnect();

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.tagName === 'TR') {
            fillRow(node, colMap, headerRow, getSessionDayYmd());
          }
        }
      }
    });
    observer.observe(tbody, { childList: true, subtree: false });
    gridObservers.set(tableId, observer);
  }

  function enhanceOneGrid(tableDef) {
    const tableId = tableDef.id;
    const st = { found: false, ready: false, rows: 0, error: '' };
    status.tables[tableId] = st;

    const grid = resolveGrid(tableId);
    if (!grid || !grid.bodyTable) {
      st.error = '未找到容器';
      return 0;
    }
    st.found = true;

    if (!grid.headerTable || !tableReady(grid)) {
      st.error = '未就绪';
      return 0;
    }
    st.ready = true;

    const headerRow = getHeaderRow(grid.headerTable);
    if (!headerRow) {
      st.error = '无表头';
      return 0;
    }

    let colMap = frozenColMaps[tableId];
    if (!colMap) {
      colMap = buildColumnMap(headerRow);
      if (colMap.nav == null || colMap.indexPct == null) {
        const labels = Array.from(headerRow.querySelectorAll('th')).map(headerLabel);
        st.error = '列映射失败';
        console.warn('[集思录T-1估值]', tableId, labels, colMap);
        return 0;
      }
      frozenColMaps[tableId] = { ...colMap };
    }

    const anchor = findAnchorHeader(headerRow, colMap);
    if (!anchor) {
      st.error = '无锚点列';
      return 0;
    }

    ensureHeaders(headerRow, anchor, grid.bodyTable, tableId);

    const sessionDayYmd = getSessionDayYmd();
    status.sessionDay = sessionDayYmd;

    const rows = grid.bodyTable.querySelectorAll('tbody tr');
    let n = 0;
    rows.forEach((row) => {
      if (fillRow(row, colMap, headerRow, sessionDayYmd)) n++;
    });
    st.rows = n;
    observeBody(grid.bodyTable, grid.headerTable, colMap, tableId);
    return n;
  }

  function enhanceAllGrids() {
    status.pageOk = isActivePage();
    status.lastError = '';
    status.lastOk = '';
    status.rows = 0;

    if (!status.pageOk) {
      status.lastError = '请打开 欧美市场 Tab (#qdiie)';
      updateStatusPanel();
      return false;
    }

    disconnectAllObservers();
    let anyReady = false;
    for (const t of CONFIG.TABLES) {
      const n = enhanceOneGrid(t);
      status.rows += n;
      if (status.tables[t.id]?.ready) anyReady = true;
    }

    if (!anyReady) {
      status.lastError = status.lastError || '两个表格均未就绪，请等待加载';
    } else if (status.rows > 0) {
      status.lastOk = `已处理 ${status.rows} 行（欧美+商品，LOF/ETF 同算法）`;
    } else {
      status.lastOk = '表头已插入，等待数据行';
    }

    updateStatusPanel();
    return anyReady;
  }

  function runEnhance(force) {
    if (enhancing && !force) return;
    enhancing = true;
    try {
      enhanceAllGrids();
    } catch (err) {
      status.lastError = '异常: ' + err.message;
      console.error('[集思录T-1估值]', err);
      updateStatusPanel();
    } finally {
      enhancing = false;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (isActivePage()) runEnhance(false);
      else {
        status.pageOk = false;
        updateStatusPanel();
      }
    }, CONFIG.POLL_FAST_MS);
  }

  function init() {
    updateStatusPanel();
    startPolling();
    runEnhance(false);

    if (!hashListenerBound) {
      window.addEventListener('hashchange', () => {
        frozenColMaps = {};
        sortDirs.clear();
        disconnectAllObservers();
        runEnhance(true);
      });
      hashListenerBound = true;
    }
  }

  init();
  console.log('[集思录T-1估值] v1.1.1 — 停估时两列均为 -');
})();
