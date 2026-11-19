"""Bonecos de TESTE (Vô e Lucas) e cenário, em camadas — só para provar o motor.

NÃO usar no canal: a série mantém a feição já publicada; os bonecos de verdade
são montados a partir dessa arte. Daqui o animador usa as bocas e o formato do rig.

Cada boneco sai como uma pasta com PNGs transparentes do MESMO tamanho
(1000x1500), um por camada, mais um rig.json que diz onde fica o pescoço
(o pivô da cabeça) e a caixa da cabeça. É o mesmo formato que um desenhista
usaria: quando vocês tiverem a arte definitiva (feita à mão ou gerada e
recortada), basta trocar os PNGs com os mesmos nomes — o animador não muda.

Camadas: corpo, cabeca, frente (bigode, por cima da boca), olhos_abertos,
olhos_fechados, sobrancelhas_<expressão> e boca_<A..H,X> (formatos do
Rhubarb Lip Sync).

Uso:  python -m robo.animacao.desenho      (redesenha tudo em midia/bonecos)
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

from ..config import RAIZ

PASTA_BONECOS = RAIZ / "midia" / "bonecos"
PASTA_CENARIOS = RAIZ / "midia" / "cenarios"

W, H = 1000, 1500          # tela de cada camada do boneco
SS = 2                     # desenha em 2x e reduz: traço sem serrilhado

PRETO = "#111111"
PAPEL = "#EFE6D2"
ACAI = "#4B1F4F"
MATA = "#1F3B2A"
RIO = "#6B4423"
LAMPARINA = "#E8B828"
URUCUM = "#B3261E"

BOCA_DENTRO = "#3A1016"
DENTES = "#F4EEDC"
LINGUA = "#C4574A"

FORMAS_BOCA = ("A", "B", "C", "D", "E", "F", "G", "H", "X")
EXPRESSOES = ("neutro", "feliz", "serio", "surpreso")


class Lapis:
    """Desenho em 2x com traço preto grosso, estilo xilogravura."""

    def __init__(self, w: int = W, h: int = H):
        self.img = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    @staticmethod
    def _p(pts):
        return [(x * SS, y * SS) for x, y in pts]

    @staticmethod
    def _b(box):
        return [v * SS for v in box]

    def poligono(self, pts, cor, traco: float = 7):
        self.d.polygon(self._p(pts), fill=cor, outline=PRETO if traco else None,
                       width=int(traco * SS) if traco else 0)

    def elipse(self, box, cor, traco: float = 7):
        self.d.ellipse(self._b(box), fill=cor, outline=PRETO if traco else None,
                       width=int(traco * SS) if traco else 0)

    def linha(self, pts, largura: float = 6, cor: str = PRETO):
        self.d.line(self._p(pts), fill=cor, width=int(largura * SS), joint="curve")
        r = largura * SS / 2                      # pontas arredondadas, como goiva
        for x, y in (pts[0], pts[-1]):
            self.d.ellipse([x * SS - r, y * SS - r, x * SS + r, y * SS + r], fill=cor)

    def arco(self, box, ini, fim, largura: float = 6, cor: str = PRETO):
        self.d.arc(self._b(box), ini, fim, fill=cor, width=int(largura * SS))

    def salvar(self, destino: Path) -> None:
        self.img.resize((self.img.width // SS, self.img.height // SS), Image.LANCZOS).save(destino)


def _curva(p0, p1, p2, n: int = 24):
    """Curva de Bézier quadrática como lista de pontos."""
    out = []
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]
        out.append((x, y))
    return out


# ---------------------------------------------------------------------------
# Bocas (comuns aos dois personagens, na escala de cada um)
# ---------------------------------------------------------------------------
def desenhar_boca(forma: str, cx: float, cy: float, s: float, labio: str) -> Lapis:
    """Um formato de boca do Rhubarb, centrado em (cx, cy), escala s."""
    L = Lapis()

    def oval(w, h, dy=0.0):
        return [cx - w * s, cy - h * s + dy * s, cx + w * s, cy + h * s + dy * s]

    if forma == "X":                                    # repouso: boca fechada, leve sorriso
        L.linha(_curva((cx - 44 * s, cy), (cx, cy + 12 * s), (cx + 44 * s, cy)), 7 * s)
    elif forma == "A":                                  # M, B, P: lábios apertados
        L.poligono(_curva((cx - 40 * s, cy), (cx, cy - 9 * s), (cx + 40 * s, cy))
                   + _curva((cx + 40 * s, cy), (cx, cy + 14 * s), (cx - 40 * s, cy))[1:],
                   labio, 6 * s)
        L.linha([(cx - 40 * s, cy), (cx + 40 * s, cy)], 6 * s)
    elif forma == "B":                                  # consoantes: dentes quase fechados
        L.poligono([(cx - 42 * s, cy - 8 * s), (cx + 42 * s, cy - 8 * s),
                    (cx + 34 * s, cy + 12 * s), (cx - 34 * s, cy + 12 * s)], DENTES, 6 * s)
        L.linha([(cx - 38 * s, cy + 2 * s), (cx + 38 * s, cy + 2 * s)], 3 * s)
    elif forma == "C":                                  # E, É: aberta média
        L.elipse(oval(46, 26), BOCA_DENTRO, 7 * s)
        L.poligono([(cx - 36 * s, cy - 18 * s), (cx + 36 * s, cy - 18 * s),
                    (cx + 30 * s, cy - 6 * s), (cx - 30 * s, cy - 6 * s)], DENTES, 0)
    elif forma == "D":                                  # A: bem aberta
        L.elipse(oval(50, 44, 6), BOCA_DENTRO, 7 * s)
        L.poligono([(cx - 38 * s, cy - 30 * s), (cx + 38 * s, cy - 30 * s),
                    (cx + 32 * s, cy - 18 * s), (cx - 32 * s, cy - 18 * s)], DENTES, 0)
        L.elipse(oval(30, 14, 34), LINGUA, 0)
    elif forma == "E":                                  # Ó: arredondada
        L.elipse(oval(32, 32, 2), BOCA_DENTRO, 7 * s)
        L.elipse(oval(18, 9, 22), LINGUA, 0)
    elif forma == "F":                                  # U, O fechado: biquinho
        L.elipse(oval(22, 24), labio, 7 * s)
        L.elipse(oval(10, 12), BOCA_DENTRO, 0)
    elif forma == "G":                                  # F, V: dentes no lábio de baixo
        L.poligono([(cx - 40 * s, cy - 10 * s), (cx + 40 * s, cy - 10 * s),
                    (cx + 34 * s, cy + 14 * s), (cx - 34 * s, cy + 14 * s)], BOCA_DENTRO, 6 * s)
        L.poligono([(cx - 34 * s, cy - 10 * s), (cx + 34 * s, cy - 10 * s),
                    (cx + 30 * s, cy + 4 * s), (cx - 30 * s, cy + 4 * s)], DENTES, 0)
        L.linha(_curva((cx - 36 * s, cy + 12 * s), (cx, cy + 20 * s), (cx + 36 * s, cy + 12 * s)), 6 * s)
    elif forma == "H":                                  # L: língua no céu da boca
        L.elipse(oval(44, 34, 4), BOCA_DENTRO, 7 * s)
        L.elipse(oval(26, 14, -10), LINGUA, 0)
    else:
        raise ValueError(f"formato de boca desconhecido: {forma}")
    return L


# ---------------------------------------------------------------------------
# Vô
# ---------------------------------------------------------------------------
PELE_VO = "#A8693F"
PELE_VO_SOMBRA = "#7E4B2B"
CAMISA_VO = "#8E2F24"
CHAPEU = "#6B4423"
CHAPEU_ESCURO = "#4A2E17"
CINZA = "#D2CEC4"


def _vo(pasta: Path) -> None:
    pasta.mkdir(parents=True, exist_ok=True)
    # corpo: camisa de botão aberta no peito
    c = Lapis()
    c.poligono([(130, 1500), (190, 1090), (360, 975), (640, 975), (810, 1090), (870, 1500)], CAMISA_VO, 8)
    c.poligono([(420, 975), (580, 975), (500, 1170)], PELE_VO, 6)           # peito aberto
    c.poligono([(360, 975), (440, 975), (500, 1170), (455, 1200)], "#A8473A", 6)   # gola esquerda
    c.poligono([(640, 975), (560, 975), (500, 1170), (545, 1200)], "#A8473A", 6)   # gola direita
    for y in (1240, 1330, 1420):
        c.elipse([492, y, 508, y + 16], LAMPARINA, 3)
    c.linha([(500, 1200), (500, 1500)], 4)
    c.linha([(250, 1150), (225, 1500)], 5)                                   # vincos das mangas
    c.linha([(750, 1150), (775, 1500)], 5)
    c.poligono([(445, 880), (555, 880), (565, 1000), (435, 1000)], PELE_VO, 7)   # pescoço
    c.linha([(470, 930), (500, 960), (530, 930)], 4)
    c.salvar(pasta / "corpo.png")

    # cabeça: rosto, orelhas, nariz, rugas e chapéu de couro
    k = Lapis()
    k.elipse([300, 640, 360, 760], PELE_VO, 7)                               # orelhas
    k.elipse([640, 640, 700, 760], PELE_VO, 7)
    k.poligono([(335, 560), (665, 560), (680, 700), (640, 845), (560, 905),
                (440, 905), (360, 845), (320, 700)], PELE_VO, 8)             # rosto
    k.poligono([(492, 640), (520, 760), (548, 778), (500, 790), (462, 776), (480, 760)],
               PELE_VO_SOMBRA, 6)                                             # nariz grande
    k.linha(_curva((440, 770), (420, 820), (432, 860)), 4)                  # rugas do riso
    k.linha(_curva((560, 770), (580, 820), (568, 860)), 4)
    for dy in (0, 22):                                                       # testa franzida
        k.linha(_curva((420, 585 + dy), (500, 575 + dy), (580, 585 + dy)), 4)
    k.linha([(360, 700), (380, 712)], 3)
    k.linha([(640, 700), (620, 712)], 3)
    # chapéu de couro nordestino: copa + aba virada com estrelas de cordel
    k.poligono([(360, 545), (380, 330), (500, 300), (620, 330), (640, 545)], CHAPEU, 8)
    k.poligono([(375, 470), (625, 470), (632, 520), (368, 520)], CHAPEU_ESCURO, 6)
    for i in range(6):                                                       # faixa trançada
        x = 385 + i * 41
        k.poligono([(x, 520), (x + 20, 472), (x + 40, 520)], LAMPARINA, 3)
    aba = (_curva((150, 560), (500, 470), (850, 560), 30)
           + _curva((850, 560), (500, 640), (150, 560), 30)[1:])
    k.poligono(aba, CHAPEU, 8)
    k.poligono(_curva((330, 545), (500, 420), (670, 545), 20)
               + _curva((670, 545), (500, 505), (330, 545), 20)[1:], CHAPEU_ESCURO, 6)   # aba levantada na frente
    for ang in range(0, 360, 45):                                            # estrela do chapéu
        r = 28 if ang % 90 == 0 else 14
        k.linha([(500, 510), (500 + r * math.cos(math.radians(ang)), 510 + r * math.sin(math.radians(ang)))], 4, LAMPARINA)
    k.salvar(pasta / "cabeca.png")

    # frente: bigode grisalho por cima da boca
    f = Lapis()
    f.poligono(_curva((408, 838), (450, 772), (500, 790), 14) + _curva((500, 790), (550, 772), (592, 838), 14)[1:]
               + [(566, 828), (540, 812), (500, 818), (460, 812), (434, 828)], CINZA, 6)
    for x in (450, 475, 525, 550):
        f.linha([(x, 795), (x + (6 if x > 500 else -6), 818)], 2)
    f.salvar(pasta / "frente.png")

    _olhos(pasta, ((432, 680), (568, 680)), raio=(26, 16), pupila=11, palpebra=True)
    _sobrancelhas(pasta, ((432, 640), (568, 640)), CINZA, grossura=16)
    for forma in FORMAS_BOCA:
        desenhar_boca(forma, 500, 850, 0.92, "#8A4A33").salvar(pasta / f"boca_{forma}.png")
    _rig(pasta, nome="Vô", pivo=(500, 905), caixa=(140, 280, 860, 930))


# ---------------------------------------------------------------------------
# Lucas
# ---------------------------------------------------------------------------
PELE_LUCAS = "#C08552"
PELE_LUCAS_SOMBRA = "#9A6640"
CAMISETA = "#4E7458"
CABELO = "#1A1414"


def _lucas(pasta: Path) -> None:
    pasta.mkdir(parents=True, exist_ok=True)
    c = Lapis()
    c.poligono([(190, 1500), (240, 1100), (390, 1015), (610, 1015), (760, 1100), (810, 1500)], CAMISETA, 8)
    c.linha(_curva((420, 1020), (500, 1075), (580, 1020)), 6)                 # gola redonda
    c.linha([(280, 1180), (265, 1500)], 5)
    c.linha([(720, 1180), (735, 1500)], 5)
    for x, y in ((380, 1240), (610, 1320), (450, 1400)):                    # camiseta desbotada
        c.linha([(x, y), (x + 40, y + 6)], 3, "#6E9478")
    c.poligono([(455, 925), (545, 925), (552, 1030), (448, 1030)], PELE_LUCAS, 7)
    c.salvar(pasta / "corpo.png")

    k = Lapis()
    k.elipse([270, 690, 335, 800], PELE_LUCAS, 7)
    k.elipse([665, 690, 730, 800], PELE_LUCAS, 7)
    k.elipse([300, 480, 700, 950], PELE_LUCAS, 8)                            # cabeça redonda de menino
    k.linha(_curva((488, 770), (478, 812), (508, 818)), 5)                  # nariz pequeno
    k.elipse([370, 800, 410, 822], "#D29A6A", 0)                             # bochechas
    k.elipse([590, 800, 630, 822], "#D29A6A", 0)
    # cabelo curto cortado em casa, franja torta
    cabelo = [(300, 680), (290, 590), (330, 520), (410, 470), (500, 458), (590, 470),
              (670, 520), (710, 590), (700, 680), (672, 640), (650, 600), (620, 625),
              (600, 590), (570, 620), (540, 588), (505, 618), (470, 586), (440, 616),
              (410, 585), (382, 622), (352, 595), (330, 640)]
    k.poligono(cabelo, CABELO, 7)
    k.salvar(pasta / "cabeca.png")
    Lapis().salvar(pasta / "frente.png")                                     # sem bigode

    _olhos(pasta, ((420, 728), (580, 728)), raio=(36, 30), pupila=16, palpebra=False, brilho=True)
    _sobrancelhas(pasta, ((420, 670), (580, 670)), CABELO, grossura=11)
    for forma in FORMAS_BOCA:
        desenhar_boca(forma, 500, 872, 0.85, "#9A5A3E").salvar(pasta / f"boca_{forma}.png")
    _rig(pasta, nome="Lucas", pivo=(500, 950), caixa=(250, 440, 750, 980))


# ---------------------------------------------------------------------------
# Peças comuns
# ---------------------------------------------------------------------------
def _olhos(pasta: Path, centros, raio, pupila: int, palpebra: bool, brilho: bool = False) -> None:
    rx, ry = raio
    a = Lapis()
    for cx, cy in centros:
        a.elipse([cx - rx, cy - ry, cx + rx, cy + ry], PAPEL, 6)
        a.elipse([cx - pupila, cy - pupila + 2, cx + pupila, cy + pupila + 2], PRETO, 0)
        if brilho:
            a.elipse([cx + 3, cy - 8, cx + 11, cy], "white", 0)
        if palpebra:                                    # pálpebra pesada de quem já viveu muito
            a.poligono([(cx - rx - 2, cy - 2), (cx, cy - ry - 8), (cx + rx + 2, cy - 2),
                        (cx + rx, cy - ry + 2), (cx, cy - ry - 2), (cx - rx, cy - ry + 2)], PELE_VO_SOMBRA, 4)
    a.salvar(pasta / "olhos_abertos.png")
    f = Lapis()
    for cx, cy in centros:
        f.linha(_curva((cx - rx, cy), (cx, cy + ry * 0.7), (cx + rx, cy)), 6)
    f.salvar(pasta / "olhos_fechados.png")


def _sobrancelhas(pasta: Path, centros, cor: str, grossura: int) -> None:
    formas = {                                             # (deslocamento da ponta de dentro, de fora)
        "neutro": (0, 0, 0),
        "feliz": (-6, -14, 6),
        "serio": (14, -6, 0),
        "surpreso": (-22, -22, -6),
    }
    for nome, (dentro, fora, meio) in formas.items():
        s = Lapis()
        for i, (cx, cy) in enumerate(centros):
            lado = -1 if i == 0 else 1
            p_fora = (cx + lado * 42, cy + fora)
            p_dentro = (cx - lado * 38, cy + dentro)
            s.linha(_curva(p_dentro, (cx, cy - 10 + meio), p_fora), grossura, cor)
            s.linha(_curva(p_dentro, (cx, cy - 10 + meio), p_fora), 3, PRETO)
        s.salvar(pasta / f"sobrancelhas_{nome}.png")


def _rig(pasta: Path, nome: str, pivo, caixa) -> None:
    rig = {
        "nome": nome,
        "tamanho": [W, H],
        "pivo_cabeca": list(pivo),                   # pescoço: a cabeça gira em torno daqui
        "caixa_cabeca": list(caixa),                 # recorte com cabeça, olhos, boca e chapéu
        "camadas_cabeca": ["cabeca", "olhos", "sobrancelhas", "boca", "frente"],
        "bocas": list(FORMAS_BOCA),
        "expressoes": list(EXPRESSOES),
    }
    (pasta / "rig.json").write_text(json.dumps(rig, ensure_ascii=False, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Cenário: beira do Araguaia no fim de tarde (palco 2880x1620)
# ---------------------------------------------------------------------------
PALCO = (2880, 1620)


def cenario_beira_rio(destino: Path) -> None:
    import random
    rng = random.Random(7)
    w, h = PALCO
    L = Lapis(w, h)
    faixas = [(0, ACAI), (230, "#7A2A3E"), (420, URUCUM), (580, "#D8742A"), (700, LAMPARINA), (790, "#F2D27A")]
    for i, (y, cor) in enumerate(faixas):
        y2 = faixas[i + 1][0] if i + 1 < len(faixas) else 860
        L.poligono([(0, y), (w, y), (w, y2), (0, y2)], cor, 0)
    L.elipse([1950, 680, 2290, 1020], "#F6E08A", 8)                          # sol baixo
    for ang in range(195, 346, 15):
        a = math.radians(ang)
        L.linha([(2120 + 200 * math.cos(a), 850 + 200 * math.sin(a)),
                 (2120 + 290 * math.cos(a), 850 + 290 * math.sin(a))], 6)
    for x0 in range(0, w, 160):                                              # nuvens entalhadas
        if rng.random() < 0.35:
            y0 = rng.randint(120, 500)
            L.linha([(x0, y0), (x0 + rng.randint(120, 260), y0)], 5, "#2A1430")
    # mata da outra margem: copas recortadas
    topo = []
    x = 0
    while x <= w:
        topo.append((x, 820 - rng.randint(0, 90)))
        x += rng.randint(30, 70)
    topo.append((w, 820))
    L.poligono([(0, 900)] + topo + [(w, 900)], MATA, 7)
    for _ in range(60):
        tx = rng.randint(0, w)
        L.linha([(tx, 900), (tx + rng.randint(-8, 8), 840 + rng.randint(-30, 20))], 3, "#0F2218")
    # rio largo de água doce
    L.poligono([(0, 900), (w, 900), (w, 1180), (0, 1180)], RIO, 0)
    for _ in range(220):
        y = rng.randint(915, 1170)
        x = rng.randint(-50, w)
        L.linha([(x, y), (x + rng.randint(40, 140), y)], 4, "#3E2612" if rng.random() < .6 else "#8A5B30")
    for i in range(18):                                                      # reflexo do sol
        y = 920 + i * 14
        meia = 160 - i * 6
        L.linha([(2120 - meia, y), (2120 + meia, y)], 6, LAMPARINA)
    # praia de areia branca
    L.poligono(_curva((0, 1180), (1400, 1120), (w, 1190), 40) + [(w, h), (0, h)], PAPEL, 8)
    for _ in range(900):
        x, y = rng.randint(0, w), rng.randint(1200, h)
        L.elipse([x, y, x + 4, y + 4], "#B9AE94", 0)
    for _ in range(40):
        x, y = rng.randint(0, w), rng.randint(1220, h)
        L.linha([(x, y), (x + 60, y + 6)], 3, "#C9BFA6")
    # canoa de madeira encalhada ao fundo
    canoa = _curva((180, 1215), (520, 1300), (860, 1215), 30) + [(820, 1195), (220, 1195)]
    L.poligono(canoa, RIO, 7)
    L.linha([(240, 1210), (800, 1210)], 4, "#3E2612")
    L.linha([(700, 1080), (930, 1240)], 8, "#3E2612")                       # remo
    destino.parent.mkdir(parents=True, exist_ok=True)
    img = L.img.resize((w, h), Image.LANCZOS).convert("RGB")
    try:                                                                     # textura de madeira/papel da série
        import numpy as np
        from ..agentes.estilo import _textura
        arr = np.asarray(img).astype("float32") * _textura(h, w)
        img = Image.fromarray(arr.clip(0, 255).astype("uint8"))
    except ImportError:
        pass
    img.save(destino, quality=95)


def garantir(pasta_bonecos: Path = PASTA_BONECOS, pasta_cenarios: Path = PASTA_CENARIOS) -> None:
    """Desenha o que estiver faltando (não sobrescreve arte trocada por vocês)."""
    if not (pasta_bonecos / "vo" / "rig.json").exists():
        _vo(pasta_bonecos / "vo")
    if not (pasta_bonecos / "lucas" / "rig.json").exists():
        _lucas(pasta_bonecos / "lucas")
    if not (pasta_cenarios / "beira_rio_entardecer.jpg").exists():
        cenario_beira_rio(pasta_cenarios / "beira_rio_entardecer.jpg")


if __name__ == "__main__":
    _vo(PASTA_BONECOS / "vo")
    _lucas(PASTA_BONECOS / "lucas")
    cenario_beira_rio(PASTA_CENARIOS / "beira_rio_entardecer.jpg")
    print(f"Bonecos em {PASTA_BONECOS} e cenário em {PASTA_CENARIOS}")
