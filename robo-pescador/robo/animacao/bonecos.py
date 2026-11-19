"""Boneco em camadas: monta o corpo e a cabeça no estado de cada quadro.

O estado de um personagem num quadro é: formato de boca, olhos abertos ou
fechados, expressão (sobrancelhas), giro da cabeça e deslocamentos de
respiração/fala. As combinações de cabeça já montadas ficam em cache:
há poucas (9 bocas x 2 olhos x 4 expressões), então montar 15 minutos de
vídeo não refaz o mesmo trabalho milhares de vezes.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import Image


@dataclass(frozen=True)
class Estado:
    boca: str = "X"
    olhos_fechados: bool = False
    expressao: str = "neutro"
    angulo: float = 0.0          # graus, em torno do pescoço
    dy_cabeca: float = 0.0       # px na tela do boneco (negativo = sobe)
    dy_corpo: float = 0.0        # respiração


class Boneco:
    def __init__(self, pasta: Path, escala: float = 1.0):
        rig = json.loads((pasta / "rig.json").read_text(encoding="utf-8"))
        self.nome: str = rig["nome"]
        self.escala = escala
        self.bocas: list[str] = rig["bocas"]
        self.expressoes: list[str] = rig["expressoes"]
        w, h = rig["tamanho"]
        self.tamanho = (round(w * escala), round(h * escala))
        cx0, cy0, cx1, cy1 = rig["caixa_cabeca"]
        self.caixa = tuple(round(v * escala) for v in (cx0, cy0, cx1, cy1))
        px, py = rig["pivo_cabeca"]
        # pivô relativo à caixa da cabeça
        self.pivo = (px * escala - self.caixa[0], py * escala - self.caixa[1])

        def carregar(nome: str, cortar: bool) -> Image.Image:
            img = Image.open(pasta / f"{nome}.png").convert("RGBA")
            if img.size != (w, h):
                raise ValueError(f"{pasta.name}/{nome}.png tem {img.size}; todas as camadas devem ter {w}x{h}")
            if escala != 1.0:
                img = img.resize(self.tamanho, Image.LANCZOS)
            return img.crop(self.caixa) if cortar else img

        self.corpo = carregar("corpo", cortar=False)
        self._cabeca = carregar("cabeca", True)
        self._frente = carregar("frente", True) if (pasta / "frente.png").exists() else None
        self._olhos = {False: carregar("olhos_abertos", True), True: carregar("olhos_fechados", True)}
        self._sobr = {e: carregar(f"sobrancelhas_{e}", True) for e in self.expressoes}
        self._boca = {b: carregar(f"boca_{b}", True) for b in self.bocas}
        self._montar = lru_cache(maxsize=256)(self._montar_cabeca)

    def _montar_cabeca(self, boca: str, fechados: bool, expressao: str, angulo_q: float) -> Image.Image:
        img = self._cabeca.copy()
        for camada in (self._olhos[fechados], self._sobr.get(expressao, self._sobr["neutro"]),
                       self._boca.get(boca, self._boca["X"]), self._frente):
            if camada is not None:
                img.alpha_composite(camada)
        if angulo_q:
            img = img.rotate(angulo_q, resample=Image.BICUBIC, center=self.pivo)
        return img

    def colar(self, palco: Image.Image, x: int, y: int, e: Estado) -> None:
        """Cola o boneco com o canto superior esquerdo em (x, y) do palco."""
        yc = round(y + e.dy_corpo)
        palco.paste(self.corpo, (x, yc), self.corpo)
        cabeca = self._montar(e.boca, e.olhos_fechados, e.expressao, round(e.angulo * 4) / 4)
        palco.paste(cabeca, (x + self.caixa[0], round(yc + self.caixa[1] + e.dy_cabeca)), cabeca)

    def centro_cabeca(self) -> tuple[float, float]:
        """Centro da cabeça em coordenadas do boneco (para a câmera mirar)."""
        x0, y0, x1, y1 = self.caixa
        return (x0 + x1) / 2, (y0 + y1) / 2
