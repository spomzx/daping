'use strict';

const fs = require('fs');
const path = require('path');

/** 项目内 data 目录；可用环境变量 DAPING_DB_PATH 覆盖（勿指向废弃 /home/admin/daping） */
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'dashboard.db');

let _db = null;
let _openFailed = false;

function getDbFilePath() {
  return process.env.DAPING_DB_PATH || DEFAULT_DB_PATH;
}

/**
 * @returns {import('better-sqlite3').Database | null}
 */
function getDb() {
  if (_db) return _db;
  if (_openFailed) return null;
  try {
    const Database = require('better-sqlite3');
    const file = getDbFilePath();
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    _db = new Database(file);
    _db.pragma('journal_mode = WAL');
    return _db;
  } catch (e) {
    _openFailed = true;
    console.error('[dashboard-db] SQLite open failed:', e && e.message ? e.message : e);
    return null;
  }
}

function closeDb() {
  if (_db) {
    try {
      _db.close();
    } catch (_) {
      /* ignore */
    }
    _db = null;
  }
  _openFailed = false;
}

module.exports = { getDb, closeDb, getDbFilePath };
