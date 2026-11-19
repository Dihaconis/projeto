"""Robô diretor de arte: transforma cada cena em imagem vertical 9:16.

Duas origens possíveis (IMAGENS_ORIGEM no .env):
- "pollinations": gratuito e automático, mas fraco (1 imagem a cada 45 s, ignora
  estilo); por isso as imagens passam pelo filtro de xilogravura (estilo.py).
- "colab": o robô deixa um pedido na pasta do Google Drive, o caderno do Colab
  gera as imagens com um modelo bom (SDXL) e devolve na mesma pasta.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
import urllib.parse
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageOps

from ..config import Config

LARGURA, ALTURA = 1080, 1920
URL_IMAGEM = "https://image.pollinations.ai/prompt/{prompt}"
INTERVALO_GRATIS = 48   # sem token: 1 imagem a cada 45 s por internet (regra de nov/2026)
COLAB_LARGURA, COLAB_ALTURA = 768, 1344   # tamanho nativo do SDXL mais perto de 9:16

# formato -> (tamanho final no vídeo, tamanho pedido ao Colab)
TAMANHOS = {
    "vertical": ((LARGURA, ALTURA), (COLAB_LARGURA, COLAB_ALTURA)),       # Shorts/Reels/TikTok
    "horizontal": ((1920, 1080), (1344, 768)),                           # YouTube longo
}


class AguardandoImagens(Exception):
    """O pedido foi deixado no Drive; o episódio continua depois que o Colab rodar."""

    def __init__(self, pasta: Path, faltam: int, motivo: str = "imagens do Colab"):
        super().__init__(f"{pasta.name}: faltam {faltam} {motivo}")
        self.pasta = pasta
        self.faltam = faltam
        self.motivo = motivo


def montar_prompt(cfg: Config, cena: dict | str) -> str:
    """Junta a cena com o visual fixo dos personagens e o estilo da série, em inglês.

    O gerador grátis só lê o começo do texto, então tudo é curto: estilo,
    cena, personagens (sempre com a mesma descrição, para saírem parecidos)
    e cenário.
    """
    if isinstance(cena, str):
        cena = {"descricao_visual": cena}
    en = cfg.serie["imagem_en"]
    descricao = cena.get("imagem_en") or cena["descricao_visual"]
    texto = (descricao + " " + cena.get("descricao_visual", "")).lower()
    partes = [en["estilo"], descricao]
    if _cita(texto, ("lucas", "menino", "boy")):
        partes.append(en["lucas"])
    if _cita(texto, ("vô", "avô", "vo", "grandpa", "grandfather", "old man")):
        partes.append(en["vo"])
    partes.append(en["cenario"])
    return ". ".join(" ".join(x.split()).rstrip(".") for x in partes)


def _cita(texto: str, palavras: tuple[str, ...]) -> bool:
    """Procura a palavra inteira ("vô" sim, "povo" e "ovo" não)."""
    return any(re.search(rf"(?<!\w){re.escape(p)}(?!\w)", texto) for p in palavras)


def _semente(texto: str) -> int:
    # o serviço só aceita sementes até 2.147.483.647
    return int(hashlib.sha256(texto.encode()).hexdigest()[:8], 16) % 1_000_000_000


def _imagem_teste(destino: Path, numero: int, descricao: str,
                  tamanho: tuple[int, int] = (LARGURA, ALTURA)) -> None:
    cores = ["#4B1F4F", "#1F3B2A", "#6B4423", "#E8B828", "#B3261E", "#2E2E2E"]
    w, h = tamanho
    img = Image.new("RGB", (w, h), cores[numero % len(cores)])
    d = ImageDraw.Draw(img)
    d.rectangle([60, 60, w - 60, h - 60], outline="white", width=8)
    d.text((100, 120), f"CENA {numero + 1}", fill="white")
    d.text((100, 170), descricao[:80], fill="white")
    img.save(destino, quality=90)


def _baixar(cfg: Config, prompt: str, destino: Path, tentativas: int = 4,
            tamanho: tuple[int, int] = (LARGURA, ALTURA)) -> None:
    url = URL_IMAGEM.format(prompt=urllib.parse.quote(prompt, safe=""))
    params = {"width": tamanho[0], "height": tamanho[1], "seed": _semente(prompt),
              "nologo": "true", "model": "flux"}
    headers = {"Authorization": f"Bearer {cfg.pollinations_token}"} if cfg.pollinations_token else {}
    ultimo = ""
    for n in range(tentativas):
        espera = 20 * (n + 1)
        try:
            r = requests.get(url, params=params, headers=headers, timeout=180)
            if r.status_code == 200 and r.headers.get("content-type", "").startswith("image"):
                destino.write_bytes(r.content)
                _ajustar(destino, destino, tamanho)
                return
            ultimo = f"{r.status_code}: {r.text[:300]}"
            if r.status_code == 400:
                break                           # pedido inválido: repetir não adianta
            # limite grátis: o serviço diz quantos segundos esperar ("Retry after 23s")
            pedido = re.search(r"[Rr]etry after (\d+)", r.text)
            if pedido:
                espera = int(pedido.group(1)) + 3
        except requests.RequestException as e:
            ultimo = str(e)[:200]
        print(f"   imagem ainda não veio, tentando de novo em {espera} s...")
        time.sleep(espera)
    raise RuntimeError(f"Não consegui gerar a imagem depois de {tentativas} tentativas. Último erro: {ultimo}")


def _ajustar(origem: Path, destino: Path, tamanho: tuple[int, int] = (LARGURA, ALTURA)) -> None:
    """Deixa a imagem no tamanho do vídeo (1080x1920 ou 1920x1080) cortando as sobras, sem esticar."""
    img = Image.open(origem).convert("RGB")
    ImageOps.fit(img, tamanho, Image.LANCZOS).save(destino, quality=92)


def _pedir_ao_colab(cfg: Config, pasta: Path, pedidos: list[dict],
                    tamanho_colab: tuple[int, int] = (COLAB_LARGURA, COLAB_ALTURA)) -> Path:
    """Escreve (uma vez) o pedido do episódio em <Drive>/pedidos/EP-....json."""
    arquivo = cfg.pasta_drive / "pedidos" / f"{pasta.name}.json"
    if not arquivo.exists():
        arquivo.parent.mkdir(parents=True, exist_ok=True)
        dados = {
            "episodio": pasta.name,
            "largura": tamanho_colab[0],
            "altura": tamanho_colab[1],
            "negativo": cfg.serie["imagem_en"].get("negativo", ""),
            "cenas": pedidos,
        }
        arquivo.write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")
    return arquivo


FONTES = [
    "C:/Windows/Fonts/impact.ttf", "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]


def _fonte(tamanho: int):
    from PIL import ImageFont
    for caminho in FONTES:
        if Path(caminho).exists():
            return ImageFont.truetype(caminho, tamanho)
    return ImageFont.load_default(size=tamanho)


def capa(imagem: Path, texto: str, destino: Path) -> Path:
    """Thumbnail 1080x1920: imagem da cena + frase curta em amarelo-lamparina."""
    img = Image.open(imagem).convert("RGB").resize((LARGURA, ALTURA))
    faixa = Image.new("RGBA", (LARGURA, 560), (20, 10, 20, 170))
    img.paste(faixa, (0, ALTURA - 760), faixa)
    d = ImageDraw.Draw(img)
    fonte = _fonte(92)
    palavras, linhas, atual = texto.upper().split()[:7], [], ""   # capa boa tem poucas palavras
    for p in palavras:                     # quebra de linha simples por largura
        teste = f"{atual} {p}".strip()
        if d.textlength(teste, font=fonte) > LARGURA - 140 and atual:
            linhas.append(atual)
            atual = p
        else:
            atual = teste
    linhas.append(atual)
    y = ALTURA - 720
    for linha in linhas[:4]:
        largura = d.textlength(linha, font=fonte)
        d.text(((LARGURA - largura) / 2, y), linha, font=fonte, fill="#E8B828",
               stroke_width=6, stroke_fill="black")
        y += 120
    img.save(destino, quality=92)
    return destino


def capa_horizontal(imagem: Path, texto: str, destino: Path) -> Path:
    """Thumbnail do YouTube (1280x720): imagem + frase grande em amarelo-lamparina à esquerda."""
    w, h = 1280, 720
    img = ImageOps.fit(Image.open(imagem).convert("RGB"), (w, h), Image.LANCZOS)
    sombra = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ds = ImageDraw.Draw(sombra)
    for x in range(w // 2 + 120):                       # escurece a esquerda, onde vai o texto
        ds.line([(x, 0), (x, h)], fill=(15, 8, 15, int(190 * (1 - x / (w // 2 + 120)))))
    img.paste(sombra, (0, 0), sombra)
    d = ImageDraw.Draw(img)
    fonte = _fonte(96)
    palavras, linhas, atual = texto.upper().split()[:6], [], ""
    for p in palavras:
        teste = f"{atual} {p}".strip()
        if d.textlength(teste, font=fonte) > w * 0.55 and atual:
            linhas.append(atual)
            atual = p
        else:
            atual = teste
    linhas.append(atual)
    y = (h - 112 * len(linhas[:4])) // 2
    for linha in linhas[:4]:
        d.text((60, y), linha, font=fonte, fill="#E8B828", stroke_width=7, stroke_fill="black")
        y += 112
    img.save(destino, quality=92)
    return destino


def desenhar(cfg: Config, roteiro: dict, pasta: Path, formato: str = "vertical") -> list[Path]:
    """Gera uma imagem por cena. A imagem crua fica como cena_XX_bruta.jpg e a
    cena_XX.jpg é a que entra no vídeo (com o filtro de xilogravura, se ligado).

    Com IMAGENS_ORIGEM=colab, as imagens que ainda não voltaram do Colab viram
    um pedido no Drive e o episódio para com AguardandoImagens.
    """
    pasta.mkdir(parents=True, exist_ok=True)
    tamanho, tamanho_colab = TAMANHOS[formato]
    filtro = cfg.serie["formato"].get("filtro_xilogravura", True) and not cfg.modo_teste
    colab = cfg.imagens_origem == "colab" and not cfg.modo_teste
    caminhos: list[Path] = []
    pedidos: list[dict] = []
    ultimo_pedido = 0.0
    for i, cena in enumerate(roteiro["cenas"]):
        destino = pasta / f"cena_{i + 1:02d}.jpg"
        bruta = pasta / f"cena_{i + 1:02d}_bruta.jpg"
        prompt = montar_prompt(cfg, cena)
        cena["prompt_imagem"] = prompt          # fica salvo no roteiro, para refazer à mão
        caminhos.append(destino)
        if destino.exists() and destino.stat().st_size > 10_000:
            print(f"   cena {i + 1} já estava pronta")      # retomando um episódio
            continue
        if cfg.modo_teste:
            _imagem_teste(destino, i, cena["descricao_visual"], tamanho)
            continue

        if colab:
            vinda = cfg.pasta_drive / "imagens" / pasta.name / bruta.name
            if not vinda.exists():
                pedidos.append({"arquivo": bruta.name, "prompt": prompt, "seed": _semente(prompt)})
                continue
            print(f"   cena {i + 1} veio do Colab")
            _ajustar(vinda, bruta, tamanho)
        else:
            if ultimo_pedido and not cfg.pollinations_token:
                # respeita o limite sem token, descontando o tempo já gasto com o filtro
                falta = INTERVALO_GRATIS - (time.time() - ultimo_pedido)
                if falta > 0:
                    time.sleep(falta)
            print(f"   cena {i + 1} de {len(roteiro['cenas'])}")
            ultimo_pedido = time.time()
            _baixar(cfg, prompt, bruta, tamanho=tamanho)

        if filtro:
            from .estilo import aplicar_xilogravura   # só carrega o OpenCV quando precisa
            aplicar_xilogravura(bruta, destino)
        else:
            shutil.copyfile(bruta, destino)

    if pedidos:
        arquivo = _pedir_ao_colab(cfg, pasta, pedidos, tamanho_colab)
        print(f"   {len(pedidos)} imagens pedidas ao Colab em {arquivo}")
        raise AguardandoImagens(pasta, len(pedidos))
    return caminhos


# ---------------------------------------------------------------------------
# Animação com o Google Flow (opcional)
# ---------------------------------------------------------------------------
EXTENSOES_VIDEO = (".mp4", ".mov", ".webm")
MOVIMENTO_PADRAO = ("Animate this woodcut illustration with subtle natural motion: {cena}. "
                    "Slow camera push-in, gentle water and leaves movement, keep the woodcut "
                    "print style and colors, no text")


def movimento(cena: dict) -> str:
    """Texto curto de movimento para colar no Google Flow (imagem para vídeo)."""
    return cena.get("movimento_en") or MOVIMENTO_PADRAO.format(
        cena=(cena.get("imagem_en") or cena["descricao_visual"]).rstrip("."))


def _pasta_clipes(cfg: Config, pasta: Path) -> Path | None:
    return cfg.pasta_drive / "clipes" / pasta.name if cfg.pasta_drive else None


def preparar_flow(cfg: Config, roteiro: dict, imagens: list[Path], pasta: Path) -> None:
    """Deixa no Drive um kit para animar no Flow: as imagens + MOVIMENTOS.txt.

    Com ANIMAR=1 no .env, o episódio para UMA vez aqui, para dar tempo de fazer
    os clipes; no --continuar ele segue com os clipes que existirem (ou nenhum).
    """
    destino = _pasta_clipes(cfg, pasta)
    marca = pasta / ".kit_flow"
    if cfg.modo_teste or destino is None or marca.exists():
        return
    destino.mkdir(parents=True, exist_ok=True)
    linhas = [f"Episódio: {roteiro['titulo_episodio']}", "",
              "Como animar no Google Flow (labs.google/flow), formato 9:16:",
              "1. Crie um vídeo a partir de imagem e envie a cena_XX.jpg desta pasta.",
              "2. Cole o texto de movimento da cena.",
              "3. Baixe o vídeo e salve AQUI com o nome cena_XX.mp4 (mesmo número).",
              "Não precisa animar todas: as cenas sem vídeo usam zoom na imagem.", ""]
    for i, (cena, img) in enumerate(zip(roteiro["cenas"], imagens), start=1):
        shutil.copyfile(img, destino / f"cena_{i:02d}.jpg")
        linhas += [f"--- cena_{i:02d} ---", movimento(cena), ""]
    (destino / "MOVIMENTOS.txt").write_text("\n".join(linhas), encoding="utf-8")
    marca.write_text("ok", encoding="utf-8")
    print(f"   kit para o Flow em {destino}")
    if cfg.animar:
        raise AguardandoImagens(pasta, len(imagens), "clipes do Google Flow (opcional)")


def trocar_por_clipes(cfg: Config, pasta: Path, imagens: list[Path]) -> list[Path]:
    """Para cada cena, usa cena_XX.mp4 (na pasta do episódio ou no Drive) se existir."""
    visuais = []
    origem = _pasta_clipes(cfg, pasta)
    for i, img in enumerate(imagens, start=1):
        escolhido = img
        for ext in EXTENSOES_VIDEO:
            local = pasta / f"cena_{i:02d}{ext}"
            if not local.exists() and origem and (origem / local.name).exists():
                shutil.copyfile(origem / local.name, local)
            if local.exists():
                escolhido = local
                print(f"   cena {i}: usando clipe animado {local.name}")
                break
        visuais.append(escolhido)
    return visuais
