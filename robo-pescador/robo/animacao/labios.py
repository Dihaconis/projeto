"""Sincronia da boca com a fala, pelo Rhubarb Lip Sync (gratuito, roda no computador).

O Rhubarb escuta o áudio e devolve, para cada trecho de tempo, qual dos
formatos de boca usar (A..H e X). O reconhecedor "phonetic" não depende de
idioma, então funciona com português.
"""
from __future__ import annotations

import bisect
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

from ..config import RAIZ

PASTA_RHUBARB = RAIZ / "ferramentas" / "rhubarb"


class ErroLabios(RuntimeError):
    pass


def achar_rhubarb() -> Path:
    """RHUBARB no .env, senão ferramentas/rhubarb (baixado pelo instalar.bat), senão o PATH."""
    if os.environ.get("RHUBARB"):
        p = Path(os.environ["RHUBARB"])
        if p.exists():
            return p
    exe = "rhubarb.exe" if platform.system() == "Windows" else "rhubarb"
    for p in sorted(PASTA_RHUBARB.glob(f"*/{exe}")):
        return p
    no_path = shutil.which("rhubarb")
    if no_path:
        return Path(no_path)
    raise ErroLabios(
        "Rhubarb Lip Sync não encontrado. Rode: python ferramentas\\baixar.py "
        "(ou o instalar.bat de novo).")


def sincronizar(audio_wav: Path, destino_json: Path, texto: str | None = None) -> list[dict]:
    """Roda o Rhubarb (se ainda não rodou) e devolve a lista de trechos de boca."""
    if not destino_json.exists():
        args = [str(achar_rhubarb()), "-r", "phonetic", "-f", "json", "-q", "-o", str(destino_json)]
        if texto:
            dialogo = destino_json.with_suffix(".txt")
            dialogo.write_text(texto, encoding="utf-8")
            args += ["-d", str(dialogo)]
        args.append(str(audio_wav))
        proc = subprocess.run(args, capture_output=True, text=True)
        if proc.returncode != 0 or not destino_json.exists():
            raise ErroLabios(f"Rhubarb falhou em {audio_wav.name}: {proc.stderr[-800:]}")
    return json.loads(destino_json.read_text(encoding="utf-8"))["mouthCues"]


class Boca:
    """Responde qual formato de boca usar no instante t (segundos da fala)."""

    def __init__(self, trechos: list[dict]):
        self.inicios = [float(c["start"]) for c in trechos]
        self.formas = [c["value"] for c in trechos]

    def em(self, t: float) -> str:
        if not self.formas or t < 0:
            return "X"
        i = bisect.bisect_right(self.inicios, t) - 1
        return self.formas[i] if i >= 0 else "X"
