"""Episódio longo (~15 min, horizontal, para o YouTube) + cortes verticais de ~60 s.

Como funciona:
1. O roteiro longo (escrito pelo Claude) fica na fila roteiros_longos/ (no projeto ou no Drive).
   Ele tem capítulos e já diz quais trechos viram cortes.
2. As imagens saem do Colab em 16:9 (1344x768) e viram 1920x1080 no vídeo.
3. O vídeo longo ganha capítulos com o tempo certo (00:00 ...) na descrição do YouTube.
4. Cada corte vira um vídeo em pé (1080x1920): a imagem horizontal no meio, fundo desfocado,
   título em cima, legenda embaixo e um convite final para o episódio completo.
5. Tudo vai para <Drive>/prontos/<episódio>/ e o resumo chega no Telegram.
"""
from __future__ import annotations

import copy
import dataclasses
import json
import shutil
import time
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

from ..config import RAIZ, Config
from ..llm import ErroLLM
from .. import midia
from . import diretor_arte, editor, narrador

CTA_CORTE_PADRAO = "O causo completo tá no canal As Histórias de um Pescador, lá no YouTube."


# ---------------------------------------------------------------------------
# Roteiro
# ---------------------------------------------------------------------------
def validar_longo(roteiro: dict) -> dict:
    """Confere o roteiro longo e junta as cenas dos capítulos numa lista só.

    Cada cena ganha "capitulo" (índice) para calcular os tempos dos capítulos.
    Os cortes usam números de cena contando do 1, na ordem do episódio inteiro.
    """
    capitulos = roteiro.get("capitulos") or []
    if not capitulos:
        raise ErroLLM("Roteiro longo sem capítulos.")
    if "cenas" not in roteiro:
        cenas = []
        for n, cap in enumerate(capitulos):
            for cena in cap.get("cenas", []):
                cenas.append({**cena, "capitulo": n})
        roteiro["cenas"] = cenas
    cenas = roteiro["cenas"]
    if len(cenas) < 20:
        raise ErroLLM(f"Roteiro longo com só {len(cenas)} cenas (o mínimo é 20).")
    for i, c in enumerate(cenas, start=1):
        if not c.get("narracao") or not c.get("descricao_visual"):
            raise ErroLLM(f"Cena {i} sem narração ou sem descrição visual.")
    for corte in roteiro.get("cortes", []):
        de, ate = corte["cenas"]
        if not (1 <= de <= ate <= len(cenas)):
            raise ErroLLM(f"Corte {corte.get('titulo')} aponta para cenas que não existem ({de}-{ate}).")
    roteiro["tipo"] = "longo"
    roteiro.setdefault("titulo_episodio", "Causo longo sem nome")
    return roteiro


def _pastas_fila(cfg: Config) -> list[Path]:
    pastas = [RAIZ / "roteiros_longos"]
    if cfg.pasta_drive:
        pastas.append(cfg.pasta_drive / "roteiros_longos")
    return [p for p in pastas if p.exists()]


def pegar_da_fila(cfg: Config) -> tuple[dict, Path] | None:
    """Pega o roteiro longo mais antigo e move o arquivo para usados/ (ou com_erro/)."""
    for pasta in _pastas_fila(cfg):
        for arquivo in sorted(pasta.glob("*.json")):
            try:
                roteiro = validar_longo(json.loads(arquivo.read_text(encoding="utf-8")))
                destino = pasta / "usados"
            except (json.JSONDecodeError, ErroLLM, KeyError, TypeError, ValueError) as e:
                print(f"   roteiro longo {arquivo.name} com problema ({e}); separado em com_erro/")
                destino, roteiro = pasta / "com_erro", None
            destino.mkdir(exist_ok=True)
            shutil.move(str(arquivo), str(destino / arquivo.name))
            if roteiro:
                return roteiro, arquivo
    return None


# ---------------------------------------------------------------------------
# Capítulos e textos
# ---------------------------------------------------------------------------
def _relogio(segundos: float) -> str:
    s = int(segundos)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def capitulos_youtube(roteiro: dict, duracoes: list[float]) -> str:
    """Linhas "00:00 Título" para a descrição do YouTube (o primeiro sempre em 00:00)."""
    linhas, t, visto = [], 0.0, set()
    for cena, dur in zip(roteiro["cenas"], duracoes):
        n = cena.get("capitulo", 0)
        if n not in visto:
            visto.add(n)
            titulo = roteiro["capitulos"][n].get("titulo", f"Parte {n + 1}")
            linhas.append(f"{_relogio(0 if not linhas else t)} {titulo}")
        t += dur
    return "\n".join(linhas)


def _hashtags(cfg: Config, extras: list[str], limite: int) -> list[str]:
    fixas = cfg.serie["formato"]["hashtags_fixas"]
    tags = [t if t.startswith("#") else f"#{t}" for t in extras]
    return list(dict.fromkeys(fixas + tags))[:limite]


