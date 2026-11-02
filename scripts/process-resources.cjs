'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const run = promisify(execFile);

module.exports = async function resources(pid) {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${Number(pid)}; @{cpuMs=$p.TotalProcessorTime.TotalMilliseconds; rssBytes=$p.WorkingSet64; peakRssBytes=$p.PeakWorkingSet64; privateBytes=$p.PrivateMemorySize64; handles=$p.HandleCount; threads=$p.Threads.Count} | ConvertTo-Json -Compress`], { windowsHide: true });
    return JSON.parse(stdout);
  }
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const hz = Number((await run('getconf', ['CLK_TCK'])).stdout.trim());
  return { cpuMs: (Number(stat[13]) + Number(stat[14])) * 1000 / hz, rssBytes: Number(/VmRSS:\s+(\d+)/.exec(status)[1]) * 1024, peakRssBytes: Number(/VmHWM:\s+(\d+)/.exec(status)[1]) * 1024, privateBytes: Number(/RssAnon:\s+(\d+)/.exec(status)[1]) * 1024, handles: fs.readdirSync(`/proc/${pid}/fd`).length, threads: Number(/Threads:\s+(\d+)/.exec(status)[1]) };
};
