"""Baixa as ferramentas gratuitas da animação, conferindo o hash de cada arquivo.

- Rhubarb Lip Sync 1.13.0 (MIT): descobre o formato da boca a cada instante da fala.
- Vozes offline do Piper em português (pt_BR): usadas sem internet ou se o edge-tts falhar.

Uso:  python ferramentas\\baixar.py     (o instalar.bat já roda isto)
Só baixa o que falta; um arquivo com hash diferente é apagado e a instalação para.
"""
from __future__ import annotations

import hashlib
import platform
import sys
import zipfile
from pathlib import Path

import requests

RAIZ = Path(__file__).resolve().parent.parent

RHUBARB = {
    "Windows": ("https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.13.0/Rhubarb-Lip-Sync-1.13.0-Windows.zip",
                "189ac55dae253dba3994d4075b8375b615f255759c105c7ed21bd88ad7728386"),
    "Linux": ("https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.13.0/Rhubarb-Lip-Sync-1.13.0-Linux.zip",
              "bd260905e88d0bdadbd4d7b452cae3b78a880fe27d10d51586772f84aac69f71"),
}

VOZES_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR"
VOZES = {
    "pt_BR-faber-medium.onnx": ("faber/medium", "75e913eb463db0b6ac7ddf68d3e4c9ac19ace36dc3b710a81039b448352b8ffc"),
    "pt_BR-faber-medium.onnx.json": ("faber/medium", "6b6801319e5a70aa4d75c63343515f55d1cd671ecd1ac511586bc16216812261"),
    "pt_BR-jeff-medium.onnx": ("jeff/medium", "82ddcdb01a0342f078bd89ce2815eda27185818d15e15f06fb9a72ac3bce94e1"),
    "pt_BR-jeff-medium.onnx.json": ("jeff/medium", "8dc6e33760a02bc217ae83f8a8ede973c08b0e46c240f48f7f9fb9f0dbe45e0b"),
}


def _sha256(caminho: Path) -> str:
    h = hashlib.sha256()
    with open(caminho, "rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def _baixar(url: str, destino: Path, sha: str) -> None:
    if destino.exists() and _sha256(destino) == sha:
        return
    destino.parent.mkdir(parents=True, exist_ok=True)
    print(f"baixando {destino.name} ...", flush=True)
    parcial = destino.with_suffix(destino.suffix + ".parcial")
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(parcial, "wb") as f:
            for bloco in r.iter_content(1 << 20):
                f.write(bloco)
    obtido = _sha256(parcial)
    if obtido != sha:
        parcial.unlink()
        raise SystemExit(f"Hash errado em {destino.name} (esperado {sha[:12]}…, veio {obtido[:12]}…). Nada foi instalado.")
    parcial.replace(destino)


def rhubarb() -> Path:
    sistema = platform.system()
    if sistema not in RHUBARB:
        raise SystemExit(f"Rhubarb: sistema {sistema} não suportado por este instalador.")
    url, sha = RHUBARB[sistema]
    pasta = RAIZ / "ferramentas" / "rhubarb"
    exe = "rhubarb.exe" if sistema == "Windows" else "rhubarb"
    pronto = list(pasta.glob(f"*/{exe}"))
    if pronto:
        return pronto[0]
    arquivo = pasta / url.rsplit("/", 1)[1]
    _baixar(url, arquivo, sha)
    with zipfile.ZipFile(arquivo) as z:
        z.extractall(pasta)
    arquivo.unlink()
    exe_path = next(pasta.glob(f"*/{exe}"))
    if sistema != "Windows":
        exe_path.chmod(0o755)
    return exe_path


def vozes() -> None:
    for nome, (sub, sha) in VOZES.items():
        _baixar(f"{VOZES_BASE}/{sub}/{nome}", RAIZ / "modelos" / "piper" / nome, sha)


if __name__ == "__main__":
    print(f"Rhubarb pronto: {rhubarb()}")
    vozes()
    print("Vozes offline prontas em modelos/piper")
    sys.exit(0)
