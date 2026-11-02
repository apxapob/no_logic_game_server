"""Bounded native UDP relay exerciser. Requires Python 3.11+ and websockets.

Control URL may be an SSH-forwarded WS endpoint; UDP must point at the public VPS.
No credentials or payloads are written to reports. Never selects a remote target
automatically. Run only against an authorized, preferably isolated instance.
"""
import argparse, asyncio, base64, hmac, json, math, socket, struct, time, uuid
from pathlib import Path
import websockets

HEADER = struct.Struct('!4sBQQ16s')
APP = struct.Struct('!IIQ')
ZERO = bytes(16)

class Peer:
    def __init__(self, index, endpoint):
        self.index, self.endpoint = index, endpoint
        self.sequence = 0
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024*1024)
        self.sock.setblocking(False)
        self.sock.connect(endpoint)
        self.ws = None
        self.events = asyncio.Queue()
        self.reader = None
        self.errors = []

    async def connect(self, url):
        self.ws = await websockets.connect(url, open_timeout=10, max_size=65536)
        await self.send_ws('authenticate', {})
        self.account = (await self.wait('accountCreated'))
        self.id = uuid.UUID(self.account['playerId']).bytes
        self.capability = await self.wait('onConnected')
        self.reader = asyncio.create_task(self.read_ws())

    async def send_ws(self, method, data=None):
        await self.ws.send(json.dumps({'method':method,'data':data}))

    async def read_ws(self):
        try:
            async for raw in self.ws:
                if not isinstance(raw,str): continue
                item=json.loads(raw)
                if item['method']=='Ping': await self.send_ws('Pong',item['data'])
                else: await self.events.put(item)
        except Exception as e: self.errors.append(type(e).__name__)

    async def wait(self, method):
        async def read():
            while True:
                item=await self.events.get() if self.reader else json.loads(await self.ws.recv())
                if item['method']=='Ping': await self.send_ws('Pong',item['data']); continue
                if item['method']=='error': raise RuntimeError(str(item.get('data')))
                if item['method']==method: return item.get('data')
        return await asyncio.wait_for(read(),10)

    async def open_udp(self):
        await self.send_ws('openUdp')
        s=await self.wait('udpSession')
        self.cid=int(s['connectionId']); self.key=base64.b64decode(s['secret']); self.sequence=0
        assert s['version']==1 and s['maxDatagramBytes']==1200
        await self.bind_udp()

    async def bind_udp(self):
        for attempt in range(5):
            try:
                await self.send(0,ZERO,bytes(16))
                b=await self.receive(3)
                await self.send(1,ZERO,b[37:-32])
                await self.receive(4)
                return
            except TimeoutError:
                if attempt==4: raise

    def packet(self, kind, target, payload):
        self.sequence+=1
        b=HEADER.pack(b'NLU1',kind,self.cid,self.sequence,target)+payload
        return b+hmac.digest(self.key,b,'sha256')

    async def send(self,kind,target,payload):
        b=self.packet(kind,target,payload)
        await asyncio.get_running_loop().sock_sendall(self.sock,b)
        return b

    def validate(self,b):
        assert 69<=len(b)<=1200
        magic,kind,cid,seq,sender=HEADER.unpack_from(b)
        assert magic==b'NLU1' and cid==self.cid and seq>0
        assert hmac.compare_digest(b[-32:],hmac.digest(self.key,b[:-32],'sha256'))
        return kind,sender,b[37:-32]

    async def receive(self,kind):
        async with asyncio.timeout(2):
            while True:
                b=await asyncio.get_running_loop().sock_recv(self.sock,65536)
                if self.validate(b)[0]==kind: return b

    async def close(self):
        if self.ws: await self.ws.close()
        if self.reader:
            self.reader.cancel()
            await asyncio.gather(self.reader,return_exceptions=True)
        self.sock.close()

async def clients(args,count):
    result=[None]*count
    gate=asyncio.Semaphore(8)
    async def group(first):
        async with gate:
            for i in range(first,first+4):
                p=Peer(i,(args.udp_host,args.udp_port)); result[i]=p
                await p.connect(args.url)
                if i%4==0:
                    await p.send_ws('createRoom',{'name':'UDP stress temporary','maxPlayers':4})
                    room=await p.wait('onRoomEnter')
                else:
                    await p.send_ws('enterRoom',{'roomId':room['roomId']})
                    await p.wait('onRoomEnter')
                await p.open_udp()
    try:
        async with asyncio.TaskGroup() as tasks:
            for first in range(0,count,4):tasks.create_task(group(first))
        # Refresh early bindings after potentially slow network setup.
        await asyncio.gather(*(p.bind_udp() for p in result))
        return result
    except BaseException:
        await asyncio.gather(*(p.close() for p in result if p),return_exceptions=True)
        raise

