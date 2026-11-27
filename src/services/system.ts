import { execFile } from 'node:child_process'
import { statfs } from 'node:fs/promises'
import { loadavg, platform, totalmem, uptime } from 'node:os'
import { promisify } from 'node:util'
import * as si from 'systeminformation'
import type { SystemTelemetry } from '../types/telemetry'

const exec = promisify(execFile)

async function readCommand(path: string, args: string[]) {
  const result = await exec(path, args, {
    timeout: 2000,
    maxBuffer: 256 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  }).catch(() => null)

  return result?.stdout.trim() || null
}

async function metric<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch {
    return null
  }
}

function percentage(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 100
    ? Math.round(value * 100) / 100
    : null
}

function capacity(total: number | null, available: number | null) {
  const totalBytes = total !== null && Number.isSafeInteger(total) && total > 0 ? total : null
  const availableBytes = available !== null && totalBytes !== null &&
    Number.isSafeInteger(available) && available >= 0 && available <= totalBytes
    ? available
    : null
  const usedBytes = totalBytes !== null && availableBytes !== null ? totalBytes - availableBytes : null

  return {
    totalBytes,
    usedBytes,
    availableBytes,
    utilisationPercent: usedBytes !== null && totalBytes !== null
      ? percentage(100 * usedBytes / totalBytes)
      : null,
  }
}

export function macMemory(totalBytes: number, vmStat: string | null) {
  const pageSize = vmStat?.match(/\bpage size of (\d+) bytes\b/)?.[1]
  const pages = new Map(
    Array.from((vmStat ?? '').matchAll(/^([^:\n]+):\s+(\d+)\./gm), ([, label, count]) => [
      label,
      Number(count),
    ] as const),
  )
  const anonymous = pages.get('Anonymous pages')
  const wired = pages.get('Pages wired down')
  const compressed = pages.get('Pages occupied by compressor')
  const purgeable = pages.get('Pages purgeable')
  if (!pageSize || anonymous === undefined || wired === undefined ||
      compressed === undefined || purgeable === undefined) {
    return capacity(totalBytes, null)
  }

  // Count resident anonymous, wired and compressed memory while excluding purgeable pages.
  const usedBytes = (anonymous + wired + compressed - purgeable) * Number(pageSize)
  return capacity(totalBytes, totalBytes - usedBytes)
}

export function macBattery(power: string | null, battery: string | null): SystemTelemetry['battery'] {
  const source = power?.match(/^Now drawing from '(AC Power|Battery Power)'/m)?.[1]
  const reading = power?.match(/\bInternalBattery[^\n]*?\s(\d+)%;\s*([^;\r\n]+)/i)
  const state = reading?.[2]?.trim().toLowerCase()
  const cycles = battery?.match(/^\s*"CycleCount"\s*=\s*(\d+)\s*$/m)?.[1]
  const cycleCount = cycles === undefined ? null : Number(cycles)

  return {
    percent: reading ? percentage(Number(reading[1])) : null,
    isCharging: state === 'charging' || state === 'finishing charge' ? true
      : state === 'charged' || state === 'discharging' || state === 'not charging' ? false
        : null,
    acConnected: source ? source === 'AC Power' : null,
    cycleCount: Number.isSafeInteger(cycleCount) ? cycleCount : null,
  }
}

async function readStorage(isMac: boolean) {
  // The Data volume is writable on modern macOS and shares capacity with the startup APFS container.
  const stats = isMac
    ? await statfs('/System/Volumes/Data').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return statfs('/')
    })
    : await statfs('/')

  return capacity(stats.blocks * stats.bsize, stats.bavail * stats.bsize)
}

async function readCpu(isMac: boolean) {
  if (isMac) {
    const [cpuModel, cores] = await Promise.all([
      readCommand('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
      readCommand('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu']),
    ])
    return { cpuModel, physicalCores: Number(cores) }
  }

  const cpu = await metric(si.cpu)
  const brand = cpu?.brand?.trim()
  const manufacturer = cpu?.manufacturer?.trim()
  const cpuModel = brand && manufacturer && !brand.toLowerCase().startsWith(manufacturer.toLowerCase())
    ? `${manufacturer} ${brand}`
    : brand || null
  return { cpuModel, physicalCores: cpu?.physicalCores ?? 0 }
}

export async function collectSystem(): Promise<SystemTelemetry> {
  const isMac = platform() === 'darwin'
  const [os, hardwareModel, { cpuModel, physicalCores }, cpuLoad, memory, battery, storage] = await Promise.all([
    isMac
      ? readCommand('/usr/bin/sw_vers', ['-productVersion']).then(version => ({ os: 'macOS', version }))
      : metric(si.osInfo).then(info => ({ os: info?.distro || null, version: info?.release || null })),
    isMac
      ? readCommand('/usr/sbin/sysctl', ['-n', 'hw.model'])
      : metric(si.system).then(info => info?.model || null),
    readCpu(isMac),
    metric(si.currentLoad),
    isMac
      ? readCommand('/usr/bin/vm_stat', []).then(value => macMemory(totalmem(), value))
      : metric(si.mem).then(value => capacity(value?.total ?? totalmem(), value?.available ?? null)),
    isMac
      ? Promise.all([
        readCommand('/usr/bin/pmset', ['-g', 'batt']),
        readCommand('/usr/sbin/ioreg', ['-r', '-n', 'AppleSmartBattery', '-d', '1']),
      ]).then(([power, info]) => macBattery(power, info))
      : macBattery(null, null),
    metric(() => readStorage(isMac)),
  ])
  const [one, five, fifteen] = loadavg()

  return {
    system: {
      ...os,
      hardwareModel,
      cpuModel,
      cpuCores: Number.isSafeInteger(physicalCores) && physicalCores > 0 ? physicalCores : null,
      uptimeSeconds: uptime(),
    },
    cpu: {
      utilisationPercent: percentage(cpuLoad?.currentLoad),
      loadAverage: [one, five, fifteen],
    },
    memory,
    battery,
    storage: storage ?? capacity(null, null),
  }
}
