// A small stand-in for the Apps Script services Code.gs uses, so it can run under Node's test runner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SOURCE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'Code.gs');

export class Clock {
  constructor(now) { this.now = now; }
  advance(ms) { this.now += ms; }
}

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, {sheet, row, col, rows, cols}); }
  setValues(values) {
    if (values.length !== this.rows || values.some((r) => r.length !== this.cols)) throw new Error('setValues: size mismatch');
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.set(this.row + i, this.col + j, v)));
    return this;
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return this; }
  getValue() { return this.sheet.get(this.row, this.col); }
  getValues() {
    return Array.from({length: this.rows}, (_, i) => Array.from({length: this.cols}, (_, j) => this.sheet.get(this.row + i, this.col + j)));
  }
  clearContent() {
    for (let i = 0; i < this.rows; i++) for (let j = 0; j < this.cols; j++) this.sheet.set(this.row + i, this.col + j, '');
    return this;
  }
  setFontWeight() { return this; }
  setFontSize() { return this; }
  setDataValidation(rule) { this.sheet.validation = rule; return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.cells = new Map(); this.lastRow = 0; }
  set(r, c, v) {
    this.cells.set(r + ',' + c, v);
    if (v !== '' && v !== null && v !== undefined) this.lastRow = Math.max(this.lastRow, r);
  }
  get(r, c) { return this.cells.has(r + ',' + c) ? this.cells.get(r + ',' + c) : ''; }
  getRange(a, b, c, d) {
    if (typeof a === 'number') return new Range(this, a, b, c || 1, d || 1);
    const [from, to] = a.split(':').map(parseA1);
    return new Range(this, from.row, from.col, (to || from).row - from.row + 1, (to || from).col - from.col + 1);
  }
  appendRow(values) { const r = this.lastRow + 1; values.forEach((v, j) => this.set(r, j + 1, v)); this.lastRow = r; return this; }
  getLastRow() { return this.lastRow; }
  deleteRows(start, count) {
    const moved = new Map();
    for (const [key, v] of this.cells) {
      const [r, c] = key.split(',').map(Number);
      if (r < start) moved.set(key, v); else if (r >= start + count) moved.set((r - count) + ',' + c, v);
    }
    this.cells = moved;
    this.lastRow -= count;
  }
  setFrozenRows() {}
  setColumnWidth() {}
  rowValues(r, width = 14) { return Array.from({length: width}, (_, j) => this.get(r, j + 1)); }
}

function parseA1(ref) {
  const m = ref.match(/^([A-Z]+)(\d+)$/);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return {row: Number(m[2]), col};
}

export class Spreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const s = new Sheet(name); this.sheets.set(name, s); return s; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/test'; }
}

export class Properties {
  constructor() { this.map = new Map(); }
  getProperty(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setProperty(k, v) {
    if (String(v).length > 9000) throw new Error('property value over 9 KB: ' + k);
    this.map.set(k, String(v));
    return this;
  }
  setProperties(values) { Object.keys(values).forEach((k) => this.setProperty(k, values[k])); return this; }
  deleteProperty(k) { this.map.delete(k); return this; }
  getProperties() { return Object.fromEntries(this.map); }
}

/** Loads Code.gs into a fresh context. `handler(url, params)` answers UrlFetchApp calls with {code, body}. */
export function loadTrader({handler, clock, props = new Properties(), spreadsheet = new Spreadsheet()} = {}) {
  const mails = [];
  const triggers = [];
  const calls = [];
  const ctx = vm.createContext({
    console: {log() {}},
    UrlFetchApp: {
      fetch(url, params) {
        calls.push({url, params});
        const reply = handler(url, params || {});
        return {getResponseCode: () => reply.code, getContentText: () => reply.body};
      }
    },
    Utilities: {
      computeHmacSha256Signature(value, key) {
        return Array.from(crypto.createHmac('sha256', key).update(value, 'utf8').digest(), (b) => (b > 127 ? b - 256 : b));
      },
      sleep(ms) { clock.advance(ms); }
    },
    PropertiesService: {getScriptProperties: () => props},
    LockService: {getScriptLock: () => ({tryLock: () => true, releaseLock() {}})},
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      newDataValidation: () => ({requireValueInList() { return this; }, build() { return {list: true}; }}),
      flush() {}
    },
    MailApp: {sendEmail(to, subject, body) { mails.push({to, subject, body, at: clock.now}); }},
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({getHandlerFunction: () => t.fn})),
      deleteTrigger() { triggers.length = 0; },
      newTrigger: (fn) => ({timeBased: () => ({everyMinutes: (m) => ({create: () => triggers.push({fn, m})})})})
    },
    __clock: clock
  });
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), ctx, {filename: 'Code.gs'});
  vm.runInContext('nowMs = function () { return __clock.now; };', ctx);
  const evaluate = (code) => vm.runInContext(code, ctx);
  return {ctx, evaluate, props, spreadsheet, mails, triggers, calls, clock};
}
