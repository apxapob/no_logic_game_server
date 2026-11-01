from pathlib import Path
from datetime import datetime
import json, statistics, sys

if len(sys.argv) < 3:
    raise SystemExit('Usage: vps-analyze.py RUN_DIRECTORY results/profile.jsonl [...]')
root = Path(sys.argv[1]).resolve()
metrics = []
invalid_lines = []
for number, line in enumerate((root / 'results/metrics.jsonl').read_text().splitlines(), 1):
    try: metrics.append(json.loads(line))
    except json.JSONDecodeError: invalid_lines.append(number)
if invalid_lines: print(json.dumps({'ignoredPartialMetricLines': invalid_lines}), file=sys.stderr)

def pct(values, fraction):
    ordered = sorted(values)
    return round(ordered[min(len(ordered)-1, int((len(ordered)-1)*fraction))], 2) if ordered else None

summaries = []
for name in sys.argv[2:]:
    for row in map(json.loads, (root / name).read_text().splitlines()):
        if row.get('event') != 'stage': continue
        start = datetime.fromisoformat(row['startTime'].replace('Z','+00:00')).timestamp()
        stop = datetime.fromisoformat(row['stopTime'].replace('Z','+00:00')).timestamp()
        samples = [m for m in metrics if start <= m['time'] <= stop and 'hostBusyPercent' in m]
        def vals(key): return [m[key] for m in samples if key in m]
        def group_vals(group, key): return [m[group][key] for m in samples if key in m[group]]
        def average(numbers): return round(statistics.mean(numbers), 2) if numbers else None
        combined = [m['benchmark']['cpuPercent'] + m['caddy']['cpuPercent'] for m in samples]
        summary = {
            'profile': row['profile'], 'players': row['clients'], 'durationSeconds': row['durationSeconds'],
            'deliveredPercent': row['deliveryPercent'], 'offeredRatePercent': row['offeredRatePercent'],
            'disconnects': row['disconnects'], 'errors': row['errors'], 'latencyMs': row['relayLatencyMs'],
            'backendCpuMean': average(group_vals('benchmark','cpuPercent')), 'caddyCpuMean': average(group_vals('caddy','cpuPercent')), 'serverCpuMean': average(combined), 'serverCpuP95': pct(combined,.95),
            'hostBusyMean': average(vals('hostBusyPercent')), 'hostBusyP95': pct(vals('hostBusyPercent'),.95),
            'hostStealMean': average(vals('hostStealPercent')), 'hostIowaitMean': average(vals('hostIowaitPercent')),
            'tcpRetransmitMeanPercent': average(vals('tcpRetransmitPercent')),
            'serverAnonPeakMiB': max(group_vals('benchmark','anonMiB'), default=None),
            'serverMemoryPeakWithCacheMiB': max(group_vals('benchmark','memoryMiB'), default=None),
            'caddyMemoryPeakMiB': max(group_vals('caddy','memoryMiB'), default=None),
            'networkTransmitMeanMbps': average(vals('networkTransmitMbps')),
            'networkReceiveMeanMbps': average(vals('networkReceiveMbps')),
            'generator': row['generator'], 'samples': len(samples), 'failure': row['failure'],
        }
        summaries.append(summary)
        print(json.dumps(summary))
(root / 'results/summary.json').write_text(json.dumps(summaries, indent=2) + '\n')
