# ADR 0001 — Ripgrep as Tauri Sidecar

- **Status**: Accepted
- **Date**: 2026-05-08
- **Deciders**: Core app maintainers
- **Tags**: tauri, sidecar, search, ripgrep, cross-platform

## Context

Aplikasi membutuhkan pencarian teks cepat dan konsisten lintas platform (Windows, macOS, Linux).

Alternatif awal adalah menjalankan pencarian via shell command umum. Namun pendekatan ini membawa risiko:
- Surface area keamanan lebih besar (arbitrary shell execution).
- Perilaku command dapat berbeda antar OS/environment.
- Packaging binary untuk distribusi desktop jadi kurang deterministik.

`ripgrep (rg)` dipilih karena cepat, stabil, dan umum dipakai untuk file search berbasis regex.

## Decision

Kita menjalankan `ripgrep` sebagai **Tauri sidecar binary**, bukan shell bebas.

### Implementasi keputusan

1. Binary `rg` disimpan di `src-tauri/bin/` per target platform:
   - `rg-x86_64-pc-windows-msvc.exe`
   - `rg-x86_64-unknown-linux-musl`
   - `rg-x86_64-apple-darwin`
   - `rg-aarch64-apple-darwin`

2. Binary didaftarkan di `src-tauri/tauri.conf.json` lewat:
   - `bundle.externalBin`

3. Permission capability ditambahkan di `src-tauri/capabilities/default.json`:
   - `shell:allow-execute`
   - `shell:allow-spawn`
   - `shell:allow-kill`
   - `shell:allow-stdin-write`

4. Pemanggilan `rg` dilakukan via API sidecar Tauri (plugin shell), dengan validasi input path & argumen di backend command.

## Rationale

- **Keamanan lebih baik**: mengurangi kebutuhan shell arbitrary.
- **Deterministik**: versi binary dipin di repo/build artifact.
- **Portabilitas**: perilaku konsisten lintas OS target.
- **Performa**: `rg` sangat cepat untuk recursive search pada codebase besar.

## Consequences

### Positive
- Search feature cepat dan predictable.
- Distribusi aplikasi mencakup dependensi pencarian secara eksplisit.
- Mengurangi masalah “works on my machine” terkait tool sistem.

### Negative / Trade-offs
- Ukuran bundle aplikasi bertambah (karena binary multi-target).
- Perlu maintenance saat upgrade versi `ripgrep`.
- Harus memastikan naming target sesuai ekspektasi Tauri packaging.

## Alternatives Considered

1. **System-installed `rg`**
   - Pro: ukuran bundle lebih kecil.
   - Con: tidak deterministik; dependency eksternal di user machine.

2. **Shell built-in tools (`findstr`, `grep`, `Select-String`)**
   - Pro: tanpa bundling binary tambahan.
   - Con: perilaku dan performa tidak konsisten antar OS.

3. **Pure Rust search implementation internal**
   - Pro: full control.
   - Con: effort lebih besar, reinventing mature tooling.

## Operational Notes

- Saat menambah target platform baru, tambahkan binary target ke `src-tauri/bin` dan `bundle.externalBin`.
- Saat upgrade ripgrep, lakukan smoke test minimal:
  - query regex dasar
  - include/exclude glob
  - path dengan spasi
  - output UTF-8

## Related Files

- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`
- `src-tauri/bin/*`
