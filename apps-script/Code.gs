/**
 * WONDERLAND SAMARINDA — API Website (Google Apps Script)
 * --------------------------------------------------------
 * Fungsi:
 *   GET  ?action=catalog  -> daftar tiket, wahana, bundling (dari Google Sheet)
 *   POST {action:"order"} -> catat pesanan ke sheet "Pesanan", balas nomor booking
 *   GET  ?action=health   -> cek API hidup
 *
 * DATABASE: Google Spreadsheet yang DIBUAT OTOMATIS oleh script ini.
 *   - Tidak perlu membuat spreadsheet manual. Script berdiri sendiri (standalone).
 *   - Saat pertama dijalankan, script membuat file "Wonderland Website DB" di Google Drive
 *     pemilik script, lengkap dengan semua sheet, header, dan data awal.
 *   - ID file disimpan di Script Properties (DB_SPREADSHEET_ID). Jika file terhapus,
 *     script otomatis membuat ulang yang baru.
 *   - Sheet yang hilang (terhapus tidak sengaja) juga dibuat ulang otomatis.
 *
 * Cara pakai pertama kali:
 *   1. Buka script.google.com > New project, tempel file ini (dan appsscript.json).
 *   2. Jalankan fungsi setup() sekali (izinkan akses). Lihat Execution log:
 *      link spreadsheet database yang baru dibuat tampil di sana.
 *   3. Deploy > New deployment > Web app
 *        Execute as : Me
 *        Who has access : Anyone
 *      Salin URL /exec -> isi ke GAS_URL di wrangler.jsonc (bukan di frontend)
 *   4. Setiap mengubah kode: Deploy > Manage deployments > Edit > Version: New version
 *      (URL tetap sama).
 *
 * Harga dihitung ulang di server dari sheet — harga yang dikirim browser diabaikan.
 *
 * KEAMANAN (anti-spam):
 *   - Status awal setiap order "MENUNGGU KONFIRMASI": jangan diproses sebelum dikonfirmasi via WA / DP.
 *   - Daftar hitam (sheet DaftarHitam): nomor WA, nama, atau IP yang terdaftar ditolak otomatis.
 *     Ubah status order menjadi SPAM -> nomor & IP-nya otomatis masuk daftar hitam.
 *   - Batas per nomor WA per hari (cek dari sheet Pesanan, tidak bisa diakali dengan ganti IP).
 *   - Lonjakan order (> batas_order_per_menit) -> captcha Turnstile diwajibkan untuk semua.
 *   - Order HANYA diterima dari Cloudflare Worker (gerbang website) yang mengirim
 *     kunci rahasia ORDER_SECRET. Order langsung ke URL /exec ditolak.
 *     Jalankan setup() -> salin ORDER_SECRET dari Execution log -> simpan sebagai
 *     secret GAS_SECRET di Cloudflare (Settings > Variables and Secrets).
 *   - Batas: per IP, per nomor WA, total per jam, dan order kembar ditolak.
 *   - Teks yang diawali = + - @ dinetralkan agar tidak dijalankan sebagai rumus.
 *   - Saklar darurat: sheet Pengaturan, kunci "pesanan_aktif" = FALSE -> semua order ditolak.
 */

const SHEETS = {
  SETTINGS: 'Pengaturan',
  TICKETS: 'Tiket',
  RIDES: 'Wahana',
  BUNDLES: 'Bundling',
  HOLIDAYS: 'HariLibur',
  ORDERS: 'Pesanan',
  ORDER_ITEMS: 'PesananDetail',
  BLACKLIST: 'DaftarHitam'
};
const TZ = 'Asia/Makassar'; // WITA
const MAX_ITEMS = 30;
const MAX_QTY = 100;
const MAX_DAYS_AHEAD = 90;
const DB_NAME = 'Wonderland Website DB';
const DB_PROP = 'DB_SPREADSHEET_ID';
const SCHEMA_VERSION = '3';

