"""Animador: monta o vídeo quadro a quadro e entrega o MP4.

Para cada quadro: cenário + bonecos no estado certo (boca da fala, piscar,
respiração, cabeça mexendo com o volume da voz), câmera (plano geral ou
close em quem fala, com aproximação lenta) e legenda. Os quadros vão direto
para o FFmpeg por um cano (sem gravar milhares de imagens no disco).
"""
from __future__ import annotations

import math
import random
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from ..config import RAIZ
from .bonecos import Boneco, Estado
from .labios import Boca
from .vozes import TAXA, envelope, ler_wav

FPS = 30
SAIDA = (1920, 1080)
FONTE = RAIZ / "midia" / "fontes" / "Anton-Regular.ttf"
COR_LEGENDA = {"vo": "#E8B828", "lucas": "#FFFFFF"}


@dataclass
class Fala:
    quem: str
    texto: str
    expressao: str = "neutro"
    reacao: str = "neutro"          # expressão de quem está ouvindo
    wav: Path | None = None
    cues: list[dict] = field(default_factory=list)
    inicio: float = 0.0
    duracao: float = 0.0
    env: list[float] = field(default_factory=list)

    @property
    def fim(self) -> float:
        return self.inicio + self.duracao


@dataclass
class Plano:
    inicio: float
    fim: float
    alvo: str                       # "geral" ou id do personagem em close


def linha_do_tempo(falas: list[Fala], respiro: float, entrada: float = 0.6, saida: float = 1.2) -> float:
    """Distribui as falas no tempo e devolve a duração total do vídeo."""
    t = entrada
    for f in falas:
        f.inicio = t
        t = f.fim + respiro
    return (falas[-1].fim if falas else 0.0) + saida


def planejar_camera(falas: list[Fala], total: float) -> list[Plano]:
    """Corta para o close de quem fala nas falas longas; volta ao geral a cada 3 falas
    e quando quem fala muda rápido. Assim parece desenho editado, não câmera parada."""
    planos: list[Plano] = []
    for i, f in enumerate(falas):
        geral = f.duracao < 2.5 or i % 3 == 0
        planos.append(Plano(f.inicio if i else 0.0, 0.0, "geral" if geral else f.quem))
    if not planos:
        return [Plano(0.0, total, "geral")]
    for a, b in zip(planos, planos[1:]):
        a.fim = b.inicio
    planos[-1].fim = total
    unidos = [planos[0]]                     # junta planos iguais seguidos (sem corte à toa)
    for p in planos[1:]:
        if p.alvo == unidos[-1].alvo:
            unidos[-1].fim = p.fim
        else:
            unidos.append(p)
    return unidos


class Piscar:
    """Piscadas em intervalos naturais (2,5 a 5,5 s), diferentes para cada personagem."""

    def __init__(self, semente: str, total: float):
        rng = random.Random(semente)
        self.momentos = []
        t = rng.uniform(0.8, 2.5)
        while t < total:
            self.momentos.append(t)
            t += rng.uniform(2.5, 5.5)

    def fechado(self, t: float) -> bool:
        return any(m <= t < m + 0.13 for m in self.momentos)


def _fonte(tamanho: int):
    try:
        return ImageFont.truetype(str(FONTE), tamanho)
    except OSError:
        return ImageFont.load_default(size=tamanho)


def pedacos_legenda(f: Fala, max_palavras: int = 7) -> list[tuple[float, float, str]]:
    """Quebra a fala em pedaços curtos, com o tempo dividido pelo número de letras."""
    palavras = f.texto.split()
    grupos = [" ".join(palavras[i:i + max_palavras]) for i in range(0, len(palavras), max_palavras)]
    total = sum(len(g) for g in grupos) or 1
    t, out = f.inicio, []
    for g in grupos:
        d = f.duracao * len(g) / total
        out.append((t, t + d, g))
        t += d
    return out


def _desenhar_legenda(img: Image.Image, texto: str, cor: str, fonte) -> None:
    d = ImageDraw.Draw(img)
    w, h = img.size
    linhas, atual = [], ""
    for p in texto.upper().split():
        teste = f"{atual} {p}".strip()
        if d.textlength(teste, font=fonte) > w * 0.78 and atual:
            linhas.append(atual)
            atual = p
        else:
            atual = teste
    linhas.append(atual)
    alt = fonte.size + 14
    y = h - 70 - alt * len(linhas)
    for linha in linhas:
        lw = d.textlength(linha, font=fonte)
        d.text(((w - lw) / 2, y), linha, font=fonte, fill=cor, stroke_width=6, stroke_fill="#111111")
        y += alt


@dataclass
class Ator:
    id: str
    boneco: Boneco
    x: int
    y: int
    fase: float                      # defasagem da respiração e do balanço


