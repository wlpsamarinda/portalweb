# Wonderland Samarinda — Website

Website resmi **wonderlandsamarinda.com**.

| Bagian | Teknologi | Lokasi |
|---|---|---|
| Tampilan website (frontend) | HTML/CSS/JS statis + PWA | `frontend/` |
| Gerbang keamanan | Cloudflare Worker (anti-spam, maintenance, header keamanan) | `src/worker.js` |
| Data & pesanan (backend) | Google Apps Script + Google Sheet | `apps-script/` |

```
Pengunjung → wonderlandsamarinda.com → Worker (/api/*: Turnstile, cek bot, kunci rahasia) → Apps Script (/exec) → Google Sheet
```

## 1. Backend: Google Apps Script (database dibuat otomatis)

Tidak perlu membuat Google Sheet manual — script membuat database sendiri.

1. Buka **script.google.com → New project** (login akun Google Wonderland). Beri nama *Wonderland Website API*.
2. Hapus isi `Code.gs`, tempel isi `apps-script/Code.gs`.
3. Project Settings → centang *Show "appsscript.json"*, tempel isi `apps-script/appsscript.json`.
4. Pilih fungsi `setup` → **Run** → izinkan akses (Spreadsheet, Drive, Trigger, Email).
   - Spreadsheet **Wonderland Website DB** otomatis dibuat di Google Drive Anda, lengkap dengan sheet
     Pengaturan, Tiket, Wahana, Bundling, HariLibur, Pesanan, PesananDetail + data awal.
   - Link spreadsheet tampil di **Execution log**. Simpan link itu — dari situlah harga & pesanan dikelola.
5. **Deploy → New deployment → Web app** (Execute as: *Me*, Who has access: *Anyone*) → salin URL berakhiran `/exec`.
6. Tes: buka `URL/exec?action=catalog` di browser, harus tampil JSON.

Fungsi admin (pilih di editor → Run):

| Fungsi | Kegunaan |
|---|---|
| `setup()` | Membuat / melengkapi database, menampilkan link-nya |
| `getDatabaseUrl()` | Lupa link spreadsheet? Jalankan ini, link tampil di log |
| `repairDatabase()` | Sheet terhapus tidak sengaja → dibuat ulang (data lain tidak disentuh) |
| `clearCatalogCache()` | Paksa website menampilkan harga terbaru saat itu juga |

- Jika file spreadsheet terhapus (masuk Sampah), script otomatis membuat database baru saat diakses.
- ID database disimpan di *Project Settings → Script Properties* (`DB_SPREADSHEET_ID`). Untuk memakai spreadsheet lain, ganti nilainya lalu jalankan `repairDatabase()`.

Update kode: **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy** (URL tidak berubah).

## 2. Hubungkan Worker ke Apps Script

URL Apps Script **tidak** ditaruh di `frontend/` lagi. URL itu ada di `wrangler.jsonc` → `vars.GAS_URL`.
Order hanya diterima Apps Script bila membawa kunci rahasia yang sama:

1. Di Apps Script jalankan `showOrderSecret()` → salin kode di Execution log.
2. Cloudflare → Workers & Pages → `wonderlandsamarindapages` → **Settings → Variables and Secrets → Add**
   - Type **Secret**, nama `GAS_SECRET`, isi kode tadi → **Deploy**.

## 3. Deploy otomatis dari GitHub ke Cloudflare

1. Push repo ini ke GitHub (privat).
2. Cloudflare → Workers & Pages → `wonderlandsamarindapages` → **Settings → Build → Connect** → pilih repo ini, branch `main`.
   - Build command: *(kosong)*
   - Deploy command: `npx wrangler deploy`
3. Setiap `git push` ke `main` → website di wonderlandsamarinda.com otomatis ter-update.

## Kelola sehari-hari (tanpa coding)

- **Ubah harga / nama / fasilitas tiket** → sheet `Tiket`.
- **Wahana tutup / perawatan** → sheet `Wahana`, kolom `status` (Buka / Perawatan / Tutup). Wahana yang tidak "Buka" tidak bisa dipesan.
- **Hari libur nasional** (memakai `harga_libur`) → sheet `HariLibur`.
- **Foto produk** → isi kolom `url_foto` dengan link gambar publik.
- **Pesanan masuk** → sheet `Pesanan` (ringkasan) dan `PesananDetail` (per item). Ubah kolom `status` saat sudah dibayar/selesai.
- Perubahan harga tampil di website maksimal 5 menit (cache); langsung bila diedit lewat spreadsheet (trigger otomatis menghapus cache).

