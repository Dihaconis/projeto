"""Robô chefe: coordena os especialistas e entrega um pacote pronto para postar.

Ordem: roteirista -> social media -> diretor de arte -> narrador -> editor
-> capa -> qualidade -> aviso no Telegram.
Se uma etapa falhar, o que já foi feito fica salvo na pasta do episódio.
"""
from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path

from .agentes import diretor_arte, editor, narrador, qa, roteirista, social
from .config import RAIZ, Config
from .llm import LLM
from .notificador import avisar, avisar_texto

HISTORICO = RAIZ / "dados" / "historico.json"


def _ler_historico() -> list[dict]:
    if HISTORICO.exists():
        return json.loads(HISTORICO.read_text(encoding="utf-8"))
    return []


def _gravar_historico(itens: list[dict]) -> None:
    HISTORICO.parent.mkdir(parents=True, exist_ok=True)
    HISTORICO.write_text(json.dumps(itens[-200:], ensure_ascii=False, indent=2), encoding="utf-8")


def _salvar(pasta: Path, nome: str, dados: dict) -> None:
    (pasta / nome).write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")


def _mensagem(cfg: Config, roteiro: dict, textos: dict, problemas: list[str], segundos: float) -> str:
    linhas = [f"🎣 Episódio pronto: {roteiro['titulo_episodio']}",
              "O mesmo vídeo serve nas quatro redes. Copie o texto de cada uma:"]
    for rede, texto in social.por_rede(textos).items():
        linhas += ["", f"━━ {rede} ━━", texto]
    linhas += ["", "Marque como conteúdo feito com IA onde a rede pedir."]
    if problemas:
        linhas += ["", "⚠️ CONFIRA ANTES DE POSTAR:"] + [f"- {p}" for p in problemas]
    else:
        linhas += ["", "✅ Revisão automática sem problemas."]
    linhas.append(f"\n(Robô levou {segundos / 60:.1f} min)")
    return "\n".join(linhas)


def _pronto(p: Path) -> bool:
    if (p / "video_final.mp4").exists():
        return True
    return (p / "PACOTE.txt").exists() and (p / "video_longo.mp4").exists()


def inacabados(cfg: Config) -> list[Path]:
    """Episódios que pararam no meio (ex.: esperando imagens do Colab), do mais antigo ao mais novo."""
    if not cfg.pasta_saida.exists():
        return []
    return [p for p in sorted(cfg.pasta_saida.glob("EP-*"), key=lambda p: p.stat().st_mtime)
            if p.is_dir() and (p / "roteiro.json").exists() and not _pronto(p)]


def _ler(pasta: Path, nome: str) -> dict | None:
    arq = pasta / nome
    return json.loads(arq.read_text(encoding="utf-8")) if arq.exists() else None


def produzir_episodio(cfg: Config, continuar: Path | None = None) -> Path:
    """Faz um episódio. Com `continuar`, retoma a pasta sem refazer o que já existe."""
    inicio = time.time()
    pasta = continuar or cfg.pasta_saida / datetime.now().strftime("EP-%Y%m%d-%H%M%S")
    pasta.mkdir(parents=True, exist_ok=True)
    llm = LLM(cfg)
    historico = _ler_historico()

    roteiro = _ler(pasta, "roteiro.json")
    if roteiro and roteiro.get("tipo") == "longo":
        from .agentes.longo import produzir_longo
        return produzir_longo(cfg, continuar=pasta)
    if roteiro:
        print("1/6 Roteiro já existia, aproveitando.")
    else:
        pronto = roteirista.pegar_da_fila(cfg)
        if pronto:
            roteiro, origem = pronto
            print(f"1/6 Usando roteiro da fila: {origem.name}")
            if roteiro.get("textos"):                  # o roteiro já trouxe título e legenda
                _salvar(pasta, "textos.json", social.ajustar(cfg, roteiro.pop("textos"), roteiro))
        else:
            print("1/6 Roteirista (Gemini) escrevendo o causo...")
            roteiro = roteirista.escrever(cfg, llm, [h["titulo"] for h in historico])
        _salvar(pasta, "roteiro.json", roteiro)

    textos = _ler(pasta, "textos.json")
    if textos:
        print("2/6 Título e legenda já existiam, aproveitando.")
    else:
        print("2/6 Social media escrevendo título e legenda...")
        textos = social.escrever(cfg, llm, roteiro)
        _salvar(pasta, "textos.json", textos)

    print("3/6 Diretor de arte desenhando as cenas...")
    try:
        imagens = diretor_arte.desenhar(cfg, roteiro, pasta)
    except diretor_arte.AguardandoImagens as espera:
        _salvar(pasta, "roteiro.json", roteiro)
        avisar_texto(cfg, f"🖼️ Episódio \"{roteiro['titulo_episodio']}\" está esperando "
                          f"{espera.faltam} imagens. Abra o caderno do Colab e aperte "
                          "\"Executar tudo\". Depois rode o robô com --continuar.")
        raise
    _salvar(pasta, "roteiro.json", roteiro)       # agora com os prompts de imagem

    try:
        diretor_arte.preparar_flow(cfg, roteiro, imagens, pasta)
    except diretor_arte.AguardandoImagens:
        avisar_texto(cfg, f"🎬 As imagens de \"{roteiro['titulo_episodio']}\" estão prontas. "
                          "Se quiser animar, abra a pasta clipes no Drive, siga o MOVIMENTOS.txt "
                          "no Google Flow e depois rode o robô com --continuar.")
        raise
    visuais = diretor_arte.trocar_por_clipes(cfg, pasta, imagens)

    print("4/6 Narrador gravando a voz...")
    faixas = narrador.narrar(cfg, roteiro, pasta)

    print("5/6 Editor montando o vídeo...")
    video = editor.montar(cfg, roteiro, visuais, faixas, pasta)
    capa = diretor_arte.capa(imagens[0], textos.get("texto_capa") or roteiro["titulo_episodio"],
                             pasta / "thumbnail.jpg")

    print("6/6 Qualidade revisando...")
    problemas = qa.revisar(cfg, roteiro, textos, video, capa)
    mensagem = _mensagem(cfg, roteiro, textos, problemas, time.time() - inicio)
    (pasta / "PACOTE.txt").write_text(mensagem, encoding="utf-8")

    ja_registrado = roteiro["titulo_episodio"] in {h["titulo"] for h in historico}
    if not cfg.modo_teste and not ja_registrado:
        historico.append({"data": datetime.now().isoformat(timespec="minutes"),
                          "titulo": roteiro["titulo_episodio"], "moral": roteiro.get("moral", "")})
        _gravar_historico(historico)

    avisar(cfg, pasta, video, capa, mensagem)
    return pasta
