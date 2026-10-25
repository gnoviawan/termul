import { dlopen, FFIType, ptr, read, toArrayBuffer } from 'bun:ffi'

/**
 * Windows counterparts of the /proc reads in proc-sampler.ts and
 * thread-sampler.ts, through kernel32 and ntdll. Times are in 100 ns units
 * (FILETIME), so `TICKS_PER_S` replaces CLK_TCK.
 *
 * Windows has no PSS. `pss` carries the private working set (Task Manager's
 * Memory column), which, like PSS, is resident memory that counts no page
 * shared with another process. `rss` is the whole working set, which counts
 * shared pages once per process, as RSS does.
 */

export const TICKS_PER_S = 10_000_000

const {
  u32,
  ptr: P,
  i32
} = {
  u32: FFIType.u32,
  ptr: FFIType.ptr,
  i32: FFIType.i32
}

const k32 = dlopen('kernel32.dll', {
  CreateToolhelp32Snapshot: { args: [u32, u32], returns: P },
  Process32FirstW: { args: [P, P], returns: i32 },
  Process32NextW: { args: [P, P], returns: i32 },
  Thread32First: { args: [P, P], returns: i32 },
  Thread32Next: { args: [P, P], returns: i32 },
  OpenProcess: { args: [u32, i32, u32], returns: P },
  OpenThread: { args: [u32, i32, u32], returns: P },
  CloseHandle: { args: [P], returns: i32 },
  GetProcessTimes: { args: [P, P, P, P, P], returns: i32 },
  GetThreadTimes: { args: [P, P, P, P, P], returns: i32 },
  K32GetProcessMemoryInfo: { args: [P, P, u32], returns: i32 },
  GetSystemTimes: { args: [P, P, P], returns: i32 },
  GetThreadDescription: { args: [P, P], returns: i32 },
  LocalFree: { args: [P], returns: P }
})
const nt = dlopen('ntdll.dll', {
  NtQueryInformationProcess: { args: [P, u32, P, u32, P], returns: i32 }
})
const k = k32.symbols

const TH32CS_SNAPPROCESS = 0x2
const TH32CS_SNAPTHREAD = 0x4
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const THREAD_QUERY_LIMITED_INFORMATION = 0x0800
const ProcessCommandLineInformation = 60
const INVALID_HANDLE = 0xffffffffffffffffn

const isValid = (h: unknown) => h !== null && h !== 0 && BigInt(h as number) !== INVALID_HANDLE

/** pid → parent pid and image name, from one Toolhelp snapshot of every process. */
export function processTable(): Map<number, { ppid: number; exe: string }> {
  const out = new Map<number, { ppid: number; exe: string }>()
  const snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (!isValid(snap)) return out
  // PROCESSENTRY32W: dwSize@0, th32ProcessID@8, th32ParentProcessID@32, szExeFile@44.
  const entry = new Uint8Array(568)
  const view = new DataView(entry.buffer)
  view.setUint32(0, entry.length, true)
  try {
    for (
      let ok = k.Process32FirstW(snap, ptr(entry));
      ok;
      ok = k.Process32NextW(snap, ptr(entry))
    ) {
      const name = new Uint16Array(entry.buffer, 44, 260)
      const end = name.indexOf(0)
      out.set(view.getUint32(8, true), {
        ppid: view.getUint32(32, true),
        exe: String.fromCharCode(...name.subarray(0, end < 0 ? 260 : end))
      })
    }
  } finally {
    k.CloseHandle(snap)
  }
  return out
}

function withProcess<T>(pid: number, fallback: T, body: (h: number) => T): T {
  const h = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (!isValid(h)) return fallback
  try {
    return body(h as number)
  } finally {
    k.CloseHandle(h)
  }
}

/** Kernel plus user time of a process, in 100 ns ticks; null once it exited. */
export function processTicks(pid: number): number | null {
  const t = new BigUint64Array(4)
  return withProcess(pid, null, (h) =>
    k.GetProcessTimes(h, ptr(t), ptr(t, 8), ptr(t, 16), ptr(t, 24)) ? Number(t[2] + t[3]) : null
  )
}

/** FILETIME counts 100 ns ticks from 1601-01-01; this is that epoch in Unix ms. */
const FILETIME_UNIX_OFFSET_MS = 11_644_473_600_000