## Simpan kode Apps Script di GitHub (opsional, pakai clasp)

```bash
npm i -g @google/clasp
clasp login
cd apps-script
cp .clasp.json.example .clasp.json   # isi scriptId dari Project Settings
clasp push                           # kirim kode dari GitHub ke Apps Script
clasp deploy -i <DEPLOYMENT_ID>      # update deployment tanpa ganti URL
```

## Keamanan & anti-spam

| Lapisan | Fungsi |
|---|---|
| Cloudflare Turnstile | Verifikasi "bukan robot". Mode `auto` (bawaan): muncul untuk semua pengunjung hanya saat order melonjak (> `batas_order_per_menit`). Mode `always`: setiap order |
| Worker `src/worker.js` | Tolak order dari luar website (cek Origin), jebakan bot (field tersembunyi + minimal 2,5 detik mengisi), batas ukuran |
| Kunci rahasia `GAS_SECRET` / `ORDER_SECRET` | Order langsung ke URL `/exec` Apps Script ditolak |
| Apps Script | Daftar hitam (nomor/nama/IP), maks 3 order/nomor WA/hari (ganti IP tidak membantu), maks 3 order/IP/30 menit, batas keras 40 order/jam, order kembar ditolak, validasi nama, netralisir rumus (`=`), email notifikasi maks 15/jam |
| Status order | Semua order masuk sebagai `MENUNGGU KONFIRMASI` — jangan diproses sebelum dikonfirmasi via WA / DP |
| Header keamanan | CSP, anti-clickjacking, HSTS, nosniff |

### Pasang Turnstile (sekali)
1. Cloudflare dashboard → **Turnstile → Add widget**. Nama: `Wonderland`, Hostname: `wonderlandsamarinda.com`, Mode: *Managed* → **Create**.
2. Salin **Site Key** dan **Secret Key**.
3. Worker → **Settings → Variables and Secrets**:
   - `TURNSTILE_SITE_KEY` = Site Key (Type: Text)
   - `TURNSTILE_SECRET` = Secret Key (Type: Secret)

Ingin captcha untuk setiap order? Tambahkan variabel `TURNSTILE_MODE` = `always` di Worker.

### Daftar hitam (sheet `DaftarHitam`)
| jenis | nilai | contoh |
|---|---|---|
| `nomor` | nomor WA | `081234567890` |
| `nama` | nama persis (huruf besar/kecil diabaikan) | `Budi Spam` |
| `ip` | alamat IP dari kolom `sumber` di sheet Pesanan | `103.10.20.30` |

Cara tercepat: ubah status order di sheet `Pesanan` menjadi **SPAM** → nomor WA dan IP order itu otomatis masuk daftar hitam.
Untuk membuka blokir, hapus barisnya dari `DaftarHitam`.

### Atur batas (sheet `Pengaturan`)
- `maks_order_per_nomor_per_hari` (bawaan 3)
- `batas_order_per_menit` (bawaan 5) — lewat dari ini, captcha wajib untuk semua

### Matikan website sementara (maintenance)
- Worker → **Settings → Variables and Secrets** → tambah/ubah `MAINTENANCE` = `1` (Text) → Deploy. Semua pengunjung melihat halaman "sedang perbaikan", order ditolak.
- Buka lagi: ubah `MAINTENANCE` = `0`.
- Opsional: secret `PREVIEW_KEY` = kata sandi bebas → Anda tetap bisa melihat website lewat `https://wonderlandsamarinda.com/?preview=KATASANDI`.

### Tutup pemesanan saja (website tetap tampil)
- Spreadsheet → sheet `Pengaturan` → `pesanan_aktif` = `FALSE` (atau jalankan `tutupPesanan()` / `bukaPesanan()` di Apps Script).

### Bersihkan order spam
- Sheet `Pesanan`: ubah status menjadi `SPAM` (pelaku otomatis diblokir), lalu boleh dihapus barisnya (hapus juga baris dengan nomor booking yang sama di `PesananDetail`).
- Kolom `sumber` mencatat IP pengirim untuk ditelusuri.

### Catatan
- Harga selalu dihitung ulang di Apps Script dari sheet; harga dari browser diabaikan.
- Jangan simpan password atau kunci rahasia di `frontend/` (semua isinya publik). Kunci rahasia hanya di Cloudflare (Secret) dan Script Properties Apps Script.
- Ganti kunci bila bocor: jalankan `generateOrderSecret()` lalu perbarui `GAS_SECRET` di Cloudflare.
