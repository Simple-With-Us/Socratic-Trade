import ssl,unittest
from egress import authority,sni,Denied

def hello(host):
    incoming=ssl.MemoryBIO();out=ssl.MemoryBIO()
    obj=ssl.create_default_context().wrap_bio(incoming,out,server_hostname=host)
    try:obj.do_handshake()
    except ssl.SSLWantReadError:pass
    return out.read()

class EgressTests(unittest.TestCase):
    def test_exact_provider(self):
        self.assertEqual(authority(b'CONNECT agent.minimax.io:443 HTTP/1.1\r\nHost: agent.minimax.io:443\r\n\r\n','minimax'),'agent.minimax.io')
    def test_no_alternate_destinations(self):
        for host in ['localhost','127.0.0.1','169.254.169.254','agent.minimax.io.evil.test','AGENT.MINIMAX.IO','api.meta.ai','agent.minimax.io:443@evil.test']:
            with self.assertRaises(Denied):authority(f'CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n'.encode(),'minimax')
    def test_no_plaintext_post_or_credentials(self):
        for wire in [b'POST https://agent.minimax.io HTTP/1.1\r\n\r\n',b'CONNECT agent.minimax.io:443 HTTP/1.1\r\nHost: evil.test\r\n\r\n',b'CONNECT agent.minimax.io:443 HTTP/1.1\r\nHost: agent.minimax.io:443\r\nProxy-Authorization: secret\r\n\r\n']:
            with self.assertRaises(Denied):authority(wire,'minimax')
    def test_real_tls_hello(self):
        for host in ['agent.minimax.io','api.meta.ai']:self.assertEqual(sni(hello(host)),host)
    def test_malformed_tls_closed(self):
        good=hello('agent.minimax.io')
        for wire in [b'',b'GET / HTTP/1.1\r\n',good[:8],good+b'padding',good[:60]]:
            with self.assertRaises(Denied):sni(wire)
if __name__=='__main__':unittest.main()