/** When a process was created, in Unix epoch ms; null once it exited. */
export function processCreatedMs(pid: number): number | null {
  const t = new BigUint64Array(4)
  return withProcess(pid, null, (h) =>
    k.GetProcessTimes(h, ptr(t), ptr(t, 8), ptr(t, 16), ptr(t, 24))
      ? Number(t[0] / 10_000n) - FILETIME_UNIX_OFFSET_MS
      : null
  )
}

export function processMem(pid: number): { rss: number; pss: number } {
  // PROCESS_MEMORY_COUNTERS_EX2: WorkingSetSize@16, PrivateWorkingSetSize@80, size 96.
  const pmc = new BigUint64Array(12)
  new DataView(pmc.buffer).setUint32(0, 96, true)
  return withProcess(pid, { rss: 0, pss: 0 }, (h) =>
    k.K32GetProcessMemoryInfo(h, ptr(pmc), 96)
      ? { rss: Number(pmc[2]), pss: Number(pmc[10]) }
      : { rss: 0, pss: 0 }
  )
}

export function processCmdline(pid: number): string {
  return withProcess(pid, '', (h) => {
    const size = new Uint32Array(1)
    nt.symbols.NtQueryInformationProcess(h, ProcessCommandLineInformation, null, 0, ptr(size))
    if (!size[0]) return ''
    const buf = new Uint8Array(size[0])
    if (
      nt.symbols.NtQueryInformationProcess(
        h,
        ProcessCommandLineInformation,
        ptr(buf),
        buf.length,
        ptr(size)
      ) !== 0
    )
      return ''
    // UNICODE_STRING { u16 Length; u16 MaximumLength; PWSTR Buffer@8 }; the text follows in buf.
    const len = new DataView(buf.buffer).getUint16(0, true)
    const text = read.ptr(ptr(buf), 8)
    return Buffer.from(toArrayBuffer(text, 0, len)).toString('utf16le')
  })
}

/** Busy and total core-time of the whole machine, in 100 ns ticks. */
export function systemTicks(): { busy: number; total: number } {
  const idle = new BigUint64Array(1)
  const kernel = new BigUint64Array(1)
  const user = new BigUint64Array(1)
  k.GetSystemTimes(ptr(idle), ptr(kernel), ptr(user))
  // Kernel time includes idle time.
  const total = Number(kernel[0] + user[0])
  return { busy: total - Number(idle[0]), total }
}

/** Kernel plus user ticks and description of every thread owned by `pids`, keyed `pid/tid`. */
export function threadTicks(pids: Set<number>): Map<string, { comm: string; ticks: number }> {
  const out = new Map<string, { comm: string; ticks: number }>()
  const snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
  if (!isValid(snap)) return out
  // THREADENTRY32: dwSize@0, th32ThreadID@8, th32OwnerProcessID@12, size 28.
  const entry = new Uint8Array(28)
  const view = new DataView(entry.buffer)
  view.setUint32(0, entry.length, true)
  const t = new BigUint64Array(4)
  const desc = new BigUint64Array(1)
  try {
    for (let ok = k.Thread32First(snap, ptr(entry)); ok; ok = k.Thread32Next(snap, ptr(entry))) {
      const pid = view.getUint32(12, true)
      if (!pids.has(pid)) continue
      const tid = view.getUint32(8, true)
      const h = k.OpenThread(THREAD_QUERY_LIMITED_INFORMATION, 0, tid)
      if (!isValid(h)) continue
      try {
        if (!k.GetThreadTimes(h, ptr(t), ptr(t, 8), ptr(t, 16), ptr(t, 24))) continue
        let comm = `tid${tid}`
        if ((k.GetThreadDescription(h, ptr(desc)) as number) >= 0 && desc[0]) {
          const p = Number(desc[0])
          let n = 0
          while (read.u16(p, n * 2) !== 0 && n < 256) n++
          if (n) comm = Buffer.from(toArrayBuffer(p, 0, n * 2)).toString('utf16le')
          k.LocalFree(p)
        }
        out.set(`${pid}/${tid}`, { comm, ticks: Number(t[2] + t[3]) })
      } finally {
        k.CloseHandle(h)
      }
    }
  } finally {
    k.CloseHandle(snap)
  }
  return out
}
