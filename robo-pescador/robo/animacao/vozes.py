"""Vozes dos personagens: uma voz diferente para cada um.

Dois motores, os dois gratuitos:
- edge (padrão): vozes neurais da Microsoft pelo edge-tts. Melhor qualidade,
  precisa de internet.
- piper: roda no próprio computador, sem internet e sem limite. As vozes são
  baixadas uma vez pelo instalar.bat (ferramentas/baixar.py).

Se o edge falhar (sem internet, serviço fora), o robô usa o piper e avisa.
Configuração por personagem em config/serie.yaml (animacao.vozes).
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
import wave
from pathlib import Path

from ..config import RAIZ
from .. import midia

PASTA_PIPER = RAIZ / "modelos" / "piper"
TAXA = 44100


class ErroVoz(RuntimeError):
    pass


def _edge(texto: str, cfg_voz: dict, destino_mp3: Path) -> None:
    import edge_tts

    async def falar():
        await edge_tts.Communicate(texto, cfg_voz["voz"], rate=cfg_voz.get("velocidade", "+0%"),
                                   pitch=cfg_voz.get("tom", "+0Hz")).save(str(destino_mp3))
    asyncio.run(falar())


def _piper(texto: str, cfg_voz: dict, destino_wav: Path) -> None:
    modelo = PASTA_PIPER / f"{cfg_voz['modelo']}.onnx"
    if not modelo.exists():
        raise ErroVoz(f"Voz do piper não encontrada: {modelo}. Rode: python ferramentas\\baixar.py")
    args = [sys.executable, "-m", "piper", "-m", str(modelo), "-f", str(destino_wav),
            "--length-scale", str(cfg_voz.get("lentidao", 1.0))]
    proc = subprocess.run(args, input=texto, capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0 or not destino_wav.exists():
        raise ErroVoz(f"piper falhou: {proc.stderr[-500:]}")


def _para_wav(origem: Path, destino: Path, tom: float = 1.0) -> None:
    """Converte para WAV mono 44,1 kHz; `tom` > 1 deixa a voz mais aguda sem mudar a velocidade.
    Depois corta só o silêncio do começo e do fim (o meio da fala fica intacto)."""
    filtros = []
    if abs(tom - 1.0) > 1e-3:
        filtros += [f"aresample={TAXA}", f"asetrate={TAXA}*{tom:.4f}", f"aresample={TAXA}", f"atempo={1 / tom:.4f}"]
    args = ["-i", str(origem)]
    if filtros:
        args += ["-af", ",".join(filtros)]
    midia.rodar(args + ["-ar", str(TAXA), "-ac", "1", "-c:a", "pcm_s16le", str(destino)])
    _aparar(destino)


def _aparar(caminho: Path, limiar_db: float = -45.0, folga: float = 0.04) -> None:
    import numpy as np
    amostras, taxa = ler_wav(caminho)
    if len(amostras) == 0:
        raise ErroVoz(f"{caminho.name}: áudio vazio")
    janela = max(1, taxa // 100)                              # 10 ms
    n = len(amostras) // janela
    x = amostras[: n * janela].astype(np.float32) / 32768.0
    rms = np.sqrt((x.reshape(n, janela) ** 2).mean(axis=1) + 1e-12)
    voz = np.where(20 * np.log10(rms) > limiar_db)[0]
    if len(voz) == 0:
        return
    ini = max(0, voz[0] * janela - int(folga * taxa))
    fim = min(len(amostras), (voz[-1] + 1) * janela + int(folga * taxa))
    with wave.open(str(caminho), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(taxa)
        w.writeframes(amostras[ini:fim].tobytes())



def falar(texto: str, personagem: str, vozes: dict, motor: str, destino_wav: Path) -> str:
    """Grava a fala em `destino_wav` e devolve o motor usado ("edge" ou "piper")."""
    if destino_wav.exists() and destino_wav.stat().st_size > 2000:
        return "existente"
    cfg = vozes.get(personagem)
    if not cfg:
        raise ErroVoz(f"Personagem sem voz configurada em serie.yaml (animacao.vozes): {personagem}")
    bruto = destino_wav.with_suffix(".bruto")
    if motor == "edge":
        try:
            mp3 = bruto.with_suffix(".mp3")
            for n in range(3):
                try:
                    _edge(texto, cfg["edge"], mp3)
                    break
                except Exception:  # noqa: BLE001 — rede/serviço
                    if n == 2:
                        raise
            _para_wav(mp3, destino_wav)
            mp3.unlink(missing_ok=True)
            return "edge"
        except Exception as e:  # noqa: BLE001
            if not (PASTA_PIPER / f"{cfg['piper']['modelo']}.onnx").exists():
                raise ErroVoz(f"edge-tts falhou ({type(e).__name__}) e não há voz offline instalada.") from e
            print(f"   aviso: edge-tts falhou ({type(e).__name__}); usando a voz offline (piper)")
    tmp = bruto.with_suffix(".piper.wav")
    _piper(texto, cfg["piper"], tmp)
    _para_wav(tmp, destino_wav, float(cfg["piper"].get("tom", 1.0)))
    tmp.unlink(missing_ok=True)
    return "piper"


def ler_wav(caminho: Path):
    """Amostras int16 mono e a taxa."""
    import numpy as np
    with wave.open(str(caminho), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ErroVoz(f"{caminho.name}: esperado WAV mono 16 bits")
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16), w.getframerate()


def envelope(caminho: Path, fps: int) -> list[float]:
    """Volume da fala por quadro (0..1), suavizado: move a cabeça de quem fala."""
    import numpy as np
    amostras, taxa = ler_wav(caminho)
    passo = max(1, taxa // fps)
    n = len(amostras) // passo + 1
    x = np.zeros(n * passo, dtype=np.float32)
    x[:len(amostras)] = amostras.astype(np.float32) / 32768.0
    rms = np.sqrt((x.reshape(n, passo) ** 2).mean(axis=1))
    pico = float(np.percentile(rms, 95)) or 1.0
    env = np.clip(rms / pico, 0, 1)
    suave = np.convolve(env, np.ones(5) / 5, mode="same")
    return suave.tolist()


def amostras(frase: str, candidatas: dict[str, dict], pasta: Path) -> tuple[list[tuple[str, Path]], list[str]]:
    """Grava a mesma frase com cada configuração candidata (edge-tts) em MP3.
    Devolve [(rótulo, arquivo)] das que deram certo e a lista de falhas."""
    pasta.mkdir(parents=True, exist_ok=True)
    feitas, falhas = [], []
    for rotulo, cfg_voz in candidatas.items():
        destino = pasta / f"{rotulo}.mp3"
        legenda = f"{rotulo}: {cfg_voz['voz'].replace('pt-BR-', '').replace('Neural', '')} " \
                  f"velocidade {cfg_voz.get('velocidade', '+0%')} tom {cfg_voz.get('tom', '+0Hz')}"
        try:
            _edge(frase, cfg_voz, destino)
            if not destino.exists() or destino.stat().st_size < 1000:
                raise ErroVoz("áudio vazio")
            feitas.append((legenda, destino))
        except Exception as e:  # noqa: BLE001 — voz inexistente, rede etc.
            falhas.append(f"{rotulo} ({cfg_voz['voz']}): {type(e).__name__}")
    return feitas, falhas
