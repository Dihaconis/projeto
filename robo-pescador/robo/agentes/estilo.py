"""Filtro de xilogravura de cordel, feito no próprio computador.

Pega qualquer imagem (de qualquer gerador) e deixa com cara de gravura
impressa: poucas cores chapadas da paleta da série, contornos pretos grossos
e textura de papel/madeira. Assim todos os vídeos têm o mesmo estilo, mesmo
quando o gerador grátis devolve algo com cara de foto.
"""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

# Paleta da série, do escuro para o claro (RGB)
PALETA = [
    (17, 12, 14),      # preto de tinta
    (75, 31, 79),      # roxo-açaí
    (31, 59, 42),      # verde-mata
    (107, 68, 35),     # marrom-rio
    (179, 38, 30),     # vermelho-urucum
    (232, 184, 40),    # amarelo-lamparina
    (239, 230, 210),   # papel
]


def _cor_mais_proxima(img: np.ndarray, paleta: np.ndarray) -> np.ndarray:
    """Troca cada pixel pela cor da paleta mais parecida (em espaço Lab)."""
    peso = np.array([2.0, 1.0, 1.0], dtype=np.float32)   # luminosidade pesa mais: desenho legível
    lab = cv2.cvtColor(img, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32) * peso
    pal_lab = cv2.cvtColor(paleta.reshape(1, -1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32) * peso
    melhor = np.full(lab.shape[0], np.inf, dtype=np.float32)
    idx = np.zeros(lab.shape[0], dtype=np.uint8)
    for i, cor in enumerate(pal_lab):                    # uma cor por vez: usa pouca memória
        d = ((lab - cor) ** 2).sum(axis=1)
        menor = d < melhor
        melhor[menor] = d[menor]
        idx[menor] = i
    return paleta[idx].reshape(img.shape)


def _textura(altura: int, largura: int, semente: int = 7) -> np.ndarray:
    """Veios de madeira na horizontal + granulado de papel, valores perto de 1."""
    rng = np.random.default_rng(semente)
    veios = rng.normal(0, 1, (altura, 1)).astype(np.float32)
    veios = cv2.GaussianBlur(veios, (1, 0), sigmaX=0, sigmaY=3)
    veios = np.repeat(veios, largura, axis=1)
    ondas = cv2.GaussianBlur(rng.normal(0, 1, (altura // 8, largura // 8)).astype(np.float32), (0, 0), 3)
    ondas = cv2.resize(ondas, (largura, altura))
    grao = rng.normal(0, 1, (altura, largura)).astype(np.float32)
    tex = 1 + 0.035 * veios + 0.03 * ondas + 0.025 * grao
    return np.clip(tex, 0.85, 1.1)[..., None]


def aplicar_xilogravura(origem: Path, destino: Path, forca_linhas: int = 9) -> Path:
    """Aplica o estilo da série numa imagem e salva em `destino` (pode ser o mesmo arquivo)."""
    bgr = cv2.imread(str(origem))
    if bgr is None:
        raise ValueError(f"Não consegui abrir a imagem {origem}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    altura, largura = rgb.shape[:2]

    # 1) tira o "jeito de foto": alisa as áreas mantendo as bordas.
    #    Feito em meia resolução (4x mais rápido); as cores chapadas não perdem nada com isso.
    pequeno = cv2.resize(rgb, (largura // 2, altura // 2), interpolation=cv2.INTER_AREA)
    for _ in range(2):
        pequeno = cv2.bilateralFilter(pequeno, 7, 60, 60)
    pequeno = cv2.convertScaleAbs(pequeno, alpha=1.25, beta=-15)  # mais contraste

    # 2) cores chapadas da paleta
    paleta = np.array(PALETA, dtype=np.uint8)
    chapado = _cor_mais_proxima(pequeno, paleta)
    chapado = cv2.medianBlur(chapado, 3)                        # limpa pontinhos soltos
    chapado = cv2.resize(chapado, (largura, altura), interpolation=cv2.INTER_NEAREST)

    # 3) contornos pretos grossos, como entalhe na madeira
    cinza = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    cinza = cv2.medianBlur(cinza, 7)
    linhas = cv2.adaptiveThreshold(cinza, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                   cv2.THRESH_BINARY, forca_linhas * 2 + 1, 5)
    linhas = cv2.erode(linhas, np.ones((2, 2), np.uint8))      # engrossa o traço
    mascara = (linhas < 128)[..., None]
    gravura = np.where(mascara, np.array(PALETA[0], dtype=np.uint8), chapado)

    # 4) textura de papel e madeira
    final = np.clip(gravura.astype(np.float32) * _textura(altura, largura), 0, 255).astype(np.uint8)
    cv2.imwrite(str(destino), cv2.cvtColor(final, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    return destino
