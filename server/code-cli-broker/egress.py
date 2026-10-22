"""Private-network bridge and deny-by-default TLS CONNECT gateway. No auto-start."""
import asyncio, ipaddress, socket, struct
ALLOWED = {'minimax':frozenset({'account.minimax.io','agent.minimax.io'}),
           'muse':frozenset({'api.meta.ai'})}
MAX_BYTES=8*1024*1024
class Denied(Exception): pass

def authority(header, adapter):
    if len(header)>4096 or not header.endswith(b'\r\n\r\n'):raise Denied('header')
    lines=header.decode('ascii').split('\r\n')
    parts=lines[0].split(' ')
    if len(parts)!=3 or parts[0]!='CONNECT' or parts[2]!='HTTP/1.1':raise Denied('method')
    target=parts[1]
    if target not in {host+':443' for host in ALLOWED[adapter]}:raise Denied('destination')
    hosts=[]
    for line in lines[1:-2]:
        if ':' not in line:raise Denied('header')
        k,v=line.split(':',1)
        if k.lower()=='host':hosts.append(v.strip())
        elif k.lower() not in ('user-agent','proxy-connection','connection'):raise Denied('header')
    if hosts not in ([target],[target[:-4]]):raise Denied('host')
    return target[:-4]

def sni(record):
    """Accept one complete bounded TLS ClientHello, with exactly one clear SNI."""
    try:
        if len(record)<9 or record[0]!=22 or record[1:3] not in (b'\x03\x01',b'\x03\x03'):raise Denied('TLS')
        n=int.from_bytes(record[3:5],'big')
        if n>16384 or len(record)!=n+5 or record[5]!=1 or int.from_bytes(record[6:9],'big')!=n-4:raise Denied('hello')
        body=record[9:];p=34
        p+=1+body[p];n=int.from_bytes(body[p:p+2],'big');p+=2+n
        p+=1+body[p];end=p+2+int.from_bytes(body[p:p+2],'big');p+=2
        if end!=len(body):raise Denied('extensions')
        names=[];seen=set()
        while p<end:
            typ,size=struct.unpack('!HH',body[p:p+4]);p+=4;value=body[p:p+size];p+=size
            if len(value)!=size or typ in seen:raise Denied('extension')
            seen.add(typ)
            if typ==65037:raise Denied('ECH')
            if typ==0:
                if len(value)<5 or int.from_bytes(value[:2],'big')!=len(value)-2 or value[2]!=0 or int.from_bytes(value[3:5],'big')!=len(value)-5:raise Denied('SNI')
                names.append(value[5:].decode('ascii'))
        if p!=end or len(names)!=1:raise Denied('SNI')
        return names[0]
    except (IndexError,ValueError,UnicodeError,struct.error) as exc:raise Denied('hello') from exc

async def public_addresses(host):
    infos=await asyncio.get_running_loop().getaddrinfo(host,443,type=socket.SOCK_STREAM)
    addresses=[]
    for family,kind,proto,canon,addr in infos:
        if not ipaddress.ip_address(addr[0]).is_global:raise Denied('nonpublic DNS')
        addresses.append((family,addr[0]))
    if not addresses:raise Denied('DNS')
    return addresses

async def relay(reader,writer,budget):
    while True:
        chunk=await asyncio.wait_for(reader.read(65536),20)
        if not chunk:return
        budget[0]+=len(chunk)
        if budget[0]>MAX_BYTES:raise Denied('byte limit')
        writer.write(chunk);await writer.drain()

async def tunnel(reader,writer,adapter,resolved=None):
    upstream=None
    try:
        async with asyncio.timeout(80):
            host=authority(await reader.readuntil(b'\r\n\r\n'),adapter)
            writer.write(b'HTTP/1.1 200 Connection Established\r\n\r\n');await writer.drain()
            head=await reader.readexactly(5);n=int.from_bytes(head[3:5],'big')
            if n>16384:raise Denied('hello limit')
            hello=head+await reader.readexactly(n)
            if sni(hello)!=host:raise Denied('SNI mismatch')
            # Resolve only after admission. Connect the validated literal, never re-resolve.
            addresses=resolved[host] if resolved is not None else await public_addresses(host)
            family,ip=addresses[0]
            other,upstream=await asyncio.wait_for(asyncio.open_connection(ip,443,family=family),5)
            upstream.write(hello);await upstream.drain()
            budget=[len(hello)]
            tasks=[asyncio.create_task(relay(reader,upstream,budget)),asyncio.create_task(relay(other,writer,budget))]
            try:
                done,pending=await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
                for t in done:t.result()
            finally:
                for t in tasks:t.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
    except Exception as exc:
        print("gateway_denied",type(exc).__name__,str(exc) if isinstance(exc,Denied) else "",flush=True) # No payloads.
    finally:
        writer.close()
        if upstream:upstream.close()

async def gateway(path,adapter,resolved=None):
    # Caller creates private directory, owns the socket, caps lifetime and kills this process.
    admitted=0
    async def accept(reader,writer):
        nonlocal admitted
        if admitted>=8:writer.close();return
        admitted+=1
        await tunnel(reader,writer,adapter,resolved)
    server=await asyncio.start_unix_server(accept,path,limit=4096)
    async with server:await asyncio.sleep(90)

async def bridge(path):
    async def accept(reader,writer):
        remote=None
        try:
            other,remote=await asyncio.open_unix_connection(path,limit=4096)
            tasks=[asyncio.create_task(relay(reader,remote,[0])),asyncio.create_task(relay(other,writer,[0]))]
            try:await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            finally:
                for t in tasks:t.cancel()
                await asyncio.gather(*tasks,return_exceptions=True)
        finally:
            writer.close()
            if remote:remote.close()
    server=await asyncio.start_server(accept,'127.0.0.1',18080,limit=4096)
    async with server:await asyncio.sleep(90)

if __name__=='__main__':
    import sys,json
    mode=sys.argv[1]
    if mode=='gateway':asyncio.run(gateway('/work/egress.sock',sys.argv[2],json.loads(sys.argv[3])))
    elif mode=='bridge':asyncio.run(bridge('/egress.sock'))
    else:raise SystemExit('mode denied')
