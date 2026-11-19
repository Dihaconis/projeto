"""Episódio longo animado (YouTube 16:9) + cortes verticais.

Junta os dois jeitos de contar:
- "conversa": o Vô e o Lucas falando, com a boca sincronizada (arte publicada da série);
- "narracao": o narrador conta sobre uma imagem com movimento lento de câmera.
  Cenas seguidas no mesmo lugar usam a MESMA imagem, então o episódio precisa de
  bem menos imagens que cenas.

Roteiro (roteiros_longos_animados/*.json), ver a_corrida_mais_longa_do_vo.json:
    {"tipo": "longo_animado", "titulo", "frase_capa", "capa_imagem", "descricao", "hashtags",
     "imagens": {"<chave>": {"prompt": "..."}},
     "capitulos": [{"titulo", "blocos": [
         {"tipo": "narracao", "imagem": "<chave>", "cenas": [n], "texto": "..."},
         {"tipo": "conversa", "retrato": "vo_e_lucas", "cenas": [n], "falas": [{quem, texto, expressao, reacao}]}]}],
     "cortes": [{"titulo", "cenas": [de, ate]}]}

Imagens: a pasta do episódio (imagens/<chave>.jpg), a pasta do Drive
(imagens/<episódio>/<chave>.jpg) ou, se faltar, IMAGENS_ORIGEM: pollinations gera na
hora; colab deixa o pedido no Drive e o episódio para até as imagens chegarem
(rode de novo com --longo-animado e ele continua de onde parou).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from ..config import RAIZ, Config
from .. import midia, notificador
from ..agentes import diretor_arte, social
from . import labios, render, retrato, vozes

PASTA_FILA = RAIZ / "roteiros_longos_animados"
SAIDA = (1920, 1080)
VERTICAL = (1080, 1920)
EXTENSOES = (".jpg", ".jpeg", ".png", ".webp")


class ErroRoteiro(ValueError):
    pass


# ---------------------------------------------------------------------------
# Roteiro
# ---------------------------------------------------------------------------
def validar(roteiro: dict) -> dict:
    if roteiro.get("tipo") != "longo_animado":
        raise ErroRoteiro("O roteiro precisa ter \"tipo\": \"longo_animado\".")
    imagens = roteiro.get("imagens") or {}
    blocos = [b for c in roteiro.get("capitulos", []) for b in c.get("blocos", [])]
    if not blocos:
        raise ErroRoteiro("Roteiro sem capítulos ou sem blocos.")
    for i, b in enumerate(blocos, start=1):
        if b.get("tipo") == "narracao":
            if not str(b.get("texto", "")).strip():
                raise ErroRoteiro(f"Bloco {i}: narração sem texto.")
            if b.get("imagem") not in imagens:
                raise ErroRoteiro(f"Bloco {i}: imagem '{b.get('imagem')}' não está em \"imagens\".")
        elif b.get("tipo") == "conversa":
            if not b.get("falas"):
                raise ErroRoteiro(f"Bloco {i}: conversa sem falas.")
            rostos = set(retrato.carregar(b.get("retrato", "vo_e_lucas")).rostos)
            for f in b["falas"]:
                if f.get("quem") not in rostos or not str(f.get("texto", "")).strip():
                    raise ErroRoteiro(f"Bloco {i}: fala inválida ({f.get('quem')}).")
        else:
            raise ErroRoteiro(f"Bloco {i}: tipo '{b.get('tipo')}' (use narracao ou conversa).")
        if not b.get("cenas"):
            raise ErroRoteiro(f"Bloco {i}: falta a lista \"cenas\" (usada para os cortes).")
    if roteiro.get("capa_imagem") and roteiro["capa_imagem"] not in imagens:
        raise ErroRoteiro(f"capa_imagem '{roteiro['capa_imagem']}' não está em \"imagens\".")
    roteiro.setdefault("titulo", "Episódio longo")
    return roteiro


def blocos(roteiro: dict) -> list[tuple[int, dict]]:
    """[(índice do capítulo, bloco)] na ordem do episódio."""
    return [(ci, b) for ci, c in enumerate(roteiro["capitulos"]) for b in c["blocos"]]


# ---------------------------------------------------------------------------
# Imagens
# ---------------------------------------------------------------------------
def _prompt_completo(cfg: Config, prompt: str) -> str:
    estilo = cfg.serie.get("imagem_en", {}).get("estilo", "")
    return f"{estilo}. {prompt}".strip(". ") if estilo else prompt


def _achar(pasta: Path, chave: str) -> Path | None:
    for ext in EXTENSOES:
        if (pasta / f"{chave}{ext}").exists():
            return pasta / f"{chave}{ext}"
    return None


def obter_imagens(cfg: Config, roteiro: dict, pasta: Path) -> dict[str, Path]:
    destino = pasta / "imagens"
    destino.mkdir(parents=True, exist_ok=True)
    drive = cfg.pasta_drive / "imagens" / pasta.name if cfg.pasta_drive else None
    prontas: dict[str, Path] = {}
    faltam: list[str] = []
    for chave, info in roteiro["imagens"].items():
        final = destino / f"{chave}.jpg"
        if final.exists() and final.stat().st_size > 10_000:
            prontas[chave] = final
            continue
        origem = _achar(destino, chave) or (drive and _achar(drive, chave))
        if origem:
            ImageOps.fit(Image.open(origem).convert("RGB"), SAIDA, Image.LANCZOS).save(final, quality=92)
            prontas[chave] = final
        elif cfg.modo_teste:
            diretor_arte._imagem_teste(final, len(prontas), chave, SAIDA)
            prontas[chave] = final
        elif cfg.imagens_origem == "pollinations":
            print(f"   gerando imagem '{chave}' ({len(prontas) + 1}/{len(roteiro['imagens'])})")
            diretor_arte._baixar(cfg, _prompt_completo(cfg, info["prompt"]), final, tamanho=SAIDA)
            prontas[chave] = final
        else:
            faltam.append(chave)
    if faltam:
        _pedir(cfg, roteiro, pasta, faltam)
        raise diretor_arte.AguardandoImagens(pasta, len(faltam), "imagens do episódio longo")
    return prontas


def _pedir(cfg: Config, roteiro: dict, pasta: Path, faltam: list[str]) -> None:
    """Lista para gerar à mão (Gemini) e pedido no formato do caderno do Colab."""
    linhas = [f"Episódio: {roteiro['titulo']}", f"Faltam {len(faltam)} imagens, formato HORIZONTAL 16:9.",
              f"Salve cada uma em {pasta / 'imagens'} (ou no Drive: imagens/{pasta.name}/) com o nome indicado.",
              "Depois rode de novo: rodar.bat --longo-animado", ""]
    for chave in faltam:
        linhas += [f"--- {chave}.jpg ---", _prompt_completo(cfg, roteiro["imagens"][chave]["prompt"]), ""]
    (pasta / "IMAGENS_PEDIDAS.txt").write_text("\n".join(linhas), encoding="utf-8")
    if cfg.pasta_drive:
        pedidos = [{"arquivo": f"{c}.jpg", "prompt": _prompt_completo(cfg, roteiro["imagens"][c]["prompt"]),
                    "seed": diretor_arte._semente(c)} for c in faltam]
        diretor_arte._pedir_ao_colab(cfg, pasta, pedidos, diretor_arte.TAMANHOS["horizontal"][1])
    notificador.avisar_texto(cfg, f"🖼️ \"{roteiro['titulo']}\" está esperando {len(faltam)} imagens. "
                                  f"A lista com os prompts está em {pasta / 'IMAGENS_PEDIDAS.txt'}"
                                  + (" e o pedido do Colab no Drive." if cfg.pasta_drive else "."))


# ---------------------------------------------------------------------------
# Cena de narração: imagem com movimento lento + legenda
# ---------------------------------------------------------------------------
class ImagemCena:
    def __init__(self, imagem: Path, fala: render.Fala, total: float, direcao: int,
                 saida: tuple[int, int] = SAIDA):
        w, h = saida
        self.saida = saida
        self.total = total
        self.base = ImageOps.fit(Image.open(imagem).convert("RGB"), (round(w * 1.12), round(h * 1.12)), Image.LANCZOS)
        self.direcao = direcao % 4                    # alterna: aproxima, afasta, desliza p/ esquerda, p/ direita
        self.legendas = [(a, b, txt) for a, b, txt in render.pedacos_legenda(fala, 8)]
        self.fonte = render._fonte(round(h * 0.062))

    def quadro(self, t: float) -> Image.Image:
        W, H = self.base.size
        w, h = self.saida
        p = min(1.0, max(0.0, t / max(0.1, self.total)))
        p = p * p * (3 - 2 * p)                          # começa e termina suave
        if self.direcao == 0:
            z, dx = 1.0 + 0.10 * p, 0.0
        elif self.direcao == 1:
            z, dx = 1.10 - 0.10 * p, 0.0
        else:
            z, dx = 1.04, (p - 0.5) * (1 if self.direcao == 2 else -1)
        larg = W / (1.0 + (z - 1.0)) / 1.12
        alt = larg * h / w
        cx = W / 2 + dx * (W - larg) * 0.9
        x0 = min(max(0.0, cx - larg / 2), W - larg)
        y0 = (H - alt) / 2
        img = self.base.resize(self.saida, Image.BILINEAR, box=(x0, y0, x0 + larg, y0 + alt))
        leg = next((txt for a, b, txt in self.legendas if a <= t < b), None)
        if leg:
            render._desenhar_legenda(img, leg, "#FFFFFF", self.fonte)
        return img


# ---------------------------------------------------------------------------
# Produção
# ---------------------------------------------------------------------------
def _vozes(cfg: Config):
    anim = cfg.serie.get("animacao", {})
    motor = os.environ.get("VOZ_MOTOR", anim.get("motor_voz", "edge")).strip().lower()
    return anim.get("vozes", {}), motor


def _render_bloco(cfg: Config, idx: int, bloco: dict, imagens: dict[str, Path], pasta: Path,
                  vozes_cfg: dict, motor: str) -> Path:
    destino = pasta / "blocos" / f"b{idx:03d}.mp4"
    if destino.exists() and destino.stat().st_size > 20_000:
        return destino
    destino.parent.mkdir(parents=True, exist_ok=True)
    (pasta / "falas").mkdir(exist_ok=True)
    (pasta / "labios").mkdir(exist_ok=True)
    falas: list[render.Fala] = []
    if bloco["tipo"] == "narracao":
        wav = pasta / "falas" / f"b{idx:03d}_narrador.wav"
        vozes.falar(bloco["texto"], "narrador", vozes_cfg, motor, wav)
        falas.append(render.Fala("narrador", bloco["texto"], wav=wav, duracao=midia.duracao(wav)))
        total = render.linha_do_tempo(falas, 0.0, entrada=0.25, saida=0.45)
        cena = ImagemCena(imagens[bloco["imagem"]], falas[0], total, idx)
    else:
        for n, f in enumerate(bloco["falas"], start=1):
            wav = pasta / "falas" / f"b{idx:03d}_{n:02d}_{f['quem']}.wav"
            vozes.falar(f["texto"], f["quem"], vozes_cfg, motor, wav)
            cues = labios.sincronizar(wav, pasta / "labios" / f"b{idx:03d}_{n:02d}.json", f["texto"])
            falas.append(render.Fala(f["quem"], f["texto"], f.get("expressao", "neutro"), f.get("reacao", "neutro"),
                                     wav, cues, duracao=midia.duracao(wav)))
        anim = cfg.serie.get("animacao", {})
        total = render.linha_do_tempo(falas, float(anim.get("respiro_segundos", 0.35)), entrada=0.4, saida=0.7)
        cena = retrato.RetratoCena(retrato.carregar(bloco.get("retrato", "vo_e_lucas")), falas, total, saida=SAIDA)
    audio = render.mixar_audio(falas, total, pasta / "blocos" / f"b{idx:03d}.wav")
    tmp = destino.with_suffix(".parcial.mp4")
    render.renderizar(cena, audio, tmp, progresso=lambda _: None)
    tmp.replace(destino)
    audio.unlink(missing_ok=True)
    return destino


def _juntar(clipes: list[Path], destino: Path) -> None:
    lista = destino.with_suffix(".txt")
    lista.write_text("".join(f"file '{c.resolve().as_posix()}'\n" for c in clipes), encoding="utf-8")
    midia.rodar(["-f", "concat", "-safe", "0", "-i", str(lista), "-c", "copy", "-movflags", "+faststart", str(destino)])
    lista.unlink(missing_ok=True)


def _tempo(seg: float) -> str:
    seg = int(seg)
    h, r = divmod(seg, 3600)
    m, s = divmod(r, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def _sobreposicao_corte(titulo: str, cta: str, destino: Path) -> Path:
    """PNG transparente 1080x1920 com o título do corte em cima e o convite embaixo."""
    w, h = VERTICAL
    img = Image.new("RGBA", VERTICAL, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def bloco(texto, fonte, cor, centro_y):
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
        for linha in linhas[:4]:
            lw = d.textlength(linha, font=fonte)
            d.text(((w - lw) / 2, y), linha, font=fonte, fill=cor, stroke_width=7, stroke_fill="#111111")
            y += alt

    bloco(titulo, render._fonte(84), "#E8B828", 330)
    bloco(cta, render._fonte(52), "#FFFFFF", 1620)
    img.save(destino)
    return destino


def _cortar(video: Path, inicio: float, fim: float, titulo: str, cta: str, destino: Path) -> Path:
    sobre = _sobreposicao_corte(titulo, cta, destino.with_suffix(".png"))
    filtro = ("[0:v]split=2[a][b];"
              "[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.18[fundo];"
              "[b]scale=1080:-2[meio];[fundo][meio]overlay=(W-w)/2:(H-h)/2[v1];[v1][1:v]overlay=0:0[v]")
    midia.rodar(["-ss", f"{inicio:.3f}", "-t", f"{fim - inicio:.3f}", "-i", str(video), "-i", str(sobre),
                 "-filter_complex", filtro, "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast",
                 "-crf", "21", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(destino)])
    sobre.unlink(missing_ok=True)
    return destino


def _fila(cfg: Config) -> Path | None:
    pastas = [PASTA_FILA] + ([cfg.pasta_drive / "roteiros_longos_animados"] if cfg.pasta_drive else [])
    for p in pastas:
        if p.exists():
            for arq in sorted(p.glob("*.json")):
                return arq
    return None


def inacabado(cfg: Config) -> Path | None:
    if not cfg.pasta_saida.exists():
        return None
    for p in sorted(cfg.pasta_saida.glob("LONGO-*"), key=lambda p: p.stat().st_mtime):
        if (p / "roteiro.json").exists() and not (p / "video_longo.mp4").exists():
            return p
    return None


def produzir_longo_animado(cfg: Config, arquivo: Path | None = None) -> Path:
    """Arquivo de roteiro ou pasta LONGO-... para continuar. Sem nada: continua o que parou
    ou pega o mais antigo da fila (roteiros_longos_animados/, no projeto ou no Drive)."""
    if arquivo and Path(arquivo).is_dir():
        pasta = Path(arquivo)
    elif arquivo:
        pasta = None
    else:
        pasta = inacabado(cfg)
        if pasta is None:
            arquivo = _fila(cfg)
            if arquivo is None:
                raise SystemExit("Nenhum roteiro em roteiros_longos_animados/ (nem episódio parado para continuar).")
    if pasta is None:
        roteiro = validar(json.loads(Path(arquivo).read_text(encoding="utf-8")))
        pasta = cfg.pasta_saida / f"LONGO-{datetime.now():%Y%m%d-%H%M%S}"
        pasta.mkdir(parents=True)
        (pasta / "roteiro.json").write_text(json.dumps(roteiro, ensure_ascii=False, indent=1), encoding="utf-8")
        if Path(arquivo).parent.name == "roteiros_longos_animados":     # da fila: não pega de novo
            usados = Path(arquivo).parent / "usados"
            usados.mkdir(exist_ok=True)
            shutil.move(str(arquivo), str(usados / Path(arquivo).name))
    else:
        roteiro = validar(json.loads((pasta / "roteiro.json").read_text(encoding="utf-8")))
    inicio = time.time()
    lista = blocos(roteiro)
    print(f"🎬 Episódio longo animado: {roteiro['titulo']} ({len(lista)} blocos, {len(roteiro['imagens'])} imagens)")

    print("1/5 Imagens...")
    try:
        imagens = obter_imagens(cfg, roteiro, pasta)
    except diretor_arte.AguardandoImagens:
        raise

    print("2/5 Vozes, bocas e animação, bloco a bloco (pode parar e continuar)...")
    vozes_cfg, motor = _vozes(cfg)
    clipes = []
    for i, (_, b) in enumerate(lista, start=1):
        clipes.append(_render_bloco(cfg, i, b, imagens, pasta, vozes_cfg, motor))
        print(f"   bloco {i}/{len(lista)} ({b['tipo']}) pronto")

    print("3/5 Juntando o episódio...")
    duracoes = [midia.duracao(c) for c in clipes]
    video = pasta / "video_longo.mp4"
    tmp = pasta / "video_longo.parcial.mp4"
    _juntar(clipes, tmp)
    tmp.replace(video)
    inicios, t = [], 0.0
    for d in duracoes:
        inicios.append(t)
        t += d
    total = t

    capitulos, visto = [], set()
    for (ci, _), ini in zip(lista, inicios):
        if ci not in visto:
            visto.add(ci)
            capitulos.append(f"{_tempo(ini)} {roteiro['capitulos'][ci]['titulo']}")

    print("4/5 Capa e cortes verticais...")
    capa_img = imagens.get(roteiro.get("capa_imagem")) or next(iter(imagens.values()))
    capa = diretor_arte.capa_horizontal(capa_img, roteiro.get("frase_capa") or roteiro["titulo"], pasta / "thumbnail.jpg")
    cta = cfg.serie.get("formato_longo", {}).get("cta_corte", "Episódio completo no canal.")
    cortes = []
    (pasta / "cortes").mkdir(exist_ok=True)
    for n, c in enumerate(roteiro.get("cortes", []), start=1):
        de, ate = c["cenas"]
        dentro = [k for k, (_, b) in enumerate(lista) if de <= min(b["cenas"]) <= ate]
        if not dentro:
            continue
        ini, fim = inicios[dentro[0]], inicios[dentro[-1]] + duracoes[dentro[-1]]
        arq = _cortar(video, ini, fim, c["titulo"], cta, pasta / "cortes" / f"corte_{n}.mp4")
        cortes.append({"titulo": c["titulo"], "video": arq, "inicio": ini, "fim": fim})

    print("5/5 Revisão e aviso...")
    problemas = []
    if abs(midia.duracao(video) - total) > 2:
        problemas.append("A duração do vídeo final não bate com a soma dos blocos.")
    if not midia.tem_audio(video):
        problemas.append("O vídeo longo saiu sem áudio.")
    for k, (_, b) in enumerate(lista, start=1):
        if b["tipo"] == "conversa":
            for n in range(1, len(b["falas"]) + 1):
                cues = json.loads((pasta / "labios" / f"b{k:03d}_{n:02d}.json").read_text(encoding="utf-8"))["mouthCues"]
                if len({c["value"] for c in cues} - {"X"}) < 2:
                    problemas.append(f"Bloco {k}, fala {n}: a boca quase não mexe.")
    tags = " ".join(roteiro.get("hashtags", []))
    linhas = [f"🎬 {roteiro['titulo']}", f"Duração: {_tempo(total)} · {len(lista)} blocos · "
              f"montado em {(time.time() - inicio) / 60:.0f} min", "",
              "━━ YOUTUBE (vídeo longo) ━━", f"Título: {roteiro['titulo']}", f"Texto da capa: {roteiro.get('frase_capa', '')}",
              "Descrição:", roteiro.get("descricao", ""), "", "Capítulos:", *capitulos, "", tags, ""]
    for n, c in enumerate(cortes, start=1):
        textos = {"titulo": c["titulo"], "descricao": f"{c['titulo']}. {cta}", "hashtags": roteiro.get("hashtags", [])}
        linhas += [f"══ CORTE {n}: {c['titulo']} ({_tempo(c['fim'] - c['inicio'])}) — cortes/corte_{n}.mp4 ══"]
        for rede, texto in social.por_rede(textos).items():
            linhas += [f"━━ {rede} ━━", texto]
        linhas.append("")
    linhas.append("Marque como conteúdo feito com IA onde a rede pedir.")
    if problemas:
        linhas += ["", "⚠️ CONFIRA:"] + [f"- {p}" for p in problemas]
    (pasta / "PACOTE.txt").write_text("\n".join(linhas), encoding="utf-8")

    drive = None
    if cfg.pasta_drive and not cfg.modo_teste:
        drive = cfg.pasta_drive / "prontos" / pasta.name
        (drive / "cortes").mkdir(parents=True, exist_ok=True)
        for arq in [video, capa, pasta / "PACOTE.txt"]:
            shutil.copy2(arq, drive / arq.name)
        for c in cortes:
            shutil.copy2(c["video"], drive / "cortes" / c["video"].name)
    notificador.avisar_longo(cfg, {"titulo_episodio": roteiro["titulo"]}, pasta, capa, cortes, problemas, drive)
    return pasta