/* Batas anti-spam */
const LIMIT = {
  PER_IP: 3, PER_IP_WINDOW: 30 * 60,          // maks 3 order per IP per 30 menit
  PER_PHONE_DAY: 3,                           // maks order per nomor WA per hari (bisa diubah di Pengaturan)
  PER_MINUTE: 5,                              // > 5 order/menit (seluruh web) -> captcha wajib untuk semua
  GLOBAL: 40, GLOBAL_WINDOW: 3600,            // batas keras: maks 40 order total per jam
  DUPLICATE_WINDOW: 15 * 60,                  // order kembar (WA + isi sama) ditolak 15 menit
  MAX_TOTAL_QTY: 150,                         // maks total tiket per order
  EMAIL_PER_HOUR: 15                          // maks email notifikasi per jam
};

/* ================= HTTP ================= */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'health';
  try {
    if (action === 'catalog') return json_(Object.assign({ ok: true }, getCatalog_()));
    if (action === 'health') return json_({ ok: true, service: 'wonderland-api', time: new Date().toISOString() });
    return json_({ ok: false, error: 'Aksi tidak dikenal' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Terjadi kesalahan server' });
  }
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || '{}';
    if (raw.length > 20000) return json_({ ok: false, error: 'Permintaan terlalu besar' });
    const body = JSON.parse(raw);
    if (!checkSecret_(body.secret)) return json_({ ok: false, error: 'Tidak diizinkan' });
    if (body.action === 'order') return json_(createOrder_(body));
    return json_({ ok: false, error: 'Aksi tidak dikenal' });
  } catch (err) {
    console.error(err);
    const msg = err && err.userMessage ? err.userMessage : 'Terjadi kesalahan server';
    return json_({ ok: false, error: msg, code: (err && err.code) || '' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function userError_(msg) {
  const e = new Error(msg);
  e.userMessage = msg;
  return e;
}

/* ================= CATALOG ================= */

function getCatalog_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('catalog');
  if (hit) return JSON.parse(hit);

  const tickets = readRows_(SHEETS.TICKETS)
    .filter(r => isTrue_(r.aktif))
    .sort(byOrder_)
    .map(r => ({
      id: String(r.id), name: String(r.nama),
      weekday: Number(r.harga_weekday), weekend: Number(r.harga_weekend || r.harga_weekday),
      holiday: Number(r.harga_libur || r.harga_weekend || r.harga_weekday),
      badge: String(r.badge || ''), photo: String(r.label_foto || r.nama), image: String(r.url_foto || ''),
      includes: String(r.fasilitas || '').split(';').map(s => s.trim()).filter(String)
    }));
  const rides = readRows_(SHEETS.RIDES)
    .filter(r => isTrue_(r.aktif))
    .sort(byOrder_)
    .map(r => ({ id: String(r.id), name: String(r.nama), price: Number(r.harga), status: String(r.status || 'Buka'), image: String(r.url_foto || '') }));
  const bundles = readRows_(SHEETS.BUNDLES)
    .filter(r => isTrue_(r.aktif))
    .sort(byOrder_)
    .map(r => ({ id: String(r.id), name: String(r.nama), price: Number(r.harga), normal: Number(r.harga_normal) }));
  const holidays = readRows_(SHEETS.HOLIDAYS).map(r => toIsoDate_(r.tanggal)).filter(String);

  const data = { tickets: tickets, rides: rides, bundles: bundles, holidays: holidays };
  cache.put('catalog', JSON.stringify(data), 300); // 5 menit
  return data;
}

/** Jalankan setelah mengubah harga di sheet agar website langsung memakai harga baru. */
function clearCatalogCache() {
  CacheService.getScriptCache().remove('catalog');
}

/** Dipanggil trigger "on edit" yang dipasang otomatis ke spreadsheet database. */
function onDbEdit(e) {
  try {
    const name = e && e.range && e.range.getSheet().getName();
    if ([SHEETS.TICKETS, SHEETS.RIDES, SHEETS.BUNDLES, SHEETS.HOLIDAYS].indexOf(name) >= 0) clearCatalogCache();
    if (name === SHEETS.ORDERS && e.range.getColumn() <= 8 && e.range.getLastColumn() >= 8 && e.range.getRow() > 1)
      blacklistFromOrderRows_(e.range.getSheet(), e.range.getRow(), e.range.getNumRows());
  } catch (err) { /* abaikan */ }
}

/* ================= ORDER ================= */

function createOrder_(body) {
  if (/^(false|tidak|no|0)$/i.test(getSetting_('pesanan_aktif').trim()))
    throw userError_('Pemesanan online sedang ditutup sementara. Silakan hubungi kami via WhatsApp.');

  const name = String(body.name || '').replace(/\s+/g, ' ').trim();
  const phone = normalizePhone_(body.phone);
  const items = Array.isArray(body.items) ? body.items : [];
  const ip = String(body.ip || '').slice(0, 64);
  const verified = body.verified === true; // lolos Turnstile (diverifikasi di Worker)
  if (name.length < 2 || name.length > 60) throw userError_('Nama pemesan wajib diisi (2–60 huruf)');
  if (!/^[\p{L}][\p{L} .,'’\-]*$/u.test(name) || /(https?:|www\.|\.com|\.id\b)/i.test(name))
    throw userError_('Nama hanya boleh berisi huruf');
  if (!phone) throw userError_('Nomor WhatsApp tidak valid');
  if (/^08(\d)\1{7,}$/.test(phone)) throw userError_('Nomor WhatsApp tidak valid');
  if (!items.length) throw userError_('Keranjang kosong');
  if (items.length > MAX_ITEMS) throw userError_('Terlalu banyak item');
  const totalQty = items.reduce((s, it) => s + (Math.floor(Number(it && it.qty)) || 0), 0);
  if (totalQty > LIMIT.MAX_TOTAL_QTY) throw userError_('Jumlah tiket terlalu banyak. Untuk rombongan, hubungi kami via WhatsApp.');

  const catalog = getCatalog_();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const maxDate = Utilities.formatDate(new Date(Date.now() + MAX_DAYS_AHEAD * 864e5), TZ, 'yyyy-MM-dd');

  const lines = items.map(it => {
    const type = String(it.type || '');
    const id = String(it.id || '');
    const qty = Math.floor(Number(it.qty));
    const date = String(it.date || '');
    if (!(qty >= 1 && qty <= MAX_QTY)) throw userError_('Jumlah tidak valid');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > maxDate) throw userError_('Tanggal kunjungan tidak valid');

    let product, price, label;
    if (type === 'T') {
      product = catalog.tickets.find(t => t.id === id);
      if (!product) throw userError_('Tiket tidak ditemukan');
      const dayType = dayType_(date, catalog.holidays);
      price = dayType === 'LIBUR' ? product.holiday : dayType === 'WEEKEND' ? product.weekend : product.weekday;
      label = product.name;
    } else if (type === 'R') {
      product = catalog.rides.find(r => r.id === id);
      if (!product) throw userError_('Wahana tidak ditemukan');
      if (product.status !== 'Buka') throw userError_(product.name + ' sedang ' + product.status.toLowerCase());
      price = product.price; label = product.name;
    } else if (type === 'B') {
      product = catalog.bundles.find(b => b.id === id);
      if (!product) throw userError_('Paket bundling tidak ditemukan');
      price = product.price; label = 'Bundling: ' + product.name;
    } else {
      throw userError_('Jenis produk tidak valid');
    }
    return { type: type, id: id, name: label, qty: qty, date: date, price: price, subtotal: price * qty };
  });

  const total = lines.reduce((s, l) => s + l.subtotal, 0);
  const visitDates = Array.from(new Set(lines.map(l => l.date))).sort().join(', ');
  const source = String(body.source || 'direct').slice(0, 100) + (ip ? ' | IP ' + ip : '');
  const fingerprint = phone + '|' + lines.map(l => l.type + l.id + l.date + 'x' + l.qty).sort().join(',');

  const ss = db_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    enforceLimits_(ip, phone, fingerprint, verified);
    if (isBlacklisted_(phone, name, ip))
      throw userError_('Pesanan tidak dapat diproses. Silakan hubungi kami via WhatsApp.');
    const maxPerDay = Number(getSetting_('maks_order_per_nomor_per_hari')) || LIMIT.PER_PHONE_DAY;
    if (ordersTodayByPhone_(phone) >= maxPerDay)
      throw userError_('Nomor WhatsApp ini sudah mencapai batas pesanan hari ini. Admin kami akan menghubungi Anda.');
    const ref = newRef_();
    const now = new Date();
    ss.getSheetByName(SHEETS.ORDERS).appendRow([
      now, ref, safeCell_(name), "'" + phone, visitDates, lines.length, total, 'MENUNGGU KONFIRMASI', safeCell_(source), ''
    ]);
    const detail = ss.getSheetByName(SHEETS.ORDER_ITEMS);
    detail.getRange(detail.getLastRow() + 1, 1, lines.length, 8)
      .setValues(lines.map(l => [ref, l.date, l.type, safeCell_(l.id), safeCell_(l.name), l.qty, l.price, l.subtotal]));
    recordLimits_(ip, phone, fingerprint);
    notifyAdmin_(ref, name, phone, lines, total);
    return { ok: true, ref: ref, total: total, lines: lines.map(l => ({ name: l.name, qty: l.qty, date: l.date, price: l.price, subtotal: l.subtotal })) };
  } finally {
    lock.releaseLock();
  }
}

function newRef_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const prefix = 'WL-' + Utilities.formatDate(new Date(), TZ, 'yyMMdd') + '-';
  const sheet = db_().getSheetByName(SHEETS.ORDERS);
  const last = sheet.getLastRow();
  const existing = last > 1 ? sheet.getRange(Math.max(2, last - 500), 2, Math.min(500, last - 1), 1).getValues().map(r => r[0]) : [];
  for (let i = 0; i < 10; i++) {
    let code = '';
    for (let j = 0; j < 5; j++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    if (existing.indexOf(prefix + code) < 0) return prefix + code;
  }
  throw new Error('Gagal membuat nomor booking');
}

function notifyAdmin_(ref, name, phone, lines, total) {
  const email = getSetting_('email_notifikasi');
  if (!email) return;
  if (counter_('rl_email') >= LIMIT.EMAIL_PER_HOUR) return; // cegah kuota email habis saat banjir order
  bump_('rl_email', 3600);
  try {
    const body = 'Pesanan baru ' + ref + '\n\nNama: ' + name + '\nWA: ' + phone + '\n\n' +
      lines.map(l => '- ' + l.name + ' x' + l.qty + ' (' + l.date + ') = Rp' + l.subtotal.toLocaleString('id-ID')).join('\n') +
      '\n\nTotal: Rp' + total.toLocaleString('id-ID');
    MailApp.sendEmail(email, 'Pesanan baru ' + ref + ' — Wonderland', body);
  } catch (err) { console.error(err); }
}

/* ================= KEAMANAN ================= */

/** Order hanya sah bila membawa kunci yang sama dengan Script Property ORDER_SECRET. */
function checkSecret_(given) {
  const secret = PropertiesService.getScriptProperties().getProperty('ORDER_SECRET');
  if (!secret || typeof given !== 'string' || given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Penghitung sederhana berbasis CacheService (dipanggil di dalam lock). */
function counter_(key) {
  return Number(CacheService.getScriptCache().get(key) || 0);
}
function bump_(key, ttl) {
  const c = CacheService.getScriptCache();
  c.put(key, String(Number(c.get(key) || 0) + 1), ttl);
}
function hashKey_(prefix, v) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(v));
  return prefix + Utilities.base64EncodeWebSafe(d).slice(0, 24);
}

function enforceLimits_(ip, phone, fingerprint, verified) {
  if (counter_('rl_global') >= LIMIT.GLOBAL)
    throw userError_('Sistem sedang menerima terlalu banyak pesanan. Coba lagi nanti atau hubungi kami via WhatsApp.');
  const perMinute = Number(getSetting_('batas_order_per_menit')) || LIMIT.PER_MINUTE;
  if (!verified && counter_('rl_minute') >= perMinute) {
    const e = userError_('Trafik sedang tinggi. Selesaikan verifikasi keamanan lalu kirim ulang.');
    e.code = 'CAPTCHA_REQUIRED';
    throw e;
  }
  if (ip && counter_(hashKey_('rl_ip_', ip)) >= LIMIT.PER_IP)
    throw userError_('Terlalu banyak pesanan dari perangkat ini. Coba lagi 30 menit lagi.');
  if (counter_(hashKey_('dup_', fingerprint)) > 0)
    throw userError_('Pesanan yang sama baru saja dikirim. Cek WhatsApp Anda.');
}

function recordLimits_(ip, phone, fingerprint) {
  bump_('rl_global', LIMIT.GLOBAL_WINDOW);
  bump_('rl_minute', 60);
  if (ip) bump_(hashKey_('rl_ip_', ip), LIMIT.PER_IP_WINDOW);
  bump_(hashKey_('dup_', fingerprint), LIMIT.DUPLICATE_WINDOW);
}

/** Jumlah order hari ini (WITA) dari nomor WA ini — dibaca dari sheet Pesanan. */
function ordersTodayByPhone_(phone) {
  const sh = db_().getSheetByName(SHEETS.ORDERS);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const n = Math.min(2000, last - 1);
  const rows = sh.getRange(last - n + 1, 1, n, 4).getValues();
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  return rows.filter(r => r[0] instanceof Date &&
    Utilities.formatDate(r[0], TZ, 'yyyy-MM-dd') === today &&
    normalizePhone_(r[3]) === phone).length;
}

/** Cek daftar hitam: jenis = nomor / nama / ip. */
function isBlacklisted_(phone, name, ip) {
  const lname = name.toLowerCase();
  return readRows_(SHEETS.BLACKLIST).some(r => {
    const jenis = String(r.jenis || '').toLowerCase().trim();
    const nilai = String(r.nilai || '').trim();
    if (!nilai) return false;
    if (jenis === 'nomor') return normalizePhone_(nilai) === phone;
    if (jenis === 'nama') return nilai.toLowerCase() === lname;
    if (jenis === 'ip') return ip && nilai === ip;
    return false;
  });
}

function addToBlacklist_(jenis, nilai, alasan) {
  nilai = String(nilai || '').trim();
  if (!nilai) return;
  const sh = db_().getSheetByName(SHEETS.BLACKLIST);
  const exists = readRows_(SHEETS.BLACKLIST).some(r =>
    String(r.jenis).toLowerCase() === jenis && String(r.nilai).trim() === nilai);
  if (!exists) sh.appendRow([jenis, jenis === 'nomor' ? "'" + nilai : safeCell_(nilai), safeCell_(alasan), new Date()]);
}

/** Status order diubah ke SPAM -> nomor WA & IP otomatis masuk daftar hitam. */
function blacklistFromOrderRows_(sheet, startRow, numRows) {
  const rows = sheet.getRange(startRow, 1, numRows, 9).getValues();
  rows.forEach(r => {
    if (String(r[7]).toUpperCase() !== 'SPAM') return;
    const ref = String(r[1]);
    const phone = normalizePhone_(r[3]);
    if (phone) addToBlacklist_('nomor', phone, 'SPAM ' + ref);
    const m = String(r[8]).match(/IP ([0-9a-fA-F.:]+)/);
    if (m) addToBlacklist_('ip', m[1], 'SPAM ' + ref);
  });
}

/** Cegah teks dijalankan sebagai rumus spreadsheet (formula injection). */
function safeCell_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

/** Membuat / mengganti kunci rahasia order. Salin hasilnya ke secret GAS_SECRET di Cloudflare. */
function generateOrderSecret() {
  const secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('ORDER_SECRET', secret);
  console.log('ORDER_SECRET baru (salin ke Cloudflare sebagai GAS_SECRET):\n' + secret);
  return secret;
}

/** Menampilkan kunci rahasia order yang sedang aktif. */
function showOrderSecret() {
  const s = PropertiesService.getScriptProperties().getProperty('ORDER_SECRET') || generateOrderSecret();
  console.log('ORDER_SECRET: ' + s);
  return s;
}

/** Saklar darurat dari editor: tutup / buka pemesanan online. */
function tutupPesanan() { setSetting_('pesanan_aktif', 'FALSE'); console.log('Pemesanan online DITUTUP'); }
function bukaPesanan() { setSetting_('pesanan_aktif', 'TRUE'); console.log('Pemesanan online DIBUKA'); }

function setSetting_(key, value) {
  const sh = db_().getSheetByName(SHEETS.SETTINGS);
  const vals = sh.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === key) { sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value, '']);
}

/* ================= HELPERS ================= */

function readRows_(sheetName) {
  const sheet = db_().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const head = values.shift().map(h => String(h).trim().toLowerCase());
  return values.filter(r => r.join('') !== '').map(r => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function getSetting_(key) {
  const row = readRows_(SHEETS.SETTINGS).find(r => String(r.kunci) === key);
  return row ? String(row.nilai || '') : '';
}

function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE' || String(v).toUpperCase() === 'YA'; }
function byOrder_(a, b) { return Number(a.urutan || 0) - Number(b.urutan || 0); }

function toIsoDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function dayType_(iso, holidays) {
  if (holidays.indexOf(iso) >= 0) return 'LIBUR';
  const p = iso.split('-').map(Number);
  const day = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  return (day === 0 || day === 6) ? 'WEEKEND' : 'WEEKDAY';
}

function normalizePhone_(v) {
  let s = String(v || '').replace(/[\s\-().]/g, '');
  if (s.indexOf('+62') === 0) s = '0' + s.slice(3);
  else if (s.indexOf('62') === 0) s = '0' + s.slice(2);
  return /^08\d{7,12}$/.test(s) ? s : '';
}

/* ================= DATABASE AUTO-GENERATE ================= */

/**
 * Mengembalikan spreadsheet database. Membuatnya otomatis bila belum ada / terhapus,
 * dan melengkapi sheet yang hilang.
 */
function db_() {
  if (db_.cached) return db_.cached;
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(DB_PROP);
  let ss = null;
  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
      if (DriveApp.getFileById(id).isTrashed()) ss = null;
    } catch (err) { ss = null; }
  }
  if (!ss) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      id = props.getProperty(DB_PROP);
      try { if (id && !DriveApp.getFileById(id).isTrashed()) ss = SpreadsheetApp.openById(id); } catch (err) { ss = null; }
      if (!ss) {
        ss = SpreadsheetApp.create(DB_NAME);
        ss.setSpreadsheetTimeZone(TZ);
        props.setProperty(DB_PROP, ss.getId());
        props.deleteProperty('DB_SCHEMA');
        console.log('Database baru dibuat: ' + ss.getUrl());
      }
    } finally {
      lock.releaseLock();
    }
  }
  db_.cached = ss;
  if (props.getProperty('DB_SCHEMA') !== SCHEMA_VERSION + ':' + ss.getId()) ensureSchema_(ss);
  return ss;
}

