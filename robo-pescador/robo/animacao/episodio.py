"""Robô animador: transforma um roteiro em diálogo num desenho animado com boca sincronizada.

Roteiro animado (JSON), em roteiros_animados/ ou no Drive (roteiros_animados/):
    {
      "titulo": "...", "descricao": "...", "cenario": "beira_rio_entardecer",
      "falas": [ {"quem": "vo", "texto": "...", "expressao": "feliz", "reacao": "surpreso"}, ... ]
    }
`expressao` é a cara de quem fala; `reacao`, a de quem escuta.
Expressões: neutro, feliz, serio, surpreso.

Saída em saida/ANIM-<data>/: video_final.mp4, thumbnail.jpg, PACOTE.txt,
as falas (falas/*.wav) e a sincronia de boca (labios/*.json). Avisa no
Telegram pelo mesmo bot do robô.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path

from ..config import RAIZ, Config
from .. import midia, notificador
from ..agentes import diretor_arte
from . import desenho, labios, render, vozes
from .bonecos import Boneco

PASTA_ROTEIROS = RAIZ / "roteiros_animados"
PROVA = PASTA_ROTEIROS / "prova_o_ouro_do_rio.json"

# onde cada personagem fica no palco (2880x1620) e o tamanho do boneco
POSICOES = {"vo": (450, 260, 1.0), "lucas": (1520, 420, 0.86)}


def validar(roteiro: dict, personagens: set[str]) -> dict:
    falas = roteiro.get("falas") or []
    if len(falas) < 2:
        raise ValueError("Roteiro animado precisa de pelo menos 2 falas.")
    for i, f in enumerate(falas, start=1):
        if f.get("quem") not in personagens:
            raise ValueError(f"Fala {i}: personagem '{f.get('quem')}' não tem boneco ({', '.join(sorted(personagens))}).")
        if not str(f.get("texto", "")).strip():
            raise ValueError(f"Fala {i} sem texto.")
        for campo in ("expressao", "reacao"):
            if f.get(campo, "neutro") not in desenho.EXPRESSOES:
                raise ValueError(f"Fala {i}: {campo} '{f.get(campo)}' (use {', '.join(desenho.EXPRESSOES)}).")
    roteiro.setdefault("titulo", "Causo animado")
    roteiro.setdefault("cenario", "beira_rio_entardecer")
    return roteiro


def revisar(video: Path, falas: list[render.Fala], total: float) -> list[str]:
    problemas = []
    if not video.exists() or video.stat().st_size < 50_000:
        return ["O vídeo animado não foi gerado."]
    dur = midia.duracao(video)
    if abs(dur - total) > 0.5:
        problemas.append(f"Duração {dur:.1f} s diferente do esperado ({total:.1f} s).")
    if not midia.tem_audio(video):
        problemas.append("O vídeo saiu sem áudio.")
    for i, f in enumerate(falas, start=1):
        formas = {c["value"] for c in f.cues}
        if len(formas - {"X"}) < 2:
            problemas.append(f"Fala {i}: a boca quase não mexe (sincronia suspeita).")
    return problemas


def produzir_animado(cfg: Config, arquivo: Path | None = None) -> Path:
    arquivo = arquivo or PROVA
    roteiro = json.loads(Path(arquivo).read_text(encoding="utf-8"))
    for pid in POSICOES:
        if not (desenho.PASTA_BONECOS / pid / "rig.json").exists():
            raise SystemExit(
                f"Boneco '{pid}' ainda não foi montado em {desenho.PASTA_BONECOS / pid}. "
                "Os bonecos são montados a partir da arte já publicada da série (mesma feição); "
                "os desenhos de teste de desenho.py não devem ir para o canal.")
    if not (desenho.PASTA_CENARIOS / f"{roteiro.get('cenario', 'beira_rio_entardecer')}.jpg").exists():
        desenho.cenario_beira_rio(desenho.PASTA_CENARIOS / "beira_rio_entardecer.jpg")
    anim = cfg.serie.get("animacao", {})
    vozes_cfg = anim.get("vozes", {})
    motor = os.environ.get("VOZ_MOTOR", anim.get("motor_voz", "edge")).strip().lower()
    respiro = float(anim.get("respiro_segundos", 0.35))
    roteiro = validar(roteiro, set(POSICOES) & {p.name for p in desenho.PASTA_BONECOS.iterdir()})

    pasta = cfg.pasta_saida / f"ANIM-{datetime.now():%Y%m%d-%H%M%S}"
    (pasta / "falas").mkdir(parents=True, exist_ok=True)
    (pasta / "labios").mkdir(parents=True, exist_ok=True)
    (pasta / "roteiro.json").write_text(json.dumps(roteiro, ensure_ascii=False, indent=2), encoding="utf-8")
    inicio = time.time()
    print(f"🎬 Animando: {roteiro['titulo']} ({len(roteiro['falas'])} falas)")

    falas: list[render.Fala] = []
    usados = set()
    for i, f in enumerate(roteiro["falas"], start=1):
        wav = pasta / "falas" / f"fala_{i:03d}_{f['quem']}.wav"
        usados.add(vozes.falar(f["texto"], f["quem"], vozes_cfg, motor, wav))
        cues = labios.sincronizar(wav, pasta / "labios" / f"fala_{i:03d}.json", f["texto"])
        falas.append(render.Fala(f["quem"], f["texto"], f.get("expressao", "neutro"),
                                 f.get("reacao", "neutro"), wav, cues, duracao=midia.duracao(wav)))
        print(f"   fala {i}/{len(roteiro['falas'])} ({f['quem']}): {falas[-1].duracao:.1f} s")
    total = render.linha_do_tempo(falas, respiro)
    render.preparar_envelopes(falas)

    atores = []
    for fase, (pid, (x, y, escala)) in enumerate(POSICOES.items()):
        atores.append(render.Ator(pid, Boneco(desenho.PASTA_BONECOS / pid, escala), x, y, fase * 1.7))
    cenario = desenho.PASTA_CENARIOS / f"{roteiro['cenario']}.jpg"
    if not cenario.exists():
        raise FileNotFoundError(f"Cenário não encontrado: {cenario}")
    cena = render.Cena(cenario, atores, falas, total)

    audio = render.mixar_audio(falas, total, pasta / "vozes.wav")
    video = render.renderizar(cena, audio, pasta / "video_final.mp4", cfg.musica_fundo)

    quadro = pasta / "quadro_capa.jpg"
    cena.legenda = False
    meio = falas[len(falas) // 2]
    cena.quadro(meio.inicio + meio.duracao / 2).save(quadro, quality=92)
    capa = diretor_arte.capa_horizontal(quadro, roteiro.get("frase_capa") or roteiro["titulo"], pasta / "thumbnail.jpg")

    problemas = revisar(video, falas, total)
    gasto = time.time() - inicio
    pacote = (f"TÍTULO: {roteiro['titulo']}\n\nDESCRIÇÃO:\n{roteiro.get('descricao', '')}\n\n"
              f"Duração: {total:.0f} s · montado em {gasto / 60:.1f} min · vozes: {', '.join(sorted(usados))}\n")
    (pasta / "PACOTE.txt").write_text(pacote, encoding="utf-8")
    mensagem = (f"🎬 Desenho animado pronto: {roteiro['titulo']}\n"
                f"{total:.0f} s, boca sincronizada com a fala.\n"
                + ("⚠️ Confira: " + "; ".join(problemas) if problemas else "✅ Revisão sem problemas."))
    notificador.avisar(cfg, pasta, video, capa, mensagem)
    return pasta
