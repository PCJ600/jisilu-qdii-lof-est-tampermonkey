// ==UserScript==
// @name         集思录亚洲LOF实时估值(95%指数)
// @namespace    https://github.com/local/jisilu-qdiia-lof
// @version      1.4.1
// @description  在集思录 QDII 亚洲市场（LOF/ETF 等）增加「实时估值」「实时溢价率」
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
    TABLE_ROOT_ID: 'flex_qdiia',
    HASH: '#qdiia',
    ESTIMATE_HEADER: '实时估值',
    PREMIUM_HEADER: '实时溢价率',
    STOCK_RATIO: 0.95,
    POSITIVE_COLOR: '#c0392b',
    NEGATIVE_COLOR: '#27ae60',
    DEBOUNCE_MS: 400,
    POLL_FAST_MS: 600,
    POLL_SLOW_MS: 3000,
    POLL_SLOW_AFTER_MS: 120000,
  };

  const MARK_EST = 'data-jsl-estimate-95';
  const MARK_PREM = 'data-jsl-premium-95';
  const MARK_HEADER_EST = 'data-jsl-estimate-header-95';
  const MARK_HEADER_PREM = 'data-jsl-premium-header-95';

  let debounceTimer = null;
  let bodyObserver = null;
  let hashListenerBound = false;
  let enhancing = false;
  let pollTimer = null;
  let pollStartedAt = 0;
  /** @type {Record<string, number>|null} */
  let frozenColMap = null;

  const status = {
    version: '1.4.1',
    pageOk: false,
    rootFound: false,
    headerFound: false,
    bodyFound: false,
    ready: false,
    colMap: null,
    sessionDay: '',
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

  /** 集思录无指数涨幅（跨市场等，如日经 ETF 显示 -） */
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

  function calcEstimate(nav, indexRatio) {
    if (nav == null || indexRatio == null || nav <= 0) return null;
    return nav * (1 + indexRatio * CONFIG.STOCK_RATIO);
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

  /** 周一至周五=当天；周六日=上周五（节假日未单独处理） */
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
      const md = t.match(/^(\d{1,2})[-/.](\d{1,2})$/);
      if (!md) return null;
      m = Number(md[1]);
      d = Number(md[2]);
      if (!refSessionYmd) return null;
      const [refY, refM, refD] = refSessionYmd.split('-').map(Number);
      y = inferYearForMonthDay(m, d, refY, refM, refD);
    }

    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return ymdToString(y, m, d);
  }

  function isNavCoversSessionDay(navDateYmd, sessionDayYmd) {
    if (!navDateYmd || !sessionDayYmd) return false;
    return navDateYmd >= sessionDayYmd;
  }

  function isActivePage() {
    if (!window.location.pathname.includes('/data/qdii')) return false;
    const hash = window.location.hash || '';
    return hash === CONFIG.HASH || hash.startsWith(CONFIG.HASH + '&');
  }

  /** 解析 FlexGrid：表头与表体可能是两个 table */
  function resolveGrid() {
    const root = document.getElementById(CONFIG.TABLE_ROOT_ID);
    if (!root) return null;

    if (root.tagName === 'TABLE') {
      return {
        root,
        headerTable: root,
        bodyTable: root,
      };
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
      return { root: grid, headerTable: headerTable || t, bodyTable: t };
    }

    return {
      root: grid,
      headerTable: headerTable || bodyTable,
      bodyTable: bodyTable || headerTable,
    };
  }

  function getHeaderRow(headerTable) {
    if (!headerTable) return null;
    const thead = headerTable.querySelector('thead');
    if (!thead) {
      const tr = headerTable.querySelector('tr');
      return tr || null;
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
    const map = {};
    const ths = headerRow.querySelectorAll('th');
    ths.forEach((th, i) => {
      if (th.hasAttribute(MARK_HEADER_EST) || th.hasAttribute(MARK_HEADER_PREM)) {
        return;
      }
      const label = headerLabel(th);
      if (!label) return;
      if (label.includes('指数涨幅')) map.indexPct = i;
      else if (label === '现价' || label.endsWith('现价')) map.price = i;
      else if (label === '名称' || label.includes('名称')) map.name = i;
      else if (label.includes('净值日期')) map.navDate = i;
      else if (label.includes('净值') && !label.includes('溢价')) map.nav = i;
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
    let style = document.querySelector('style[data-jsl-lof-estimate-styles]');
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('data-jsl-lof-estimate-styles', 'true');
      document.head.appendChild(style);
    }
    style.textContent = `
      th[${MARK_HEADER_EST}], th[${MARK_HEADER_PREM}],
      td[${MARK_EST}], td[${MARK_PREM}] {
        text-align: center; white-space: nowrap;
        width: 1%; min-width: 72px; max-width: 88px;
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
        font-size: 14px !important;
        line-height: 1.2;
        text-shadow: 0 1px 0 rgba(0,0,0,.15);
      }
      th[${MARK_HEADER_PREM}] { cursor: pointer; user-select: none; }
      #jsl-lof-estimate-refresh {
        margin: 4px 0; padding: 4px 12px; font-size: 12px; cursor: pointer;
        border: 1px solid #86c5e3; background: #f0f9ff; border-radius: 3px;
      }
      #jsl-lof-estimate-status {
        position: fixed; left: 8px; bottom: 8px; z-index: 99999;
        max-width: 420px; font-size: 11px; line-height: 1.45;
        background: rgba(255,255,255,0.96); border: 1px solid #86c5e3;
        border-radius: 6px; padding: 8px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.12);
        color: #333;
      }
      #jsl-lof-estimate-status .ok { color: #15803d; }
      #jsl-lof-estimate-status .err { color: #b45309; }
    `;
  }

  function updateStatusPanel() {
    injectStyles();
    let el = document.getElementById('jsl-lof-estimate-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'jsl-lof-estimate-status';
      document.body.appendChild(el);
    }
    const lines = [
      `<b>亚洲市场估值脚本 v${status.version}</b>`,
      `页面: ${status.pageOk ? '<span class="ok">亚洲市场 #qdiia ✓</span>' : '<span class="err">请打开 亚洲市场 (#qdiia)</span>'}`,
      `容器 #flex_qdiia: ${status.rootFound ? '✓' : '✗ 未找到'}`,
      `表头 table: ${status.headerFound ? '✓' : '✗'}`,
      `表体 table: ${status.bodyFound ? '✓' : '✗'}`,
      `数据就绪: ${status.ready ? '✓' : '等待加载…'}`,
      status.colMap
        ? `列映射: 净值=#${status.colMap.nav} 指数=#${status.colMap.indexPct} 现价=#${status.colMap.price}`
        : '列映射: 未完成',
      `会话日(沪): ${status.sessionDay || getSessionDayYmd()}`,
      `已处理行: ${status.rows}`,
      status.lastOk ? `<span class="ok">${status.lastOk}</span>` : '',
      status.lastError ? `<span class="err">${status.lastError}</span>` : '',
      '<button type="button" id="jsl-lof-estimate-refresh">立即插入/刷新两列</button>',
    ].filter(Boolean);
    el.innerHTML = lines.join('<br>');
    const btn = el.querySelector('#jsl-lof-estimate-refresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        frozenColMap = null;
        runEnhance(true);
      });
    }
  }

  function ensureHeaders(headerTable, headerRow, anchorTh, bodyTable) {
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
      '净值 × (1 + 指数涨幅 × 95%)，不含汇率；盘前净值为上一交易日';

    if (!premTh) {
      premTh = document.createElement('th');
      premTh.className = 'header sticky';
      premTh.setAttribute(MARK_HEADER_PREM, 'true');
      estTh.after(premTh);
      premTh.addEventListener('click', () => sortByPremium(bodyTable));
    }
    syncPremiumHeaderLabel(premTh);
    premTh.title = '(现价 − 实时估值) / 实时估值 × 100%';
  }

  function syncPremiumHeaderLabel(premTh) {
    const span = premTh.querySelector('.jsl-prem-sort-indicator');
    const sortMark = span ? span.textContent : '';
    premTh.innerHTML =
      CONFIG.PREMIUM_HEADER +
      ' <span class="jsl-prem-sort-indicator">' +
      sortMark +
      '</span>';
  }

  function getCustomColumnIndexes(headerRow) {
    const estTh = headerRow.querySelector(`th[${MARK_HEADER_EST}]`);
    const premTh = headerRow.querySelector(`th[${MARK_HEADER_PREM}]`);
    return {
      estIdx: estTh ? Array.from(headerRow.children).indexOf(estTh) : -1,
      premIdx: premTh ? Array.from(headerRow.children).indexOf(premTh) : -1,
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
      const nav =
        colMap.nav != null ? parseNumber(cells[colMap.nav]?.textContent) : null;
      const navDateRaw =
        colMap.navDate != null ? cells[colMap.navDate]?.textContent : null;
      const navDateYmd = parseNavDateYmd(navDateRaw, sessionDayYmd);
      const navPublished = isNavCoversSessionDay(navDateYmd, sessionDayYmd);
      const indexRaw =
        colMap.indexPct != null ? cells[colMap.indexPct]?.textContent : null;
      const indexUnavailable = isIndexUnavailable(indexRaw);
      const indexR = indexUnavailable ? null : parsePercent(indexRaw);

      const { estIdx } = getCustomColumnIndexes(headerRow);
      const pair = ensureBodyCells(row, estIdx);
      if (!pair) return false;

      const { estCell, premCell } = pair;

      if (indexUnavailable) {
        setBothUnavailable(
          estCell,
          premCell,
          [
            name ? `名称: ${name}` : '',
            '不计算原因: 指数涨幅不可用（如跨市场品种显示 -）',
            '实时估值、实时溢价率均无法按指数模型估算',
          ]
            .filter(Boolean)
            .join('\n')
        );
        return true;
      }

      if (navPublished) {
        setBothUnavailable(
          estCell,
          premCell,
          [
            `名称: ${name || '--'}`,
            `会话日(沪): ${sessionDayYmd}`,
            `净值日期: ${navDateYmd || (navDateRaw || '').trim() || '--'}`,
            '不计算原因: 净值日期已不早于会话日，表格净值已含该会话及之前行情',
            '再乘指数涨幅会重复计价；实时估值与相对该估算的实时溢价率均无意义',
            '（可参考表内 IOPV/净值溢价率等官方列）',
          ].join('\n')
        );
        return true;
      }

      const estimate = calcEstimate(nav, indexR);
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
        `净值日期: ${navDateYmd || (navDateRaw || '').trim() || '--'}`,
        `现价: ${price ?? '--'}`,
        `净值: ${nav ?? '--'}`,
        `指数涨幅: ${(indexRaw || '').trim() || '--'}`,
        `实时估值 = 净值 × (1 + 指数涨幅 × ${CONFIG.STOCK_RATIO})`,
        estimate != null ? `= ${formatEstimate(estimate, false)}` : '',
        `实时溢价率 = (现价 - 实时估值) / 实时估值`,
        premium != null ? `= ${formatPremium(premium, false)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      estCell.title = tip;
      premCell.title = tip;

      return true;
    } catch (err) {
      console.warn('[集思录LOF估值] 单行处理跳过:', err);
      return false;
    }
  }

  let sortDir = null;

  function sortByPremium(bodyTable) {
    const tbody = bodyTable.querySelector('tbody');
    const grid = resolveGrid();
    const headerRow = grid ? getHeaderRow(grid.headerTable) : null;
    if (!tbody || !headerRow) return;

    sortDir = sortDir === null ? 'desc' : sortDir === 'desc' ? 'asc' : null;
    const indicator = headerRow.querySelector('.jsl-prem-sort-indicator');
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

  function disconnectBodyObserver() {
    if (bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
  }

  function enhanceGrid() {
    status.pageOk = isActivePage();
    status.rootFound = false;
    status.headerFound = false;
    status.bodyFound = false;
    status.ready = false;
    status.lastError = '';
    status.rows = 0;

    if (!status.pageOk) {
      status.lastError = '当前不是亚洲市场 Tab，请点顶部「亚洲市场」';
      updateStatusPanel();
      return false;
    }

    const grid = resolveGrid();
    if (!grid) {
      status.lastError = '未找到 #flex_qdiia，请等表格加载或刷新页面';
      updateStatusPanel();
      return false;
    }

    status.rootFound = true;
    status.headerFound = !!grid.headerTable;
    status.bodyFound = !!grid.bodyTable;

    if (!grid.headerTable || !grid.bodyTable) {
      status.lastError = 'FlexGrid 表头/表体未分离成功，见 Console';
      console.warn('[集思录LOF估值] grid', grid);
      updateStatusPanel();
      return false;
    }

    if (!tableReady(grid)) {
      status.lastError = '表格数据未就绪（可能仍在加载）';
      updateStatusPanel();
      return false;
    }

    status.ready = true;
    const headerRow = getHeaderRow(grid.headerTable);
    if (!headerRow) {
      status.lastError = '找不到表头行';
      updateStatusPanel();
      return false;
    }

    let colMap = frozenColMap;
    if (!colMap) {
      colMap = buildColumnMap(headerRow);
      if (colMap.nav == null || colMap.indexPct == null) {
        const labels = Array.from(headerRow.querySelectorAll('th')).map(headerLabel);
        status.lastError =
          '列映射失败，表头文字: ' + labels.slice(0, 16).join(' | ');
        console.warn('[集思录LOF估值] 表头', labels, colMap);
        updateStatusPanel();
        return false;
      }
      frozenColMap = { ...colMap };
    }
    status.colMap = colMap;

    disconnectBodyObserver();
    try {
      const anchor = findAnchorHeader(headerRow, colMap);
      if (!anchor) {
        status.lastError = '找不到插入列的位置';
        return false;
      }
      ensureHeaders(grid.headerTable, headerRow, anchor, grid.bodyTable);

      const sessionDayYmd = getSessionDayYmd();
      status.sessionDay = sessionDayYmd;

      const rows = grid.bodyTable.querySelectorAll('tbody tr');
      rows.forEach((row) => {
        if (fillRow(row, colMap, headerRow, sessionDayYmd)) status.rows++;
      });

      status.lastOk =
        status.rows > 0
          ? `已插入两列并计算 ${status.rows} 行（LOF/ETF 同算法）`
          : '表头已插入，但未处理到数据行';
    } finally {
      observeBody(grid.bodyTable, grid.headerTable, colMap);
    }

    updateStatusPanel();
    return true;
  }

  function observeBody(bodyTable, headerTable, colMap) {
    disconnectBodyObserver();
    const tbody = bodyTable.querySelector('tbody');
    if (!tbody) return;
    const headerRow = getHeaderRow(headerTable);

    bodyObserver = new MutationObserver((mutations) => {
      let refresh = false;
      for (const m of mutations) {
        if (m.type !== 'childList') continue;
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && node.tagName === 'TR') {
            fillRow(node, colMap, headerRow, getSessionDayYmd());
            refresh = true;
          }
        }
      }
      if (refresh) {
        status.rows = bodyTable.querySelectorAll(`td[${MARK_EST}]`).length;
        updateStatusPanel();
      }
    });
    bodyObserver.observe(tbody, { childList: true, subtree: false });
  }

  function scheduleEnhance() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => runEnhance(false), CONFIG.DEBOUNCE_MS);
  }

  function runEnhance(force) {
    if (enhancing && !force) return;
    enhancing = true;
    try {
      enhanceGrid();
    } catch (err) {
      status.lastError = '异常: ' + err.message;
      console.error('[集思录LOF估值]', err);
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
        frozenColMap = null;
        sortDir = null;
        disconnectBodyObserver();
        runEnhance(true);
      });
      hashListenerBound = true;
    }
  }

  init();
  console.log('[集思录LOF估值] v1.3.1 — 无指数涨幅显示 -');
})();