/** Definisi semua sheet: header + data awal. */
function schema_() {
  return [
    { name: SHEETS.SETTINGS, header: ['kunci', 'nilai', 'keterangan'], rows: [
      ['email_notifikasi', 'wonderlandsamarinda@gmail.com', 'Email penerima notifikasi pesanan baru (kosongkan untuk mematikan)'],
      ['whatsapp', '6282254335976', 'Nomor WA admin (informasi)'],
      ['pesanan_aktif', 'TRUE', 'FALSE = tutup pemesanan online sementara (saklar darurat)'],
      ['maks_order_per_nomor_per_hari', 3, 'Maks order per nomor WA per hari'],
      ['batas_order_per_menit', 5, 'Lebih dari ini per menit (seluruh web) -> captcha wajib untuk semua']
    ] },
    { name: SHEETS.TICKETS, header: ['id', 'nama', 'harga_weekday', 'harga_weekend', 'harga_libur', 'badge', 'fasilitas', 'label_foto', 'url_foto', 'aktif', 'urutan'], rows: [
      ['REGULER', 'Tiket Reguler', 25000, 30000, 30000, '', 'Kolam Renang; Dino Forest; Kampung Sakura & Kampung Salju; Puluhan spot foto instagramable', 'Kolam Renang', 'img/kolam-renang.webp', true, 1],
      ['TERUSAN', 'Tiket Terusan', 75000, 75000, 75000, 'Favorit keluarga', 'Semua fasilitas Tiket Reguler; Kereta Monorail; Bombom Car; Rainbow Slide', 'Rainbow Slide', 'img/rainbow-slide-2.webp', true, 2],
      ['TERUSAN_PLUS', 'Tiket Terusan Plus', 100000, 100000, 100000, 'Paling puas', 'Semua fasilitas Tiket Reguler; Monorail, Bombom Car, Rainbow Slide; Tamiya Gravity & Playground; Trampolin Jumbo', 'Trampolin Jumbo', 'img/taman-panda.webp', true, 3]
    ] },
    { name: SHEETS.RIDES, header: ['id', 'nama', 'harga', 'status', 'url_foto', 'aktif', 'urutan'], rows: [
      ['monorail', 'Kereta Monorail', 25000, 'Buka', 'img/monorail.webp', true, 1],
      ['bombom', 'Bombom Car', 25000, 'Buka', 'img/bombom-car.webp', true, 2],
      ['rainbow', 'Rainbow Slide', 25000, 'Buka', 'img/rainbow-slide.webp', true, 3],
      ['tamiya', 'Tamiya Gravity', 25000, 'Buka', 'img/tamiya-gravity.webp', true, 4],
      ['playground', 'Playground', 20000, 'Buka', 'img/playground.webp', true, 5],
      ['trampolin', 'Trampolin Jumbo', 15000, 'Buka', 'img/trampolin-jumbo.webp', true, 6],
      ['keretamini', 'Kereta Mini', 10000, 'Buka', 'img/kereta-mini.webp', true, 7]
    ], validations: { D: ['Buka', 'Perawatan', 'Tutup'] }, checkboxes: ['F'] },
    { name: SHEETS.BUNDLES, header: ['id', 'nama', 'harga', 'harga_normal', 'aktif', 'urutan'], rows: [
      ['b1', 'Rainbow Slide + Tamiya Gravity', 40000, 50000, true, 1],
      ['b2', 'Rainbow Slide + Bombom Car', 40000, 50000, true, 2],
      ['b3', 'Monorail + Bombom Car + Trampolin Jumbo', 50000, 65000, true, 3],
      ['b4', 'Tamiya Gravity + Monorail + Rainbow Slide', 60000, 75000, true, 4],
      ['b5', 'Playground + Monorail + Bombom Car', 60000, 70000, true, 5]
    ], checkboxes: ['E'] },
    { name: SHEETS.HOLIDAYS, header: ['tanggal', 'nama'], rows: [], dateCols: ['A'] },
    { name: SHEETS.ORDERS, header: ['waktu', 'no_booking', 'nama', 'whatsapp', 'tanggal_kunjungan', 'jumlah_item', 'total', 'status', 'sumber', 'catatan_admin'], rows: [],
      validations: { H: ['MENUNGGU KONFIRMASI', 'DIBAYAR', 'SELESAI', 'BATAL', 'SPAM'] }, money: ['G'] },
    { name: SHEETS.ORDER_ITEMS, header: ['no_booking', 'tanggal_kunjungan', 'jenis', 'id_produk', 'nama_produk', 'qty', 'harga', 'subtotal'], rows: [], money: ['G', 'H'] },
    { name: SHEETS.BLACKLIST, header: ['jenis', 'nilai', 'alasan', 'ditambahkan'], rows: [],
      validations: { A: ['nomor', 'nama', 'ip'] } }
  ];
}

