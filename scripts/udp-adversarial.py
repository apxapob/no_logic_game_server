"""Real-network negative and recovery checks for udp-stress.py's bounded test instance."""
import importlib.util,pathlib,asyncio,argparse,socket,json,time,random
spec=importlib.util.spec_from_file_location('stress',pathlib.Path(__file__).with_name('udp-stress.py'))
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

async def silent(peers,seconds=.25):
    async def check(p):
        try:
            await asyncio.wait_for(asyncio.get_running_loop().sock_recv(p.sock,65536),seconds)
            raise AssertionError('Unexpected datagram')
        except TimeoutError:pass
    await asyncio.gather(*(check(p) for p in peers))

async def roundtrip(peers):
    payload=bytes(range(256))*4
    await peers[0].send(2,s.ZERO,payload)
    for p in peers[1:4]:
        b=await p.receive(5)
        assert b[21:37]==peers[0].id and b[37:-32]==payload

async def main(a):
    a.udp_host=socket.gethostbyname(a.udp_host)
    peers=await s.clients(a,8);p=peers[0];checks=[]
    try:
        await roundtrip(peers);checks.append('baseline_integrity')
        own_cid=p.cid
        try:
            p.cid=peers[1].cid
            forged=p.packet(2,s.ZERO,b'forged-sender')
        finally:p.cid=own_cid
        await asyncio.get_running_loop().sock_sendall(p.sock,forged)
        await silent(peers);checks.append('other_connection_id_with_own_key_rejected')
        packet=await p.send(2,peers[1].id,b'replay')
        await peers[1].receive(5)
        for _ in range(10):await asyncio.get_running_loop().sock_sendall(p.sock,packet)
        await silent(peers);checks.append('replay_rejected')
        for target in [p.id,peers[4].id]:await p.send(2,target,b'forbidden')
        await silent(peers);checks.append('self_and_cross_room_rejected')
        # 1000 malformed datagrams/s for 10s, below the listener's global ceiling.
        # Fixed seeded random data makes the corpus reproducible.
        rng=random.Random(20261102);start=time.monotonic();count=0
        while time.monotonic()-start<10:
            for _ in range(10):
                kind=count%5
                if kind==0:b=rng.randbytes(rng.randrange(0,2049))
                elif kind==1:b=p.packet(2,s.ZERO,b'bad-tag')[:-1]+bytes([0])
                elif kind==2:b=p.packet(5,s.ZERO,b'wrong-direction')
                elif kind==3:b=p.packet(2,s.ZERO,bytes(1132))
                else:b=p.packet(1,s.ZERO,bytes(16))
                # Ensure a bad MAC is always bad, independent of its original last byte.
                if kind==1:b=b[:-1]+bytes([hmac_last(p,b)^255])
                await asyncio.get_running_loop().sock_sendall(p.sock,b);count+=1
            await asyncio.sleep(.01)
        await silent(peers);await asyncio.sleep(1.1);await roundtrip(peers)
        checks.append('malformed_flood_and_recovery')
        old_socket=p.sock
        p.sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);p.sock.setblocking(False);p.sock.connect(p.endpoint)
        await p.send(2,s.ZERO,b'new-source-unbound');await silent(peers)
        old_socket.close()
        await peers[1].send(2,p.id,b'to-closed-endpoint')
        await asyncio.sleep(.2)
        await p.bind_udp();await roundtrip(peers)
        checks.append('nat_rebinding_and_closed_endpoint_icmp')
        old=p.packet(2,s.ZERO,b'old-key')
        await p.open_udp();await asyncio.get_running_loop().sock_sendall(p.sock,old)
        await silent(peers);await roundtrip(peers);checks.append('key_rotation')
        if a.expiry:
            print('Waiting 61 seconds to check real endpoint expiry',flush=True)
            await asyncio.sleep(61)
            await p.send(2,s.ZERO,b'expired');await silent(peers)
            for peer in peers:await peer.bind_udp()
            await roundtrip(peers);checks.append('real_60_second_expiry_and_rebind')
        await p.send_ws('closeUdp');await p.wait('udpClosed')
        await p.send(2,s.ZERO,b'closed');await silent(peers)
        await p.open_udp();await roundtrip(peers);checks.append('close_and_reopen')
        assert not any(peer.errors for peer in peers)
        result={'checks':checks,'malformedSent':count,'passed':True}
        a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
    finally:await asyncio.gather(*(p.close() for p in peers),return_exceptions=True)

def hmac_last(p,b):
    import hmac
    return hmac.digest(p.key,b[:-32],'sha256')[-1]

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--url',required=True);p.add_argument('--udp-host',required=True);p.add_argument('--udp-port',type=int,required=True)
    p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--expiry',action='store_true')
    asyncio.run(main(p.parse_args()))
