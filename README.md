# Hi-Ress Lossless — BitChord Addon Server

Addon server untuk BitChord yang menyajikan streaming **FLAC Lossless** dari akun Deezer Premium.

## 🚀 Quick Start

### 1. Ambil ARL Deezer
1. Buka browser tempat kamu login ke **deezer.com** (akun Haiseizuka).
2. Tekan `F12` (Developer Tools).
3. Buka tab **Application** (Chrome/Edge/Brave) atau **Storage** (Firefox) → **Cookies** → `https://www.deezer.com`.
4. Salin isi cookie bernama `arl` (string ~192 karakter).
5. Buka file `.env` di project ini dan tempel:
   ```env
   DEEZER_ARL=paste_arl_kamu_disini
   ```

### 2. Jalankan Server
```bash
npm run dev
```
Server akan aktif di `http://localhost:3000`.

### 3. Sambungkan ke BitChord
1. Pastikan HP dan PC berada di satu jaringan Wi-Fi (atau gunakan Cloudflare Tunnel / Ngrok jika lewat internet).
2. Cek IP lokal PC kamu (`ipconfig` di CMD/PowerShell, contoh: `192.168.1.50`).
3. Buka **BitChord** di HP → **Settings** → **Sources** → **Add an addon**.
4. Masukkan URL: `http://192.168.1.50:3000` (atau URL tunnel kamu).
5. Klik **Test** lalu **Save**.