/** Membuat sheet yang belum ada, dengan header, format, dan data awal. Sheet yang sudah ada tidak diubah isinya. */
function ensureSchema_(ss) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    schema_().forEach(def => {
      let sh = ss.getSheetByName(def.name);
      if (!sh) sh = ss.insertSheet(def.name);
      if (sh.getLastRow() === 0) {
        sh.getRange(1, 1, 1, def.header.length).setValues([def.header])
          .setFontWeight('bold').setBackground('#153E2D').setFontColor('#FFFFFF');
        sh.setFrozenRows(1);
        if (def.rows.length) sh.getRange(2, 1, def.rows.length, def.header.length).setValues(def.rows);
        Object.keys(def.validations || {}).forEach(col => {
          sh.getRange(col + '2:' + col).setDataValidation(
            SpreadsheetApp.newDataValidation().requireValueInList(def.validations[col], true).build());
        });
        (def.checkboxes || []).forEach(col => sh.getRange(col + '2:' + col + Math.max(2, def.rows.length + 1)).insertCheckboxes());
        (def.money || []).forEach(col => sh.getRange(col + '2:' + col).setNumberFormat('"Rp"#,##0'));
        (def.dateCols || []).forEach(col => sh.getRange(col + '2:' + col).setNumberFormat('yyyy-mm-dd'));
        sh.autoResizeColumns(1, def.header.length);
      }
    });
    // Upgrade database lama: lengkapi baris Pengaturan yang belum ada & daftar status
    const setSh = ss.getSheetByName(SHEETS.SETTINGS);
    const keys = setSh.getDataRange().getValues().map(r => String(r[0]));
    schema_()[0].rows.forEach(r => { if (keys.indexOf(r[0]) < 0) setSh.appendRow(r); });
    const ordDef = schema_().find(d => d.name === SHEETS.ORDERS);
    ss.getSheetByName(SHEETS.ORDERS).getRange('H2:H').setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(ordDef.validations.H, true).build());
    // Hapus sheet bawaan kosong ("Sheet1"/"Lembar1")
    ['Sheet1', 'Lembar1'].forEach(n => {
      const d = ss.getSheetByName(n);
      if (d && d.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(d);
    });
    installEditTrigger_(ss);
    PropertiesService.getScriptProperties().setProperty('DB_SCHEMA', SCHEMA_VERSION + ':' + ss.getId());
    CacheService.getScriptCache().remove('catalog');
  } finally {
    lock.releaseLock();
  }
}

