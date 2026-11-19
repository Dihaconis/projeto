"""Receptor local temporário: recebe imagens do navegador e grava na pasta do episódio.

Só escuta em 127.0.0.1, só grava nomes cena_NN_bruta.jpg|png e se encerra sozinho em 20 minutos.
"""
import base64
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DESTINO = Path(sys.argv[1])
DESTINO.mkdir(parents=True, exist_ok=True)
NOME_OK = re.compile(r"^cena_\d{2}_bruta\.(jpg|png)$")


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        nome = parse_qs(urlparse(self.path).query).get("nome", [""])[0]
        if not NOME_OK.match(nome):
            self.send_response(400)
            self._cors()
            self.end_headers()
            return
        tamanho = int(self.headers.get("Content-Length", 0))
        dados = base64.b64decode(self.rfile.read(tamanho))
        (DESTINO / nome).write_bytes(dados)
        print(f"gravado {nome} ({len(dados)} bytes)", flush=True)
        self.send_response(200)
        self._cors()
        self.end_headers()
        self.wfile.write(b"ok")


srv = HTTPServer(("127.0.0.1", 8765), H)
threading.Timer(1200, srv.shutdown).start()
print("pronto", flush=True)
srv.serve_forever()
