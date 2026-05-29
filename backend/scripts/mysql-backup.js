#!/usr/bin/env node
'use strict';

/**
 * MySQL 每日备份：mysqldump + gzip，保留最近 N 天（默认 7）。
 *
 * 用法：
 *   node scripts/mysql-backup.js
 *   crontab: 0 3 * * * cd /path/to/backend && node scripts/mysql-backup.js >> logs/backup.log 2>&1
 *
 * 环境变量（与 .env 一致）：
 *   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 *   MYSQL_BACKUP_DIR（默认 backend/backups/mysql）
 *   MYSQL_BACKUP_RETAIN_DAYS（默认 7）
 *   MYSQLDUMP_PATH（默认 mysqldump）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

try {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} catch (_) {}

const { getMysqlConfig, isMysqlConfigured } = require('../config/database');

const retainDays = Math.max(1, Number(process.env.MYSQL_BACKUP_RETAIN_DAYS || 7));
const backupDir =
  process.env.MYSQL_BACKUP_DIR || path.join(__dirname, '..', 'backups', 'mysql');
const mysqldumpBin = process.env.MYSQLDUMP_PATH || 'mysqldump';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function formatStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function rotateBackups(dir, days) {
  const cutoff = Date.now() - days * 86400 * 1000;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql.gz'));
  for (const f of files) {
    const fp = path.join(dir, f);
    try {
      const st = fs.statSync(fp);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        console.log('[mysql-backup] removed old', f);
      }
    } catch (e) {
      console.warn('[mysql-backup] rotate skip', f, e?.message || e);
    }
  }
}

function run() {
  if (!isMysqlConfigured()) {
    console.error('[mysql-backup] MySQL not configured in .env');
    process.exit(1);
  }
  const cfg = getMysqlConfig();
  ensureDir(backupDir);

  const outFile = path.join(backupDir, `${cfg.database}_${formatStamp()}.sql.gz`);
  const args = [
    `-h${cfg.host}`,
    `-P${cfg.port}`,
    `-u${cfg.user}`,
    `--single-transaction`,
    `--routines`,
    `--triggers`,
    `--set-gtid-purged=OFF`,
    cfg.database,
  ];

  console.log('[mysql-backup] dumping to', outFile);
  const dump = spawnSync(mysqldumpBin, args, {
    env: { ...process.env, MYSQL_PWD: cfg.password || '' },
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  });

  if (dump.status !== 0) {
    console.error('[mysql-backup] mysqldump failed:', dump.stderr?.toString() || dump.error);
    process.exit(dump.status || 1);
  }

  const gzip = spawnSync('gzip', ['-c'], { input: dump.stdout, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
  if (gzip.status !== 0) {
    const plainPath = outFile.replace(/\.gz$/, '');
    fs.writeFileSync(plainPath, dump.stdout);
    console.warn('[mysql-backup] gzip unavailable, wrote plain sql:', plainPath);
  } else {
    fs.writeFileSync(outFile, gzip.stdout);
    console.log('[mysql-backup] ok', outFile, `size=${gzip.stdout.length}`);
  }

  rotateBackups(backupDir, retainDays);
}

run();