/** Pasang trigger agar cache katalog terhapus setiap kali admin mengedit spreadsheet. */
function installEditTrigger_(ss) {
  try {
    const exists = ScriptApp.getProjectTriggers().some(t =>
      t.getHandlerFunction() === 'onDbEdit' && t.getTriggerSourceId() === ss.getId());
    if (!exists) ScriptApp.newTrigger('onDbEdit').forSpreadsheet(ss).onEdit().create();
  } catch (err) {
    console.warn('Trigger edit belum terpasang (jalankan setup() manual sekali): ' + err);
  }
}

/* ================= FUNGSI ADMIN (jalankan dari editor) ================= */

/** Jalankan sekali setelah menempel kode: membuat database & menampilkan link-nya. */
function setup() {
  const ss = db_();
  ensureSchema_(ss);
  console.log('Database siap: ' + ss.getUrl());
  showOrderSecret();
  return ss.getUrl();
}

/** Menampilkan link spreadsheet database di Execution log. */
function getDatabaseUrl() {
  const url = db_().getUrl();
  console.log(url);
  return url;
}

/** Membuat ulang sheet yang hilang tanpa menyentuh data yang ada. */
function repairDatabase() {
  PropertiesService.getScriptProperties().deleteProperty('DB_SCHEMA');
  db_.cached = null;
  return setup();
}
