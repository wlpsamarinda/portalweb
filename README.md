# Wonderland Samarinda — Website

Website resmi **wonderlandsamarinda.com**.

| Bagian | Teknologi | Lokasi |
|---|---|---|
| Tampilan website (frontend) | HTML/CSS/JS statis + PWA | `frontend/` → Cloudflare Worker `wonderlandsamarindapages` |
| Data & pesanan (backend) | Google Apps Script + Google Sheet | `apps-script/` |

```
Pengunjung → wonderlandsamarinda.com (Cloudflare) → fetch → Apps Script Web App (/exec) → Google Sheet
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

## 2. Frontend: hubungkan ke API

Buka `frontend/index.html`, cari `const API_URL = "";` lalu isi dengan URL `/exec` dari langkah 5.

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

## Catatan keamanan

- Harga selalu dihitung ulang di Apps Script dari sheet; harga dari browser diabaikan.
- Jangan simpan password atau kunci rahasia di `frontend/` (semua isinya publik).
- Google Sheet cocok untuk volume pesanan kecil–menengah. Untuk pembayaran online & e-ticket QR skala besar, ikuti rencana fase 4 di dokumen perencanaan.
