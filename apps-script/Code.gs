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
 *      Salin URL /exec -> isi ke API_URL di frontend/index.html
 *   4. Setiap mengubah kode: Deploy > Manage deployments > Edit > Version: New version
 *      (URL tetap sama).
 *
 * Harga dihitung ulang di server dari sheet — harga yang dikirim browser diabaikan.
 */

const SHEETS = {
  SETTINGS: 'Pengaturan',
  TICKETS: 'Tiket',
  RIDES: 'Wahana',
  BUNDLES: 'Bundling',
  HOLIDAYS: 'HariLibur',
  ORDERS: 'Pesanan',
  ORDER_ITEMS: 'PesananDetail'
};
const TZ = 'Asia/Makassar'; // WITA
const MAX_ITEMS = 30;
const MAX_QTY = 100;
const MAX_DAYS_AHEAD = 90;
const DB_NAME = 'Wonderland Website DB';
const DB_PROP = 'DB_SPREADSHEET_ID';
const SCHEMA_VERSION = '1';

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
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'order') return json_(createOrder_(body));
    return json_({ ok: false, error: 'Aksi tidak dikenal' });
  } catch (err) {
    console.error(err);
    const msg = err && err.userMessage ? err.userMessage : 'Terjadi kesalahan server';
    return json_({ ok: false, error: msg });
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
  } catch (err) { /* abaikan */ }
}

/* ================= ORDER ================= */

function createOrder_(body) {
  const name = String(body.name || '').trim().slice(0, 80);
  const phone = normalizePhone_(body.phone);
  const items = Array.isArray(body.items) ? body.items : [];
  if (name.length < 2) throw userError_('Nama pemesan wajib diisi');
  if (!phone) throw userError_('Nomor WhatsApp tidak valid');
  if (!items.length) throw userError_('Keranjang kosong');
  if (items.length > MAX_ITEMS) throw userError_('Terlalu banyak item');

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
  const source = String(body.source || 'direct').slice(0, 120);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ref = newRef_();
    const now = new Date();
    const ss = db_();
    ss.getSheetByName(SHEETS.ORDERS).appendRow([
      now, ref, name, "'" + phone, visitDates, lines.length, total, 'MENUNGGU KONFIRMASI', source, ''
    ]);
    const detail = ss.getSheetByName(SHEETS.ORDER_ITEMS);
    lines.forEach(l => detail.appendRow([ref, l.date, l.type, l.id, l.name, l.qty, l.price, l.subtotal]));
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
  try {
    const body = 'Pesanan baru ' + ref + '\n\nNama: ' + name + '\nWA: ' + phone + '\n\n' +
      lines.map(l => '- ' + l.name + ' x' + l.qty + ' (' + l.date + ') = Rp' + l.subtotal.toLocaleString('id-ID')).join('\n') +
      '\n\nTotal: Rp' + total.toLocaleString('id-ID');
    MailApp.sendEmail(email, 'Pesanan baru ' + ref + ' — Wonderland', body);
  } catch (err) { console.error(err); }
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
      ['whatsapp', '6282254335976', 'Nomor WA admin (informasi)']
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
      validations: { H: ['MENUNGGU KONFIRMASI', 'DIBAYAR', 'SELESAI', 'BATAL'] }, money: ['G'] },
    { name: SHEETS.ORDER_ITEMS, header: ['no_booking', 'tanggal_kunjungan', 'jenis', 'id_produk', 'nama_produk', 'qty', 'harga', 'subtotal'], rows: [], money: ['G', 'H'] }
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