def texto_youtube(cfg: Config, roteiro: dict, duracoes: list[float]) -> str:
    t = roteiro.get("textos", {})
    tags = _hashtags(cfg, t.get("hashtags", []), 15)
    return "\n".join([
        f"TÍTULO: {t.get('titulo', roteiro['titulo_episodio'])[:100]}",
        "",
        "DESCRIÇÃO:",
        t.get("descricao", roteiro.get("moral", "")).strip(),
        "",
        "Capítulos:",
        capitulos_youtube(roteiro, duracoes),
        "",
        " ".join(tags),
        "",
        "Marque 'conteúdo alterado ou sintético' só se o YouTube pedir; é desenho, não imagem realista.",
    ])


# ---------------------------------------------------------------------------
# Cortes verticais
# ---------------------------------------------------------------------------
def _quebrar(d: ImageDraw.ImageDraw, texto: str, fonte, largura: int) -> list[str]:
    linhas, atual = [], ""
    for p in texto.split():
        teste = f"{atual} {p}".strip()
        if d.textlength(teste, font=fonte) > largura and atual:
            linhas.append(atual)
            atual = p
        else:
            atual = teste
    return linhas + [atual] if atual else linhas


def compor_vertical(imagem: Path, destino: Path, titulo: str) -> Path:
    """Imagem horizontal -> quadro em pé 1080x1920 com fundo desfocado e título em cima."""
    w, h = 1080, 1920
    img = Image.open(imagem).convert("RGB")
    fundo = ImageOps.fit(img, (w, h), Image.LANCZOS).filter(ImageFilter.GaussianBlur(28))
    fundo = Image.blend(fundo, Image.new("RGB", (w, h), (12, 8, 14)), 0.45)
    frente = ImageOps.fit(img, (w, round(w * 9 / 16)), Image.LANCZOS)
    y = (h - frente.height) // 2
    fundo.paste(frente, (0, y))
    d = ImageDraw.Draw(fundo)
    fonte = diretor_arte._fonte(78)
    linhas = _quebrar(d, titulo.upper(), fonte, w - 200)[:3]
    ty = y - 70 - 96 * len(linhas)
    for linha in linhas:
        lw = d.textlength(linha, font=fonte)
        d.text(((w - lw) / 2, ty), linha, font=fonte, fill="#E8B828", stroke_width=6, stroke_fill="black")
        ty += 96
    fundo.save(destino, quality=92)
    return destino


def fazer_cortes(cfg: Config, roteiro: dict, pasta: Path, imagens: list[Path],
                 faixas: list[tuple[Path, float]]) -> list[dict]:
    """Monta cada corte em pé. Devolve [{"video", "capa", "texto", "titulo"}, ...]."""
    feitos = []
    cta = cfg.serie.get("formato_longo", {}).get("cta_corte", CTA_CORTE_PADRAO)
    for n, corte in enumerate(roteiro.get("cortes", []), start=1):
        sub = pasta / f"corte_{n:02d}"
        final = sub / "video_final.mp4"
        de, ate = corte["cenas"]
        titulo = corte.get("titulo", roteiro["titulo_episodio"])
        if not final.exists():
            sub.mkdir(exist_ok=True)
            cenas = [copy.deepcopy(c) for c in roteiro["cenas"][de - 1:ate]]
            quadros, falas = [], []
            for i, idx in enumerate(range(de - 1, ate), start=1):
                quadros.append(compor_vertical(imagens[idx], sub / f"quadro_{i:02d}.jpg", titulo))
                fala = sub / f"fala_{i:02d}.mp3"
                shutil.copyfile(faixas[idx][0], fala)
                falas.append((fala, faixas[idx][1]))
            # convite final, com a voz do narrador, em cima do último quadro
            fim = {"narracao": cta, "descricao_visual": "convite"}
            [(fala_cta, dur_cta)] = narrador.narrar(cfg, {"cenas": [fim]}, sub / "cta")
            cenas.append(fim)
            quadros.append(quadros[-1])
            fala_fim = sub / f"fala_{len(falas) + 1:02d}.mp3"
            shutil.copyfile(fala_cta, fala_fim)
            falas.append((fala_fim, dur_cta))
            editor.montar(cfg, {"cenas": cenas}, quadros, falas, sub, formato="vertical")
            diretor_arte.capa(quadros[0], titulo, sub / "thumbnail.jpg")
        tags = _hashtags(cfg, corte.get("hashtags", []), 8)
        texto = (f"{corte.get('titulo_post', titulo)}\n\n{corte.get('descricao', '')}\n"
                 f"Episódio completo no YouTube: As Histórias de um Pescador.\n\n{' '.join(tags)}")
        (sub / "TEXTO.txt").write_text(texto, encoding="utf-8")
        feitos.append({"video": final, "capa": sub / "thumbnail.jpg", "texto": texto, "titulo": titulo})
    return feitos


