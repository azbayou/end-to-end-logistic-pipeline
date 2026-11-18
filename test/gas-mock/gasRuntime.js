'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const util = require('node:util');
const crypto = require('node:crypto');

const DEFAULT_SPREADSHEET_ID = '1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU';

const CANONICAL_GS_ORDER = [
  'Config.gs',
  'SheetRepo.gs',
  'OperationsService.gs',
  'DashboardService.gs',
  'WebApp.gs'
];

const DEFAULT_ORDER_HEADERS = [
  'order_id',
  'resi',
  'shipper_id',
  'return_flag',
  'status',
  'current_hub',
  'destination_address',
  'destination_hub',
  'inbound_date',
  'end_date'
];

const DEFAULT_SHIPPER_HEADERS = [
  'shipper_id',
  'shipper_name',
  'pickup_address'
];

const DEFAULT_REPORT_HEADERS = [
  'order_id',
  'resi',
  'shipper_name',
  'pickup_address',
  'status',
  'return_flag',
  'current_hub_location',
  'destination_hub_location',
  'destination_address',
  'inbound_date',
  'end_date',
  'Aging Parcel',
  'Aging Type'
];

const DEFAULT_L1_FORMULA =
  '=ARRAYFORMULA(\nIFS(ROW(J:J)=1, "Aging Parcel",\nJ:J="", "",\nK:K<>"",K:K-J:J,\nTRUE,Prototype!$P$1 - J:J))';
const DEFAULT_M1_FORMULA =
  '=ARRAYFORMULA(\nIFS(ROW(J:J)=1, "Aging Type",\nA:A="", "",\nJ:J="", "Not Inbounded",\nL:L<8,"Under SLA",\nTRUE,"Over SLA"))';

function isDateLike(val) {
  return (
    util.types.isDate(val) ||
    Object.prototype.toString.call(val) === '[object Date]'
  );
}

function cloneCellValue(val) {
  if (val === null || val === undefined) {
    return '';
  }
  if (isDateLike(val)) {
    return new Date(val.getTime());
  }
  if (
    typeof val === 'number' ||
    typeof val === 'string' ||
    typeof val === 'boolean'
  ) {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(cloneCellValue);
  }
  return String(val);
}

function isNonEmptyCell(cell) {
  return Boolean(
    cell &&
      (cell.f !== '' ||
        (cell.v !== '' && cell.v !== null && cell.v !== undefined))
  );
}

function colLettersToNumber(letters) {
  let num = 0;
  const upper = letters.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    num = num * 26 + (upper.charCodeAt(i) - 64);
  }
  return num;
}

function colNumberToLetters(col) {
  let n = col;
  let res = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    res = String.fromCharCode(65 + rem) + res;
    n = Math.floor((n - 1) / 26);
  }
  return res;
}

function normalizeTimeZone(tz) {
  if (!tz) return 'Asia/Bangkok';
  const raw = String(tz).trim();
  const upper = raw.toUpperCase();
  if (upper === 'GMT' || upper === 'UTC') return 'UTC';
  if (upper === 'GMT+7' || upper === 'UTC+7' || upper === 'GMT+07:00' || upper === 'UTC+07:00') {
    return 'Asia/Bangkok';
  }
  return raw;
}

