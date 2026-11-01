"""Run on the authorized VPS; sample separate backend/proxy cgroups each second."""
import json, time, pathlib, shutil, subprocess, argparse

parser = argparse.ArgumentParser()
parser.add_argument('output', type=pathlib.Path)
parser.add_argument('--seconds', type=int, default=3600)
parser.add_argument('--backend-unit', default='no-logic-loadtest.service')
args = parser.parse_args()
GROUPS = {'benchmark': args.backend_unit, 'production': 'no-logic-game-server.service', 'caddy': 'caddy.service'}

def values(path):
    try:
        return {parts[0].rstrip(':'): int(parts[1]) for line in pathlib.Path(path).read_text().splitlines() if len(parts := line.split()) >= 2}
    except (OSError, ValueError):
        return {}

def sample():
    cpu = list(map(int, pathlib.Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
    mem = values('/proc/meminfo')
    data = {'time': time.time(), 'cpuTicks': cpu, 'memoryAvailableMiB': mem.get('MemAvailable', 0) / 1024, 'swapUsedMiB': (mem.get('SwapTotal', 0) - mem.get('SwapFree', 0)) / 1024}
    for label, unit in GROUPS.items():
        group = pathlib.Path('/sys/fs/cgroup/system.slice') / unit
        stat = values(group / 'cpu.stat')
        try: memory = int((group / 'memory.current').read_text())
        except OSError: memory = 0
        memory_stat = values(group / 'memory.stat')
        data[label] = {'cpuUsec': stat.get('usage_usec', 0), 'memoryMiB': memory / 1024 / 1024, 'anonMiB': memory_stat.get('anon', 0) / 1024 / 1024, 'fileCacheMiB': memory_stat.get('file', 0) / 1024 / 1024, 'memoryEvents': values(group / 'memory.events')}
    receive = transmit = 0
    for line in pathlib.Path('/proc/net/dev').read_text().splitlines()[2:]:
        name, rest = line.split(':')
        if name.strip() != 'lo':
            parts = rest.split(); receive += int(parts[0]); transmit += int(parts[8])
    data['networkReceiveBytes'] = receive; data['networkTransmitBytes'] = transmit
    tcp_lines = [line.split()[1:] for line in pathlib.Path('/proc/net/snmp').read_text().splitlines() if line.startswith('Tcp:')]
    if len(tcp_lines) == 2:
        tcp = dict(zip(tcp_lines[0], map(int, tcp_lines[1])))
        data['tcpRetransmittedSegments'] = tcp.get('RetransSegs', 0)
        data['tcpSentSegments'] = tcp.get('OutSegs', 0)
    data['diskFreeGiB'] = shutil.disk_usage('/').free / 1024 ** 3
    return data

previous = None
with args.output.open('a', buffering=1) as output:
    for _ in range(args.seconds):
        current = sample()
        if previous:
            elapsed = current['time'] - previous['time']
            delta = [a - b for a, b in zip(current['cpuTicks'], previous['cpuTicks'])]
            total = max(1, sum(delta))
            current['hostBusyPercent'] = 100 * (total - delta[3] - delta[4]) / total
            current['hostIowaitPercent'] = 100 * delta[4] / total
            current['hostStealPercent'] = 100 * delta[7] / total
            for label in GROUPS:
                current[label]['cpuPercent'] = max(0, (current[label]['cpuUsec'] - previous[label]['cpuUsec']) / elapsed / 10000)
            current['networkReceiveMbps'] = 8 * (current['networkReceiveBytes'] - previous['networkReceiveBytes']) / elapsed / 1e6
            current['networkTransmitMbps'] = 8 * (current['networkTransmitBytes'] - previous['networkTransmitBytes']) / elapsed / 1e6
            if 'tcpSentSegments' in previous:
                current['tcpRetransmitPercent'] = 100 * (current['tcpRetransmittedSegments'] - previous['tcpRetransmittedSegments']) / max(1, current['tcpSentSegments'] - previous['tcpSentSegments'])
        output.write(json.dumps(current) + '\n')
        if current['memoryAvailableMiB'] < 400 or current['benchmark']['anonMiB'] > 600 or current['diskFreeGiB'] < 4 or current['benchmark']['memoryEvents'].get('oom_kill', 0):
            output.write(json.dumps({'time': time.time(), 'event': 'safety_stop', 'reason': 'resource threshold'}) + '\n')
            subprocess.run(['systemctl', 'stop', args.backend_unit], check=False)
            break
        previous = current
        time.sleep(1)