# ---------------------------------------------------------------------------
# Produção
# ---------------------------------------------------------------------------
def revisar(video: Path, cortes: list[dict]) -> list[str]:
    problemas = []
    if not video.exists() or video.stat().st_size < 100_000:
        return ["O vídeo longo não foi gerado."]
    dur = midia.duracao(video)
    if dur < 8 * 60:
        problemas.append(f"Vídeo longo com só {dur / 60:.1f} min (o alvo é ~15).")
    if dur > 20 * 60:
        problemas.append(f"Vídeo longo com {dur / 60:.1f} min, acima do alvo.")
    if not midia.tem_audio(video):
        problemas.append("O vídeo longo saiu sem áudio.")
    for c in cortes:
        if not c["video"].exists():
            problemas.append(f"O corte '{c['titulo']}' não foi gerado.")
            continue
        d = midia.duracao(c["video"])
        if d > 90:
            problemas.append(f"Corte '{c['titulo']}' com {d:.0f} s (passa de 90 s).")
    return problemas


def _copiar_para_drive(cfg: Config, pasta: Path, arquivos: list[Path]) -> Path | None:
    if not cfg.pasta_drive or cfg.modo_teste:
        return None
    destino = cfg.pasta_drive / "prontos" / pasta.name
    destino.mkdir(parents=True, exist_ok=True)
    for a in arquivos:
        if a.exists():
            nome = a.name if a.parent == pasta else f"{a.parent.name}_{a.name}"
            shutil.copyfile(a, destino / nome)
    return destino


def produzir_longo(cfg: Config, continuar: Path | None = None) -> Path:
    """Faz um episódio longo + cortes. Com `continuar`, retoma a pasta sem refazer o que já existe."""
    from ..notificador import avisar_longo, avisar_texto
    inicio = time.time()
    pasta = continuar or cfg.pasta_saida / datetime.now().strftime("EP-LONGO-%Y%m%d-%H%M%S")
    pasta.mkdir(parents=True, exist_ok=True)
    arq = pasta / "roteiro.json"

    if arq.exists():
        roteiro = validar_longo(json.loads(arq.read_text(encoding="utf-8")))
        print("1/5 Roteiro longo já existia, aproveitando.")
    else:
        pronto = pegar_da_fila(cfg)
        if not pronto:
            pasta.rmdir()
            raise SystemExit("Fila de roteiros longos vazia (pasta roteiros_longos/).")
        roteiro, origem = pronto
        print(f"1/5 Usando roteiro longo da fila: {origem.name} ({len(roteiro['cenas'])} cenas)")
    arq.write_text(json.dumps(roteiro, ensure_ascii=False, indent=2), encoding="utf-8")

    print("2/5 Diretor de arte: imagens horizontais...")
    try:
        imagens = diretor_arte.desenhar(cfg, roteiro, pasta, formato="horizontal")
    except diretor_arte.AguardandoImagens as espera:
        arq.write_text(json.dumps(roteiro, ensure_ascii=False, indent=2), encoding="utf-8")
        avisar_texto(cfg, f"🎬 Episódio LONGO \"{roteiro['titulo_episodio']}\" está esperando "
                          f"{espera.faltam} imagens. Abra o caderno do Colab e aperte \"Executar tudo\". "
                          "O robô continua sozinho quando elas chegarem.")
        raise
    arq.write_text(json.dumps(roteiro, ensure_ascii=False, indent=2), encoding="utf-8")

    print("3/5 Narrador gravando as falas (voz mais calma para o longo)...")
    longo = cfg.serie.get("formato_longo", {})
    cfg_voz = dataclasses.replace(cfg, velocidade_voz=longo.get("velocidade_voz", cfg.velocidade_voz))
    faixas = narrador.narrar(cfg_voz, roteiro, pasta)
    respiro = float(longo.get("respiro_segundos", 0.15))
    duracoes = [d + respiro for _, d in faixas]

    print(f"4/5 Editor montando o vídeo de {sum(duracoes) / 60:.1f} min (demora)...")
    video = pasta / "video_longo.mp4"
    if not video.exists():
        editor.montar(cfg, roteiro, imagens, faixas, pasta, formato="horizontal",
                      saida=video.name, respiro=respiro)
    capa = diretor_arte.capa_horizontal(
        imagens[0], roteiro.get("textos", {}).get("texto_capa") or roteiro["titulo_episodio"],
        pasta / "thumbnail_youtube.jpg")

    print("5/5 Cortes verticais...")
    cortes = fazer_cortes(cfg_voz, roteiro, pasta, imagens, faixas)

    problemas = revisar(video, cortes)
    pacote = [texto_youtube(cfg, roteiro, duracoes), ""]
    for n, c in enumerate(cortes, start=1):
        pacote += [f"━━ CORTE {n}: {c['titulo']} ━━", c["texto"], ""]
    pacote += (["⚠️ CONFIRA ANTES DE POSTAR:"] + [f"- {p}" for p in problemas]) if problemas \
        else ["✅ Revisão automática sem problemas."]
    pacote.append(f"\n(Robô levou {(time.time() - inicio) / 60:.0f} min)")
    (pasta / "PACOTE.txt").write_text("\n".join(pacote), encoding="utf-8")

    drive = _copiar_para_drive(cfg, pasta, [video, capa, pasta / "PACOTE.txt", pasta / "legendas.srt"]
                               + [c["video"] for c in cortes])
    avisar_longo(cfg, roteiro, pasta, capa, cortes, problemas, drive)
    return pasta