function formatDateWithPattern(date, timeZone, pattern) {
  if (!isDateLike(date) && typeof date?.getTime !== 'function') {
    throw new Error('Utilities.formatDate requires a valid Date object.');
  }
  const timeMs = date.getTime();
  if (isNaN(timeMs)) {
    throw new Error('Utilities.formatDate received an Invalid Date.');
  }

  const tz = normalizeTimeZone(timeZone);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const partsMap = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') {
      partsMap[part.type] = part.value;
    }
  }

  const yearNum = parseInt(partsMap.year, 10);
  const monthNum = parseInt(partsMap.month, 10);
  const dayNum = parseInt(partsMap.day, 10);
  const hourNum = parseInt(partsMap.hour, 10) % 24;
  const minuteNum = parseInt(partsMap.minute, 10);
  const secondNum = parseInt(partsMap.second, 10);
  const msNum = ((timeMs % 1000) + 1000) % 1000;

  const wallUtcMs = Date.UTC(
    yearNum,
    monthNum - 1,
    dayNum,
    hourNum,
    minuteNum,
    secondNum
  );
  const actualSecMs = Math.floor(timeMs / 1000) * 1000;
  const offsetMin = Math.round((wallUtcMs - actualSecMs) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, '0');
  const offM = String(absMin % 60).padStart(2, '0');

  const tokens = {
    yyyy: String(yearNum).padStart(4, '0'),
    yy: String(yearNum).slice(-2).padStart(2, '0'),
    MM: String(monthNum).padStart(2, '0'),
    M: String(monthNum),
    dd: String(dayNum).padStart(2, '0'),
    d: String(dayNum),
    HH: String(hourNum).padStart(2, '0'),
    H: String(hourNum),
    mm: String(minuteNum).padStart(2, '0'),
    m: String(minuteNum),
    ss: String(secondNum).padStart(2, '0'),
    s: String(secondNum),
    SSS: String(msNum).padStart(3, '0'),
    XXX: offsetMin === 0 ? 'Z' : `${sign}${offH}:${offM}`,
    XX: offsetMin === 0 ? 'Z' : `${sign}${offH}${offM}`,
    X: offsetMin === 0 ? 'Z' : `${sign}${offH}`,
    Z: `${sign}${offH}${offM}`
  };

  let out = '';
  let i = 0;
  const pat = String(pattern || "yyyy-MM-dd'T'HH:mm:ssXXX");
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === "'") {
      if (pat[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      let j = i + 1;
      let lit = '';
      while (j < pat.length) {
        if (pat[j] === "'") {
          if (pat[j + 1] === "'") {
            lit += "'";
            j += 2;
            continue;
          }
          break;
        }
        lit += pat[j];
        j += 1;
      }
      out += lit;
      i = j + 1;
      continue;
    }

    if (/[A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < pat.length && pat[j] === ch) {
        j += 1;
      }
      const tok = pat.slice(i, j);
      out += Object.prototype.hasOwnProperty.call(tokens, tok) ? tokens[tok] : tok;
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createSheetModel(name, sheetId, initialValues, initialFormulas, gridProps) {
  const rows = [];
  let frozenRows = (gridProps && gridProps.frozenRowCount) || 0;
  let maxRows = Math.max(
    (gridProps && gridProps.rowCount) || 1000,
    Array.isArray(initialValues) ? initialValues.length : 0
  );

  function ensureRow(rIdx) {
    while (rows.length <= rIdx) {
      rows.push([]);
    }
    if (rIdx + 1 > maxRows) {
      maxRows = rIdx + 1;
    }
  }

  function setCell(rIdx, cIdx, val, formula) {
    ensureRow(rIdx);
    const row = rows[rIdx];
    while (row.length < cIdx) {
      row.push({ v: '', f: '' });
    }
    row[cIdx] = {
      v: val === null || val === undefined ? '' : cloneCellValue(val),
      f: formula ? String(formula) : ''
    };
  }

  if (Array.isArray(initialValues)) {
    for (let r = 0; r < initialValues.length; r++) {
      const srcRow = initialValues[r] || [];
      for (let c = 0; c < srcRow.length; c++) {
        const raw = srcRow[c];
        if (typeof raw === 'string' && raw.startsWith('=')) {
          setCell(r, c, '', raw);
        } else {
          setCell(r, c, raw, '');
        }
      }
    }
  }

  if (Array.isArray(initialFormulas)) {
    for (let r = 0; r < initialFormulas.length; r++) {
      const fRow = initialFormulas[r];
      if (!Array.isArray(fRow)) continue;
      for (let c = 0; c < fRow.length; c++) {
        const f = fRow[c];
        if (typeof f === 'string' && f.startsWith('=')) {
          ensureRow(r);
          while (rows[r].length <= c) {
            rows[r].push({ v: '', f: '' });
          }
          rows[r][c].f = f;
        }
      }
    }
  }

  function getLastRow() {
    for (let r = rows.length - 1; r >= 0; r--) {
      const row = rows[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        if (isNonEmptyCell(row[c])) {
          return r + 1;
        }
      }
    }
    return 0;
  }

  function getLastColumn() {
    const lr = getLastRow();
    let maxCol = 0;
    for (let r = 0; r < lr; r++) {
      const row = rows[r];
      if (!row) continue;
      for (let c = row.length - 1; c >= 0; c--) {
        if (isNonEmptyCell(row[c])) {
          if (c + 1 > maxCol) maxCol = c + 1;
          break;
        }
      }
    }
    return maxCol;
  }

  function createRange(startRow, startCol, numRows, numCols) {
    if (
      !Number.isInteger(startRow) ||
      !Number.isInteger(startCol) ||
      !Number.isInteger(numRows) ||
      !Number.isInteger(numCols) ||
      startRow < 1 ||
      startCol < 1 ||
      numRows < 1 ||
      numCols < 1
    ) {
      throw new Error(
        `Invalid range coordinates: (${startRow}, ${startCol}, ${numRows}, ${numCols})`
      );
    }

    const rangeObj = {
      getRow() {
        return startRow;
      },
      getColumn() {
        return startCol;
      },
      getNumRows() {
        return numRows;
      },
      getNumColumns() {
        return numCols;
      },
      getA1Notation() {
        const tl = `${colNumberToLetters(startCol)}${startRow}`;
        if (numRows === 1 && numCols === 1) return tl;
        const br = `${colNumberToLetters(startCol + numCols - 1)}${startRow + numRows - 1}`;
        return `${tl}:${br}`;
      },
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const rowArr = [];
          const srcRow = rows[startRow - 1 + r];
          for (let c = 0; c < numCols; c++) {
            const cell = srcRow && srcRow[startCol - 1 + c];
            rowArr.push(cell ? cloneCellValue(cell.v) : '');
          }
          out.push(rowArr);
        }
        return out;
      },
      getValue() {
        return rangeObj.getValues()[0][0];
      },
      setValues(values) {
        if (!Array.isArray(values) || values.length !== numRows) {
          throw new Error(
            `Range.setValues row count mismatch: expected ${numRows}, got ${
              Array.isArray(values) ? values.length : typeof values
            }`
          );
        }
        for (let r = 0; r < numRows; r++) {
          const srcRow = values[r];
          if (!Array.isArray(srcRow) || srcRow.length !== numCols) {
            throw new Error(
              `Range.setValues column count mismatch at row ${r}: expected ${numCols}, got ${
                Array.isArray(srcRow) ? srcRow.length : typeof srcRow
              }`
            );
          }
        }
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            const val = values[r][c];
            if (typeof val === 'string' && val.startsWith('=')) {
              setCell(startRow - 1 + r, startCol - 1 + c, '', val);
            } else {
              setCell(startRow - 1 + r, startCol - 1 + c, val, '');
            }
          }
        }
        return rangeObj;
      },
      setValue(val) {
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            if (typeof val === 'string' && val.startsWith('=')) {
              setCell(startRow - 1 + r, startCol - 1 + c, '', val);
            } else {
              setCell(startRow - 1 + r, startCol - 1 + c, val, '');
            }
          }
        }
        return rangeObj;
      },
      getFormulas() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const rowArr = [];
          const srcRow = rows[startRow - 1 + r];
          for (let c = 0; c < numCols; c++) {
            const cell = srcRow && srcRow[startCol - 1 + c];
            rowArr.push(cell && cell.f ? cell.f : '');
          }
          out.push(rowArr);
        }
        return out;
      },
      getFormula() {
        return rangeObj.getFormulas()[0][0];
      },
      setFormula(formula) {
        const fStr = formula === null || formula === undefined ? '' : String(formula);
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            setCell(startRow - 1 + r, startCol - 1 + c, '', fStr);
          }
        }
        return rangeObj;
      },
      setFormulas(formulas) {
        if (!Array.isArray(formulas) || formulas.length !== numRows) {
          throw new Error('Range.setFormulas row count mismatch.');
        }
        for (let r = 0; r < numRows; r++) {
          if (!Array.isArray(formulas[r]) || formulas[r].length !== numCols) {
            throw new Error('Range.setFormulas column count mismatch.');
          }
          for (let c = 0; c < numCols; c++) {
            const fStr =
              formulas[r][c] === null || formulas[r][c] === undefined
                ? ''
                : String(formulas[r][c]);
            setCell(startRow - 1 + r, startCol - 1 + c, '', fStr);
          }
        }
        return rangeObj;
      },
      clearContent() {
        for (let r = 0; r < numRows; r++) {
          const rowIdx = startRow - 1 + r;
          const row = rows[rowIdx];
          if (!row) continue;
          for (let c = 0; c < numCols; c++) {
            const colIdx = startCol - 1 + c;
            if (colIdx < row.length) {
              row[colIdx] = { v: '', f: '' };
            }
          }
        }
        return rangeObj;
      },
      clear() {
        return rangeObj.clearContent();
      },
      setNumberFormat() {
        return rangeObj;
      },
      setFontWeight() {
        return rangeObj;
      },
      setBackground() {
        return rangeObj;
      }
    };
    return rangeObj;
  }

  function parseA1Range(a1Input) {
    let spec = String(a1Input).trim();
    const bangIdx = spec.lastIndexOf('!');
    if (bangIdx !== -1) {
      const sheetPrefix = spec.slice(0, bangIdx).replace(/^'|'$/g, '');
      if (sheetPrefix && sheetPrefix !== name) {
        throw new Error(
          `Range sheet prefix "${sheetPrefix}" does not match target sheet "${name}".`
        );
      }
      spec = spec.slice(bangIdx + 1).trim();
    }
    const clean = spec.replace(/\$/g, '');
    const parts = clean.split(':');
    if (parts.length > 2) {
      throw new Error(`Invalid A1 notation: ${a1Input}`);
    }

    const parseEndpoint = (token) => {
      const m = /^([A-Za-z]+)?(\d+)?$/.exec(token.trim());
      if (!m || (!m[1] && !m[2])) {
        throw new Error(`Invalid A1 endpoint: ${token}`);
      }
      return {
        col: m[1] ? colLettersToNumber(m[1]) : null,
        row: m[2] ? parseInt(m[2], 10) : null
      };
    };

    const start = parseEndpoint(parts[0]);
    if (parts.length === 1) {
      if (start.row && start.col) {
        return [start.row, start.col, 1, 1];
      }
      if (start.col && !start.row) {
        return [1, start.col, Math.max(1, getLastRow()), 1];
      }
      if (start.row && !start.col) {
        return [start.row, 1, 1, Math.max(1, getLastColumn())];
      }
    }

    const end = parseEndpoint(parts[1]);
    const lr = Math.max(1, getLastRow());
    const lc = Math.max(1, getLastColumn());

    const r1 = start.row || 1;
    const c1 = start.col || 1;
    const r2 = end.row || Math.max(r1, lr);
    const c2 = end.col || Math.max(c1, lc);

    const top = Math.min(r1, r2);
    const bottom = Math.max(r1, r2);
    const left = Math.min(c1, c2);
    const right = Math.max(c1, c2);

    return [top, left, Math.max(1, bottom - top + 1), Math.max(1, right - left + 1)];
  }

  const sheetObj = {
    getName() {
      return name;
    },
    getSheetId() {
      return sheetId;
    },
    getLastRow,
    getLastColumn,
    getMaxRows() {
      return maxRows;
    },
    insertRowAfter(afterPosition) {
      return sheetObj.insertRowsAfter(afterPosition, 1);
    },
    insertRowsAfter(afterPosition, howMany) {
      const count = Number.isInteger(howMany) && howMany > 0 ? howMany : 1;
      maxRows += count;
      if (afterPosition < rows.length) {
        const blanks = Array.from({ length: count }, () => []);
        rows.splice(afterPosition, 0, ...blanks);
      }
      return sheetObj;
    },
    getFrozenRows() {
      return frozenRows;
    },
    setFrozenRows(n) {
      frozenRows = Number(n) || 0;
      return sheetObj;
    },
    getDataRange() {
      const lr = getLastRow();
      const lc = getLastColumn();
      if (lr === 0 || lc === 0) {
        return createRange(1, 1, 1, 1);
      }
      return createRange(1, 1, lr, lc);
    },
    getRange(rowOrA1, col, numRows, numCols) {
      if (typeof rowOrA1 === 'string' && col === undefined) {
        const [r, c, nr, nc] = parseA1Range(rowOrA1);
        return createRange(r, c, nr, nc);
      }
      return createRange(
        rowOrA1,
        col,
        numRows === undefined ? 1 : numRows,
        numCols === undefined ? 1 : numCols
      );
    },
    appendRow(rowContents) {
      if (!Array.isArray(rowContents) || rowContents.length < 1) {
        throw new Error('Sheet.appendRow requires a non-empty array.');
      }
      const targetRowIdx = getLastRow();
      for (let c = 0; c < rowContents.length; c++) {
        const val = rowContents[c];
        if (typeof val === 'string' && val.startsWith('=')) {
          setCell(targetRowIdx, c, '', val);
        } else {
          setCell(targetRowIdx, c, val, '');
        }
      }
      return sheetObj;
    },
    clear() {
      rows.length = 0;
      return sheetObj;
    },
    clearContents() {
      rows.length = 0;
      return sheetObj;
    }
  };

  return sheetObj;
}