class Cena:
    def __init__(self, cenario: Path, atores: list[Ator], falas: list[Fala], total: float,
                 saida: tuple[int, int] = SAIDA, legenda: bool = True):
        self.fundo = Image.open(cenario).convert("RGB")
        self.atores = atores
        self.falas = falas
        self.total = total
        self.saida = saida
        self.legenda = legenda
        self.planos = planejar_camera(falas, total)
        self.piscar = {a.id: Piscar(a.id, total) for a in atores}
        self.bocas = [Boca(f.cues) for f in falas]
        self.legendas = [(a, b, txt, f.quem) for f in falas for a, b, txt in pedacos_legenda(f)]
        self.fonte = _fonte(round(saida[1] * 0.062))

    # -- câmera ----------------------------------------------------------
    def _caixa(self, plano: Plano, t: float) -> tuple[float, float, float, float]:
        pw, ph = self.fundo.size
        prog = (t - plano.inicio) / max(0.1, plano.fim - plano.inicio)
        zoom = 1.0 + 0.05 * prog                         # aproximação lenta durante o plano
        if plano.alvo == "geral":
            larg, cx, cy = pw / zoom, pw / 2, ph / 2
        else:
            ator = next(a for a in self.atores if a.id == plano.alvo)
            hx, hy = ator.boneco.centro_cabeca()
            larg = pw * 0.55 / zoom
            cx, cy = ator.x + hx, ator.y + hy + ph * 0.06
        alt = larg * self.saida[1] / self.saida[0]
        x0 = min(max(0.0, cx - larg / 2), pw - larg)
        y0 = min(max(0.0, cy - alt / 2), ph - alt)
        return x0, y0, x0 + larg, y0 + alt

    # -- quadro ----------------------------------------------------------
    def estado(self, ator: Ator, t: float) -> Estado:
        falando = next(((i, f) for i, f in enumerate(self.falas) if f.inicio <= t < f.fim and f.quem == ator.id), None)
        respira = 4 * math.sin(2 * math.pi * t / 3.8 + ator.fase)
        if falando:
            i, f = falando
            rel = t - f.inicio
            k = min(len(f.env) - 1, int(rel * FPS)) if f.env else 0
            env = f.env[k] if f.env else 0.0
            return Estado(boca=self.bocas[i].em(rel), olhos_fechados=self.piscar[ator.id].fechado(t),
                          expressao=f.expressao,
                          angulo=2.2 * env * math.sin(2 * math.pi * 0.9 * t + ator.fase),
                          dy_cabeca=-8 * env, dy_corpo=respira)
        atual = next((f for f in self.falas if f.inicio - 0.3 <= t < f.fim + 0.3), None)
        reacao = atual.reacao if atual and atual.quem != ator.id else "neutro"
        return Estado(boca="X", olhos_fechados=self.piscar[ator.id].fechado(t), expressao=reacao,
                      angulo=0.6 * math.sin(2 * math.pi * 0.15 * t + ator.fase), dy_corpo=respira)

    def quadro(self, t: float) -> Image.Image:
        palco = self.fundo.copy()
        for a in self.atores:
            a.boneco.colar(palco, a.x, a.y, self.estado(a, t))
        plano = next((p for p in self.planos if p.inicio <= t < p.fim), self.planos[-1])
        img = palco.resize(self.saida, Image.BILINEAR, box=self._caixa(plano, t))
        if self.legenda:
            leg = next(((txt, quem) for a, b, txt, quem in self.legendas if a <= t < b), None)
            if leg:
                _desenhar_legenda(img, leg[0], COR_LEGENDA.get(leg[1], "#FFFFFF"), self.fonte)
        return img


def mixar_audio(falas: list[Fala], total: float, destino: Path) -> Path:
    """Coloca cada fala no seu tempo numa faixa só (WAV mono 44,1 kHz)."""
    faixa = np.zeros(int(math.ceil(total * TAXA)) + 1, dtype=np.int32)
    for f in falas:
        amostras, taxa = ler_wav(f.wav)
        if taxa != TAXA:
            raise ValueError(f"{f.wav.name}: taxa {taxa}, esperado {TAXA}")
        i = int(round(f.inicio * TAXA))
        faixa[i:i + len(amostras)] += amostras[: len(faixa) - i]
    import wave
    with wave.open(str(destino), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TAXA)
        w.writeframes(np.clip(faixa, -32768, 32767).astype(np.int16).tobytes())
    return destino


def renderizar(cena: Cena, audio_vozes: Path, destino: Path, musica: Path | None = None,
               progresso=print) -> Path:
    """Gera o MP4 (H.264 + AAC, -14 LUFS). Com música, ela abaixa sozinha sob as vozes."""
    w, h = cena.saida
    n_quadros = int(round(cena.total * FPS))
    entradas = ["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-",
                "-i", str(audio_vozes)]
    if musica and musica.exists():
        entradas += ["-stream_loop", "-1", "-i", str(musica)]
        filtro = ("[1:a]asplit=2[voz][chave];"
                  "[2:a]volume=0.35[mus];"
                  "[mus][chave]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[duck];"
                  "[voz][duck]amix=inputs=2:duration=first:normalize=0,"
                  "loudnorm=I=-14:TP=-1.5:LRA=11[a]")
    else:
        filtro = "[1:a]loudnorm=I=-14:TP=-1.5:LRA=11[a]"
    args = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *entradas,
            "-filter_complex", filtro, "-map", "0:v", "-map", "[a]",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-t", f"{cena.total:.3f}",
            "-movflags", "+faststart", str(destino)]
    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    ultimo = -1
    try:
        for n in range(n_quadros):
            proc.stdin.write(cena.quadro(n / FPS).tobytes())
            pct = n * 100 // max(1, n_quadros)
            if pct // 10 != ultimo // 10:
                progresso(f"   animando... {pct}%")
                ultimo = pct
        proc.stdin.close()
    except BrokenPipeError:
        pass
    erro = proc.stderr.read().decode(errors="replace")
    if proc.wait() != 0:
        raise RuntimeError(f"FFmpeg falhou ao montar a animação: {erro[-1500:]}")
    return destino


def preparar_envelopes(falas: list[Fala]) -> None:
    for f in falas:
        f.env = envelope(f.wav, FPS)
