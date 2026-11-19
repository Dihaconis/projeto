"""Retrato falante: anima a arte JÁ PUBLICADA da série, sem redesenhar ninguém.

Pega uma imagem pronta (ex.: o Vô e o Lucas juntos), apaga só a boca e os
olhos de cada personagem preenchendo com a pele ao redor e, por cima, coloca
as bocas da fala (formatos do Rhubarb) e o piscar, no mesmo traço de nanquim.
O bigode do Vô é recortado da própria imagem e volta por cima da boca.
O resto da imagem fica idêntico ao original.

Cada retrato é uma pasta em midia/retratos/<nome>/ com:
    base.jpg       a imagem original
    retrato.json   onde ficam boca, olhos e rosto de cada personagem
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from ..config import RAIZ

PASTA_RETRATOS = RAIZ / "midia" / "retratos"
FORMAS = ("A", "B", "C", "D", "E", "F", "G", "H", "X")
SS = 4                                   # desenha as bocas em 4x e reduz

TINTA = (26, 15, 10, 255)
DENTRO = (74, 21, 18, 255)
DENTES = (243, 234, 214, 255)
LINGUA = (150, 52, 42, 255)


def _curva(p0, p1, p2, n=30):
    t = np.linspace(0, 1, n)[:, None]
    return ((1 - t) ** 2 * np.array(p0) + 2 * (1 - t) * t * np.array(p1) + t ** 2 * np.array(p2)).tolist()


def boca_tinta(forma: str, largura: int, sorriso: float = 0.0) -> Image.Image:
    """Boca no estilo de quadrinho entalhado: contorno de nanquim, miolo escuro, dentes creme.

    `largura` é a largura da boca em px na imagem; `sorriso` (0..1) puxa os cantos para cima.
    """
    w = largura
    h = int(w * 0.9)
    L = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(L)
    cx, cy = w * SS / 2, h * SS * 0.42
    s = w * SS / 100.0                                   # unidade: 1% da largura
    canto = -14 * sorriso * s
    traco = max(2, int(3.2 * s))

    def linha(pts, larg=traco):
        d.line([tuple(p) for p in pts], fill=TINTA, width=int(larg), joint="curve")
        r = larg / 2
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - r, y - r, x + r, y + r], fill=TINTA)

    def abertura(meia_l, alto, baixo, dentes_cima=0.0, lingua=0.0):
        topo = _curva((cx - meia_l, cy + canto), (cx, cy - alto * 1.6), (cx + meia_l, cy + canto))
        fundo = _curva((cx + meia_l, cy + canto), (cx, cy + baixo * 1.9), (cx - meia_l, cy + canto))
        contorno = [tuple(p) for p in topo + fundo]
        d.polygon(contorno, fill=DENTRO)
        if dentes_cima:
            faixa = _curva((cx - meia_l * .8, cy + canto * .8), (cx, cy - alto * 1.4), (cx + meia_l * .8, cy + canto * .8))
            base = _curva((cx + meia_l * .75, cy + canto * .8 + dentes_cima), (cx, cy - alto * 1.4 + dentes_cima * 1.2),
                          (cx - meia_l * .75, cy + canto * .8 + dentes_cima))
            d.polygon([tuple(p) for p in faixa + base], fill=DENTES)
        if lingua:
            d.ellipse([cx - meia_l * .55, cy + baixo * .9 - lingua, cx + meia_l * .55, cy + baixo * 1.6], fill=LINGUA)
        d.line(contorno + [contorno[0]], fill=TINTA, width=traco, joint="curve")

    if forma == "X":                                     # repouso: traço fechado
        linha(_curva((cx - 40 * s, cy + canto), (cx, cy + 6 * s), (cx + 40 * s, cy + canto)))
    elif forma == "A":                                   # M B P: lábios apertados
        linha(_curva((cx - 34 * s, cy + canto), (cx, cy + 3 * s), (cx + 34 * s, cy + canto)), traco * 1.5)
        linha(_curva((cx - 14 * s, cy + 12 * s), (cx, cy + 15 * s), (cx + 14 * s, cy + 12 * s)), traco * .6)
    elif forma == "B":                                   # consoantes: dentes quase fechados
        abertura(36 * s, 3 * s, 6 * s, dentes_cima=9 * s)
    elif forma == "C":                                   # E: aberta média
        abertura(38 * s, 6 * s, 14 * s, dentes_cima=8 * s)
    elif forma == "D":                                   # A: bem aberta
        abertura(40 * s, 8 * s, 24 * s, dentes_cima=8 * s, lingua=8 * s)
    elif forma == "E":                                   # Ó: arredondada
        abertura(24 * s, 8 * s, 16 * s, lingua=5 * s)
    elif forma == "F":                                   # U: biquinho
        d.ellipse([cx - 13 * s, cy - 10 * s, cx + 13 * s, cy + 14 * s], fill=DENTRO, outline=TINTA, width=traco)
    elif forma == "G":                                   # F V: dente no lábio de baixo
        abertura(34 * s, 4 * s, 7 * s, dentes_cima=12 * s)
        linha(_curva((cx - 26 * s, cy + 12 * s), (cx, cy + 18 * s), (cx + 26 * s, cy + 12 * s)), traco * .8)
    elif forma == "H":                                   # L: língua no céu da boca
        abertura(36 * s, 7 * s, 18 * s, lingua=14 * s)
    else:
        raise ValueError(forma)
    return L.resize((w, h), Image.LANCZOS)


@dataclass
class Rosto:
    id: str
    boca_centro: tuple[int, int]
    boca_largura: int
    sorriso: float
    apagar_boca: tuple[int, int, int, int]
    olhos: list[dict]                       # [{"caixa": [x0,y0,x1,y1], "curva": 0.3}]
    rosto: tuple[int, int, int]             # centro x, y e largura do close
    frente: dict | None = None              # {"caixa": [...], "limiar": 165} -> bigode por cima


def _apagar(img: np.ndarray, caixas: list[tuple[int, int, int, int]], pena: float = 4.0) -> np.ndarray:
    """Tira a boca original: miolo com a cor lisa da pele em volta (como sombra chapada
    de quadrinho) e borda misturada com inpaint, para não ficar mancha borrada."""
    out = img.copy()
    for x0, y0, x1, y1 in caixas:
        m = np.zeros(img.shape[:2], np.uint8)
        cv2.ellipse(m, ((x0 + x1) // 2, (y0 + y1) // 2), ((x1 - x0) // 2, (y1 - y0) // 2), 0, 0, 360, 255, -1)
        anel = cv2.dilate(m, np.ones((9, 9), np.uint8)) - m
        px = img[anel > 0]
        px = px[px.max(axis=1) > 90]                       # ignora o nanquim
        cor = np.median(px, axis=0) if len(px) else img[m > 0].mean(axis=0)
        inp = cv2.inpaint(out, m, 4, cv2.INPAINT_TELEA).astype(np.float32)
        w = np.clip(cv2.distanceTransform(m, cv2.DIST_L2, 5) / pena, 0, 1)[..., None]
        mist = inp * (1 - w) + cor.astype(np.float32) * w
        out[m > 0] = mist[m > 0].astype(np.uint8)
    return out


class Retrato:
    def __init__(self, pasta: Path):
        cfg = json.loads((pasta / "retrato.json").read_text(encoding="utf-8"))
        self.pasta = pasta
        self.original = Image.open(pasta / cfg["base"]).convert("RGB")
        self.rostos = {pid: Rosto(id=pid, boca_centro=tuple(r["boca"]["centro"]), boca_largura=r["boca"]["largura"],
                                  sorriso=r["boca"].get("sorriso", 0.0), apagar_boca=tuple(r["boca"]["apagar"]),
                                  olhos=r.get("olhos", []), rosto=tuple(r["rosto"]), frente=r.get("frente"))
                       for pid, r in cfg["personagens"].items()}
        arr = np.asarray(self.original)
        bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
        sem_boca = _apagar(bgr, [r.apagar_boca for r in self.rostos.values()])
        self.base = Image.fromarray(cv2.cvtColor(sem_boca, cv2.COLOR_BGR2RGB))
        self.frentes: dict[str, tuple[Image.Image, tuple[int, int]]] = {}
        self.palpebras: dict[str, list[tuple[Image.Image, tuple[int, int]]]] = {}
        self.bocas: dict[str, dict[str, Image.Image]] = {}
        for r in self.rostos.values():
            self.bocas[r.id] = {f: boca_tinta(f, r.boca_largura, r.sorriso) for f in FORMAS}
            if r.frente:
                x0, y0, x1, y1 = r.frente["caixa"]
                pedaco = self.original.crop((x0, y0, x1, y1)).convert("RGBA")
                p = np.asarray(pedaco).astype(np.int16)
                claro = (p[..., :3].min(axis=2) > r.frente.get("limiar", 165))   # pelos brancos do bigode
                m = cv2.dilate(claro.astype(np.uint8) * 255, np.ones((3, 3), np.uint8))
                m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
                alfa = Image.fromarray(m).filter(ImageFilter.GaussianBlur(0.8))
                pedaco.putalpha(alfa)
                self.frentes[r.id] = (pedaco, (x0, y0))
            fechados = []
            for o in r.olhos:
                fechados.append(self._palpebra(tuple(o["caixa"]), o.get("curva", .3)))
            self.palpebras[r.id] = fechados

    def _palpebra(self, caixa, curva: float) -> tuple[Image.Image, tuple[int, int]]:
        """Olho fechado: pálpebra lisa na cor da pele em volta do olho + traço de nanquim."""
        x0, y0, x1, y1 = caixa
        w, h = x1 - x0, y1 - y0
        arr = np.asarray(self.original)
        anel = np.concatenate([arr[max(0, y0 - 6):y0, x0:x1].reshape(-1, 3),
                               arr[y1:y1 + 6, x0:x1].reshape(-1, 3)])
        anel = anel[anel.max(axis=1) > 90]                # ignora traços pretos
        cor = tuple(int(v) for v in np.median(anel, axis=0)) if len(anel) else (190, 120, 70)
        L = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
        d = ImageDraw.Draw(L)
        d.ellipse([0, 0, w * SS - 1, h * SS - 1], fill=cor + (255,))
        pts = [tuple(p) for p in _curva((w * SS * .06, h * SS * .42), (w * SS * .5, h * SS * (.42 + curva)),
                                        (w * SS * .94, h * SS * .42))]
        d.line(pts, fill=TINTA, width=max(SS * 2, int(h * SS * .16)), joint="curve")
        L = L.resize((w, h), Image.LANCZOS)
        a = L.getchannel("A").filter(ImageFilter.GaussianBlur(1.2))
        L.putalpha(a)
        return L, (x0, y0)

    def montar(self, estados: dict[str, tuple[str, bool]]) -> Image.Image:
        """estados: {personagem: (formato_de_boca, olhos_fechados)}"""
        img = self.base.copy()
        for pid, (boca, fechados) in estados.items():
            r = self.rostos[pid]
            spr = self.bocas[pid].get(boca, self.bocas[pid]["X"])
            cx, cy = r.boca_centro
            img.paste(spr, (int(cx - spr.width / 2), int(cy - spr.height * 0.42)), spr)
            if pid in self.frentes:
                f, pos = self.frentes[pid]
                img.paste(f, pos, f)
            if fechados:
                for p, pos in self.palpebras[pid]:
                    img.paste(p, pos, p)
        return img


def carregar(nome: str) -> Retrato:
    pasta = PASTA_RETRATOS / nome
    if not (pasta / "retrato.json").exists():
        raise FileNotFoundError(f"Retrato '{nome}' não encontrado em {pasta}")
    return Retrato(pasta)


class RetratoCena:
    """Cena vertical (Reels/Shorts/TikTok/Kwai) com um retrato falante no meio.

    Fundo: a própria arte desfocada e escurecida. Câmera: aproximação lenta e,
    nas falas longas, zoom em quem fala. Título em cima, legenda embaixo.
    """

    def __init__(self, retrato: Retrato, falas, total: float, titulo: str = "",
                 saida: tuple[int, int] = (1080, 1920), legenda: bool = True):
        from . import render
        self.r = retrato
        self.falas = falas
        self.total = total
        self.saida = saida
        self.legenda = legenda
        self.titulo = titulo
        self.planos = render.planejar_camera(falas, total)
        self.piscar = {pid: render.Piscar(pid, total) for pid in retrato.rostos}
        self.bocas = [render.Boca(f.cues) for f in falas]
        self.legendas = [(a, b, txt, f.quem) for f in falas for a, b, txt in render.pedacos_legenda(f, 5)]
        self.fonte = render._fonte(round(saida[0] * 0.085))
        self.fonte_titulo = render._fonte(round(saida[0] * 0.07))
        w, h = saida
        fundo = retrato.original.resize((h, h), Image.LANCZOS).crop(((h - w) // 2, 0, (h - w) // 2 + w, h))
        fundo = fundo.filter(ImageFilter.GaussianBlur(28))
        self.fundo = Image.eval(fundo, lambda v: int(v * 0.55))
        self.lado = w                                  # o retrato quadrado ocupa a largura toda
        self.topo = (h - w) // 2
        self._render = render

    def _caixa(self, plano, t: float):
        W, H = self.r.original.size
        prog = (t - plano.inicio) / max(0.1, plano.fim - plano.inicio)
        if plano.alvo == "geral" or plano.alvo not in self.r.rostos:
            z, cx, cy = 1.0 + 0.04 * prog, W / 2, H / 2
        else:
            rx, ry, larg = self.r.rostos[plano.alvo].rosto
            z = W / (larg * 1.3) * (1.0 + 0.04 * prog)      # close do tamanho do rosto
            cx, cy = rx, ry
        lado = W / z
        x0 = min(max(0.0, cx - lado / 2), W - lado)
        y0 = min(max(0.0, cy - lado / 2), H - lado)
        return x0, y0, x0 + lado, y0 + lado

    def quadro(self, t: float) -> Image.Image:
        estados = {}
        for pid in self.r.rostos:
            fala = next(((i, f) for i, f in enumerate(self.falas) if f.inicio <= t < f.fim and f.quem == pid), None)
            boca = self.bocas[fala[0]].em(t - fala[1].inicio) if fala else "X"
            estados[pid] = (boca, self.piscar[pid].fechado(t))
        arte = self.r.montar(estados)
        plano = next((p for p in self.planos if p.inicio <= t < p.fim), self.planos[-1])
        arte = arte.resize((self.lado, self.lado), Image.BILINEAR, box=self._caixa(plano, t))
        img = self.fundo.copy()
        img.paste(arte, (0, self.topo))
        d = ImageDraw.Draw(img)
        if self.titulo:
            self._texto(d, self.titulo, self.fonte_titulo, "#E8B828", centro_y=self.topo / 2)
        if self.legenda:
            leg = next(((txt, quem) for a, b, txt, quem in self.legendas if a <= t < b), None)
            if leg:
                cor = self._render.COR_LEGENDA.get(leg[1], "#FFFFFF")
                self._texto(d, leg[0], self.fonte, cor, centro_y=self.topo + self.lado + (self.saida[1] - self.topo - self.lado) / 2)
        return img

    def _texto(self, d, texto, fonte, cor, centro_y):
        w = self.saida[0]
        linhas, atual = [], ""
        for p in texto.upper().split():
            teste = f"{atual} {p}".strip()
            if d.textlength(teste, font=fonte) > w * 0.86 and atual:
                linhas.append(atual)
                atual = p
            else:
                atual = teste
        linhas.append(atual)
        alt = fonte.size + 12
        y = centro_y - alt * len(linhas) / 2
        for linha in linhas[:3]:
            lw = d.textlength(linha, font=fonte)
            d.text(((w - lw) / 2, y), linha, font=fonte, fill=cor, stroke_width=7, stroke_fill="#111111")
            y += alt