function createGasRuntime(options = {}) {
  const srcDir = options.srcDir || path.resolve(__dirname, '../../src');
  const activeUserEmail =
    options.activeUserEmail !== undefined
      ? options.activeUserEmail
      : 'operator@example.com';
  const hasActiveSpreadsheet =
    options.hasActiveSpreadsheet !== undefined
      ? Boolean(options.hasActiveSpreadsheet)
      : true;
  const nowFn =
    typeof options.now === 'function' ? options.now : () => new Date();

  let snapshotData = null;
  if (options.snapshotPath) {
    const raw = fs.readFileSync(options.snapshotPath, 'utf8');
    snapshotData = JSON.parse(raw);
  }

  const spreadsheetId =
    options.spreadsheetId ||
    (snapshotData && snapshotData.spreadsheetId) ||
    DEFAULT_SPREADSHEET_ID;
  const spreadsheetName =
    (snapshotData && snapshotData.properties && snapshotData.properties.title) ||
    'Logistic Performance Xpress';

  const sheetsMap = new Map();
  let nextSheetId = 1000;

  function setSheetFromSpec(title, spec) {
    if (Array.isArray(spec)) {
      sheetsMap.set(title, createSheetModel(title, nextSheetId++, spec, null, null));
      return;
    }
    const values = spec.values || [];
    let formulas = spec.formulas || null;
    if (!formulas && Array.isArray(spec.row1Formulas)) {
      formulas = [spec.row1Formulas];
    }
    const sid = spec.sheetId || nextSheetId++;
    sheetsMap.set(
      title,
      createSheetModel(title, sid, values, formulas, spec.gridProperties || null)
    );
  }

  if (snapshotData && snapshotData.sheets) {
    for (const [title, spec] of Object.entries(snapshotData.sheets)) {
      setSheetFromSpec(title, spec);
    }
  }

  if (options.sheets && typeof options.sheets === 'object') {
    for (const [title, spec] of Object.entries(options.sheets)) {
      setSheetFromSpec(title, spec);
    }
  }

  if (Array.isArray(options.ordersRows)) {
    const rows =
      options.ordersRows[0] && options.ordersRows[0][0] === 'order_id'
        ? options.ordersRows
        : [DEFAULT_ORDER_HEADERS, ...options.ordersRows];
    setSheetFromSpec('db_orders', rows);
  }

  if (Array.isArray(options.shippersRows)) {
    const rows =
      options.shippersRows[0] && options.shippersRows[0][0] === 'shipper_id'
        ? options.shippersRows
        : [DEFAULT_SHIPPER_HEADERS, ...options.shippersRows];
    setSheetFromSpec('db_shippers', rows);
  }

  if (Array.isArray(options.reportRows) || Array.isArray(options.reportFormulas)) {
    const rows = Array.isArray(options.reportRows)
      ? options.reportRows[0] && options.reportRows[0][0] === 'order_id'
        ? options.reportRows
        : [DEFAULT_REPORT_HEADERS, ...options.reportRows]
      : [DEFAULT_REPORT_HEADERS];
    const formulas = Array.isArray(options.reportFormulas)
      ? options.reportFormulas
      : [
          [
            '', '', '', '', '', '', '', '', '', '', '',
            DEFAULT_L1_FORMULA,
            DEFAULT_M1_FORMULA
          ]
        ];
    setSheetFromSpec('order_report', { values: rows, formulas });
  }

  if (Array.isArray(options.opLogsRows)) {
    setSheetFromSpec('op_logs', options.opLogsRows);
  }

  // Ensure baseline sheets exist in clean empty runtime mode
  if (!sheetsMap.has('db_orders')) {
    setSheetFromSpec('db_orders', [DEFAULT_ORDER_HEADERS]);
  }
  if (!sheetsMap.has('db_shippers')) {
    setSheetFromSpec('db_shippers', [DEFAULT_SHIPPER_HEADERS]);
  }
  if (!sheetsMap.has('order_report')) {
    setSheetFromSpec('order_report', {
      values: [DEFAULT_REPORT_HEADERS],
      row1Formulas: [
        '', '', '', '', '', '', '', '', '', '', '',
        DEFAULT_L1_FORMULA,
        DEFAULT_M1_FORMULA
      ]
    });
  }

  const activeBook = {
    getId() {
      return spreadsheetId;
    },
    getName() {
      return spreadsheetName;
    },
    getSpreadsheetTimeZone() {
      return 'Asia/Bangkok';
    },
    getSheets() {
      return Array.from(sheetsMap.values());
    },
    getSheetByName(name) {
      return sheetsMap.get(String(name)) || null;
    },
    insertSheet(name) {
      let targetName;
      if (name === undefined || name === null || String(name).trim() === '') {
        let idx = sheetsMap.size + 1;
        while (sheetsMap.has(`Sheet${idx}`)) idx += 1;
        targetName = `Sheet${idx}`;
      } else {
        targetName = String(name);
        if (sheetsMap.has(targetName)) {
          throw new Error(
            `A sheet with the name "${targetName}" already exists. Please enter another name.`
          );
        }
      }
      const created = createSheetModel(targetName, nextSheetId++, [], null, null);
      sheetsMap.set(targetName, created);
      return created;
    }
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet() {
      return hasActiveSpreadsheet ? activeBook : null;
    },
    openById(id) {
      if (!id || id === spreadsheetId) {
        return activeBook;
      }
      throw new Error(
        `Unexpected error while getting the method or property openById on object SpreadsheetApp. Invalid id: ${id}`
      );
    },
    flush() {}
  };

  // LockService state & simulation hooks
  let lockFailureRemaining = 0; // -1 = indefinite, 0 = normal, >0 = countdown
  let lockFailureMessage = '';
  const lockStats = {
    waitCalls: 0,
    tryCalls: 0,
    acquireCount: 0,
    releaseCount: 0,
    hasLock: false
  };

  function shouldFailLock() {
    if (lockFailureRemaining === -1) return true;
    if (lockFailureRemaining > 0) {
      lockFailureRemaining -= 1;
      return true;
    }
    return false;
  }

  function createLockInstance() {
    return {
      waitLock(timeoutInMillis) {
        lockStats.waitCalls += 1;
        if (typeof options.onWaitLock === 'function') {
          options.onWaitLock(timeoutInMillis, { ...lockStats });
        }
        if (shouldFailLock()) {
          throw new Error(
            lockFailureMessage ||
              `Could not obtain lock after ${timeoutInMillis || 0} ms.`
          );
        }
        lockStats.hasLock = true;
        lockStats.acquireCount += 1;
      },
      tryLock(timeoutInMillis) {
        lockStats.tryCalls += 1;
        if (typeof options.onWaitLock === 'function') {
          options.onWaitLock(timeoutInMillis, { ...lockStats });
        }
        if (shouldFailLock()) {
          return false;
        }
        lockStats.hasLock = true;
        lockStats.acquireCount += 1;
        return true;
      },
      hasLock() {
        return lockStats.hasLock;
      },
      releaseLock() {
        if (lockStats.hasLock) {
          lockStats.hasLock = false;
          lockStats.releaseCount += 1;
        }
      }
    };
  }

  const LockService = {
    getScriptLock: createLockInstance,
    getDocumentLock: createLockInstance,
    getUserLock: createLockInstance
  };

  const Utilities = {
    formatDate(date, timeZone, format) {
      return formatDateWithPattern(date, timeZone, format);
    },
    getUuid() {
      return crypto.randomUUID();
    },
    base64Encode(str) {
      return Buffer.from(String(str), 'utf8').toString('base64');
    },
    base64Decode(b64) {
      return Array.from(Buffer.from(String(b64), 'base64'));
    }
  };

  const Session = {
    getActiveUser() {
      return {
        getEmail() {
          return activeUserEmail;
        }
      };
    },
    getEffectiveUser() {
      return {
        getEmail() {
          return activeUserEmail;
        }
      };
    },
    getScriptTimeZone() {
      return 'Asia/Bangkok';
    }
  };

  const caches = new Map();
  function getNamedCache(scopeName) {
    if (!caches.has(scopeName)) {
      const store = new Map();
      const cacheApi = {
        get(key) {
          const entry = store.get(String(key));
          if (!entry) return null;
          if (entry.expiresAt <= Date.now()) {
            store.delete(String(key));
            return null;
          }
          return entry.value;
        },
        put(key, value, expirationInSeconds = 600) {
          const rawSec =
            expirationInSeconds === undefined || expirationInSeconds === null
              ? 600
              : Number(expirationInSeconds);
          const ttlMs = Math.max(0, Number.isFinite(rawSec) ? rawSec : 600) * 1000;
          store.set(String(key), {
            value: String(value),
            expiresAt: Date.now() + ttlMs
          });
        },
        remove(key) {
          store.delete(String(key));
        },
        getAll(keys) {
          const out = {};
          for (const k of keys || []) {
            const val = cacheApi.get(k);
            if (val !== null) out[k] = val;
          }
          return out;
        },
        putAll(values, expirationInSeconds = 600) {
          for (const [k, v] of Object.entries(values || {})) {
            cacheApi.put(k, v, expirationInSeconds);
          }
        },
        removeAll(keys) {
          for (const k of keys || []) {
            store.delete(String(k));
          }
        }
      };
      caches.set(scopeName, cacheApi);
    }
    return caches.get(scopeName);
  }

  const CacheService = {
    getScriptCache: () => getNamedCache('script'),
    getUserCache: () => getNamedCache('user'),
    getDocumentCache: () => getNamedCache('document')
  };

  const logEntries = [];
  const Logger = {
    log(msg, ...args) {
      const formatted = args.length > 0 ? util.format(msg, ...args) : String(msg);
      logEntries.push(formatted);
      return Logger;
    },
    getLog() {
      return logEntries.join('\n');
    },
    clear() {
      logEntries.length = 0;
    }
  };

  function resolveHtmlFile(filename) {
    const clean = String(filename || '').trim().replace(/\.html$/i, '');
    if (!clean) {
      throw new Error('HtmlService filename cannot be empty.');
    }
    const baseDir = path.resolve(srcDir);
    const candidate = path.resolve(baseDir, `${clean}.html`);
    if (candidate !== baseDir && !candidate.startsWith(baseDir + path.sep)) {
      throw new Error(`HtmlService path traversal rejected: ${filename}`);
    }
    if (!fs.existsSync(candidate)) {
      throw new Error(`No HTML file named "${filename}" was found in ${baseDir}`);
    }
    return fs.readFileSync(candidate, 'utf8');
  }

  function createHtmlOutput(initialHtml) {
    let content = initialHtml === null || initialHtml === undefined ? '' : String(initialHtml);
    let title = '';
    let xFrameOptionsMode = 'DEFAULT';
    const output = {
      setTitle(t) {
        title = String(t || '');
        return output;
      },
      getTitle() {
        return title;
      },
      setXFrameOptionsMode(mode) {
        xFrameOptionsMode = mode;
        return output;
      },
      getXFrameOptionsMode() {
        return xFrameOptionsMode;
      },
      getContent() {
        return content;
      },
      setContent(c) {
        content = String(c || '');
        return output;
      },
      append(str) {
        content += String(str || '');
        return output;
      }
    };
    return output;
  }

  function compileTemplateToJs(rawTemplate) {
    const regex = /<\?(!=|=)?([\s\S]*?)\?>/g;
    let code = 'var __out = [];\nwith (__templateData) {\n';
    let lastIdx = 0;
    let match;

    while ((match = regex.exec(rawTemplate)) !== null) {
      if (match.index > lastIdx) {
        code += `__out.push(${JSON.stringify(rawTemplate.slice(lastIdx, match.index))});\n`;
      }
      const mode = match[1] || '';
      const body = match[2].trim();
      if (mode === '!=') {
        const expr = body.replace(/;\s*$/, '');
        if (expr) {
          code += `__out.push(__rawStr(${expr}));\n`;
        }
      } else if (mode === '=') {
        const expr = body.replace(/;\s*$/, '');
        if (expr) {
          code += `__out.push(__escapeHtml(${expr}));\n`;
        }
      } else if (body) {
        code += `${body}\n`;
      }
      lastIdx = regex.lastIndex;
    }

    if (lastIdx < rawTemplate.length) {
      code += `__out.push(${JSON.stringify(rawTemplate.slice(lastIdx))});\n`;
    }
    code += '}\nreturn __out.join("");';
    return code;
  }

  let context;

  function createTemplate(rawHtml) {
    const templateObj = {
      evaluate() {
        const fnBody = compileTemplateToJs(String(rawHtml || ''));
        context.__templateData = templateObj;
        context.__escapeHtml = escapeHtml;
        context.__rawStr = (v) =>
          v === null || v === undefined ? '' : String(v);
        try {
          const rendered = vm.runInContext(
            `(function(){\n${fnBody}\n})()`,
            context,
            { filename: 'HtmlTemplate.evaluate' }
          );
          return createHtmlOutput(rendered);
        } finally {
          delete context.__templateData;
          delete context.__escapeHtml;
          delete context.__rawStr;
        }
      },
      getRawContent() {
        return String(rawHtml || '');
      }
    };
    return templateObj;
  }

  const HtmlService = {
    XFrameOptionsMode: {
      ALLOWALL: 'ALLOWALL',
      DEFAULT: 'DEFAULT'
    },
    createHtmlOutput,
    createHtmlOutputFromFile(filename) {
      return createHtmlOutput(resolveHtmlFile(filename));
    },
    createTemplate,
    createTemplateFromFile(filename) {
      return createTemplate(resolveHtmlFile(filename));
    }
  };

  // Custom Date wrapper inside sandbox when deterministic clock hook is provided
  const NativeDate = Date;
  function ClockDate(...args) {
    if (!(this instanceof ClockDate)) {
      return new NativeDate(nowFn().getTime()).toString();
    }
    if (args.length === 0) {
      return new NativeDate(nowFn().getTime());
    }
    return new NativeDate(...args);
  }
  ClockDate.UTC = NativeDate.UTC;
  ClockDate.parse = NativeDate.parse;
  ClockDate.now = () => nowFn().getTime();
  ClockDate.prototype = NativeDate.prototype;

  const sandbox = {
    SpreadsheetApp,
    LockService,
    Utilities,
    Session,
    HtmlService,
    CacheService,
    Logger,
    console,
    Date: typeof options.now === 'function' ? ClockDate : Date
  };

  context = vm.createContext(sandbox);

  const loadedFiles = [];
  if (fs.existsSync(srcDir)) {
    const entries = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith('.gs'));
    entries.sort((a, b) => {
      const idxA = CANONICAL_GS_ORDER.indexOf(a);
      const idxB = CANONICAL_GS_ORDER.indexOf(b);
      if (idxA !== -1 && idxB !== -1) return idxA - idxB;
      if (idxA !== -1) return -1;
      if (idxB !== -1) return 1;
      return a.localeCompare(b);
    });

    for (const file of entries) {
      const fullPath = path.join(srcDir, file);
      const code = fs.readFileSync(fullPath, 'utf8');
      vm.runInContext(code, context, { filename: fullPath });
      loadedFiles.push(file);
    }
  }

  const vmObjectPrototype = vm.runInContext('Object.prototype', context);

  function resolveFunction(fnName) {
    if (typeof fnName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fnName)) {
      return undefined;
    }
    if (
      Object.prototype.hasOwnProperty.call(context, fnName) &&
      typeof context[fnName] === 'function'
    ) {
      return context[fnName];
    }
    try {
      const candidate = vm.runInContext(
        `(typeof ${fnName} === "function" ? ${fnName} : undefined)`,
        context
      );
      if (typeof candidate !== 'function') {
        return undefined;
      }
      if (
        (Object.prototype.hasOwnProperty.call(Object.prototype, fnName) &&
          candidate === Object.prototype[fnName]) ||
        (Object.prototype.hasOwnProperty.call(vmObjectPrototype, fnName) &&
          candidate === vmObjectPrototype[fnName])
      ) {
        return undefined;
      }
      return candidate;
    } catch (_err) {
      return undefined;
    }
  }

  return {
    invoke(fnName, ...args) {
      if (typeof fnName !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(fnName)) {
        throw new Error(`Invalid GAS function name: ${fnName}`);
      }
      const fn = resolveFunction(fnName);
      if (!fn) {
        throw new Error(`GAS function "${fnName}" is not defined.`);
      }
      return fn.apply(context, args);
    },
    hasFunction(fnName) {
      return Boolean(resolveFunction(fnName));
    },
    getSheetData(sheetName) {
      const sheet = sheetsMap.get(String(sheetName));
      if (!sheet || sheet.getLastRow() === 0) {
        return [];
      }
      return sheet.getDataRange().getValues();
    },
    getSheetFormulas(sheetName) {
      const sheet = sheetsMap.get(String(sheetName));
      if (!sheet || sheet.getLastRow() === 0) {
        return [];
      }
      return sheet.getDataRange().getFormulas();
    },
    hasSheet(sheetName) {
      return sheetsMap.has(String(sheetName));
    },
    getLogs() {
      return [...logEntries];
    },
    simulateLockFailure(countOrBool, message) {
      lockFailureMessage = message ? String(message) : '';
      if (countOrBool === true) {
        lockFailureRemaining = -1;
      } else if (typeof countOrBool === 'number' && countOrBool > 0) {
        lockFailureRemaining = Math.floor(countOrBool);
      } else {
        lockFailureRemaining = 0;
        lockFailureMessage = '';
      }
    },
    getLockStats() {
      return { ...lockStats };
    },
    loadedFiles,
    context
  };
}

module.exports = { createGasRuntime };