async def phase(args,count,seconds,size,hz,label):
    peers=await clients(args,count)
    stats=dict(label=label,clients=count,seconds=seconds,payloadBytes=size,hz=hz,sent=0,received=0,duplicates=0,invalid=0,errors=0,startedAt=time.time())
    latencies=[]; seen=set(); sent=set(); late=0; started=time.perf_counter(); stop=started+seconds
    async def receiver(p):
        nonlocal late
        while True:
            b=await asyncio.get_running_loop().sock_recv(p.sock,65536)
            try:
                kind,sender,payload=p.validate(b)
                assert kind==5 and len(payload)==size
                index,seq,stamp=APP.unpack_from(payload)
                assert index<count and index!=p.index and index//4==p.index//4
                assert sender==peers[index].id
                assert payload[APP.size:]==bytes([index%251])*(size-APP.size)
                assert (index,seq) in sent
                key=(p.index,index,seq)
                if key in seen: stats['duplicates']+=1
                else:
                    seen.add(key); stats['received']+=1
                    latencies.append((time.perf_counter_ns()-stamp)/1e6)
            except (AssertionError,struct.error): stats['invalid']+=1
    async def sender(p):
        seq=0; due=started+p.index/(hz*count)
        while due<stop:
            await asyncio.sleep(max(0,due-time.perf_counter()))
            if time.perf_counter()>stop: break
            seq+=1; sent.add((p.index,seq))
            payload=APP.pack(p.index,seq,time.perf_counter_ns())+bytes([p.index%251])*(size-APP.size)
            await p.send(2,ZERO,payload);stats['sent']+=1
            due+=1/hz
            if time.perf_counter()-due>.1:
                late+=1; due=time.perf_counter()+1/hz
    receivers=[asyncio.create_task(receiver(p)) for p in peers]
    try:
        await asyncio.gather(*(sender(p) for p in peers))
        await asyncio.sleep(1)
        stats['errors']=sum(len(p.errors) + int(p.reader.done() and not p.errors) for p in peers)
        stats['receiverFailures']=sum(t.done() and t.exception() is not None for t in receivers)
    finally:
        for task in receivers: task.cancel()
        await asyncio.gather(*receivers,return_exceptions=True)
        if label.startswith('churn-') and int(label.split('-')[1])%2==0:
            for p in peers: p.ws.transport.abort()
        await asyncio.gather(*(p.close() for p in peers),return_exceptions=True)
    stats['expected']=stats['sent']*3
    stats['lossPercent']=100*(stats['expected']-stats['received'])/max(1,stats['expected'])
    stats['actualPacketsPerSecond']=stats['sent']/seconds
    stats['generatorLateResets']=late
    stats['endedAt']=time.time()
    latencies.sort()
    for key,q in [('p50Ms',.5),('p95Ms',.95),('p99Ms',.99),('maxMs',1)]:
        stats[key]=latencies[min(len(latencies)-1,math.ceil(len(latencies)*q)-1)] if latencies else None
    return stats

async def main(args):
    args.udp_host=socket.gethostbyname(args.udp_host)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    if args.mode=='load': stages=[(n,args.seconds,args.size,args.hz,'load') for n in args.levels]
    elif args.mode=='soak': stages=[(args.levels[0],args.seconds,args.size,args.hz,'soak')]
    else: stages=[(args.levels[0],args.seconds,args.size,args.hz,f'churn-{i+1}') for i in range(args.cycles)]
    with args.output.open('w',buffering=1) as f:
        for count,seconds,size,hz,label in stages:
            r=await phase(args,count,seconds,size,hz,label)
            f.write(json.dumps(r)+'\n');print(json.dumps(r),flush=True)
            if r['invalid'] or r['duplicates'] or r['errors'] or r['receiverFailures']: raise RuntimeError('Integrity/lifecycle failure')
            if r['lossPercent']>args.stop_loss: break
            await asyncio.sleep(args.rest)

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',required=True);p.add_argument('--udp-host',required=True)
    p.add_argument('--udp-port',type=int,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--mode',choices=['load','soak','churn'],default='load')
    p.add_argument('--levels',type=lambda s:list(map(int,s.split(','))),default=[4,16,32,64,96,128,160])
    p.add_argument('--seconds',type=int,default=20);p.add_argument('--size',type=int,default=512)
    p.add_argument('--hz',type=int,default=30);p.add_argument('--cycles',type=int,default=15)
    p.add_argument('--rest',type=float,default=2);p.add_argument('--stop-loss',type=float,default=25)
    args=p.parse_args()
    if not all(4<=n<=192 and n%4==0 for n in args.levels):p.error('levels must be multiples of 4, between 4 and 192')
    if not (16<=args.size<=1131 and 1<=args.hz<=240 and 1<=args.seconds<=600 and 1<=args.cycles<=50):p.error('invalid bounded workload')
    asyncio.run(main(args))
