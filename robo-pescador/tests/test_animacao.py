"""Testes do desenho animado com boca sincronizada (não precisam de internet)."""
import json
import wave
from pathlib import Path

import numpy as np
import pytest

from robo.animacao import labios, render, retrato, vozes

RAIZ = Path(__file__).resolve().parent.parent


def _wav(caminho: Path, segundos: float, silencio_ini: float = 0.0, silencio_fim: float = 0.0, taxa: int = vozes.TAXA):
    t = np.arange(int(segundos * taxa)) / taxa
    tom = (0.3 * np.sin(2 * np.pi * 220 * t) * 32767).astype(np.int16)
    x = np.concatenate([np.zeros(int(silencio_ini * taxa), np.int16), tom, np.zeros(int(silencio_fim * taxa), np.int16)])
    with wave.open(str(caminho), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(taxa)
        w.writeframes(x.tobytes())


def test_aparar_corta_so_o_silencio_das_pontas(tmp_path):
    f = tmp_path / "fala.wav"
    _wav(f, 2.0, silencio_ini=0.8, silencio_fim=1.2)
    vozes._aparar(f)
    amostras, taxa = vozes.ler_wav(f)
    assert 1.95 < len(amostras) / taxa < 2.15            # a fala inteira fica; só as pontas saem


def test_mudar_tom_nao_muda_a_duracao(tmp_path):
    origem = tmp_path / "piper.wav"
    _wav(origem, 2.0, taxa=22050)                        # o piper grava em 22 kHz
    destino = tmp_path / "lucas.wav"
    vozes._para_wav(origem, destino, tom=1.22)
    amostras, taxa = vozes.ler_wav(destino)
    assert taxa == vozes.TAXA
    assert 1.9 < len(amostras) / taxa < 2.1


def test_boca_segue_os_trechos_do_rhubarb():
    b = labios.Boca([{"start": 0.0, "end": 0.2, "value": "X"}, {"start": 0.2, "end": 0.5, "value": "D"},
                     {"start": 0.5, "end": 0.9, "value": "F"}])
    assert [b.em(t) for t in (-1, 0.1, 0.3, 0.6, 5.0)] == ["X", "X", "D", "F", "F"]


def test_linha_do_tempo_e_camera():
    falas = [render.Fala("lucas", "oi", duracao=1.0), render.Fala("vo", "uma fala longa", duracao=4.0),
             render.Fala("vo", "outra", duracao=3.0), render.Fala("lucas", "e eu", duracao=3.5)]
    total = render.linha_do_tempo(falas, respiro=0.35)
    assert falas[0].inicio == pytest.approx(0.6)
    assert falas[1].inicio == pytest.approx(0.6 + 1.0 + 0.35)
    assert total == pytest.approx(falas[-1].fim + 1.2)
    planos = render.planejar_camera(falas, total)
    assert planos[0].inicio == 0 and planos[-1].fim == pytest.approx(total)
    assert {p.alvo for p in planos} >= {"geral", "vo"}                 # corta para o close de quem fala
    assert all(a.alvo != b.alvo for a, b in zip(planos, planos[1:]))  # sem corte à toa


def test_retrato_da_arte_publicada_mexe_so_a_boca():
    r = retrato.carregar("vo_e_lucas")
    fechada = np.asarray(r.montar({"vo": ("X", False), "lucas": ("X", False)})).astype(int)
    aberta = np.asarray(r.montar({"vo": ("D", False), "lucas": ("D", False)})).astype(int)
    diff = np.abs(fechada - aberta).sum(axis=2) > 30
    ys, xs = np.where(diff)
    assert len(ys) > 200                                                 # a boca mudou de verdade
    caixas = [r.rostos[p].apagar_boca for p in ("vo", "lucas")]
    dentro = sum(((xs >= x0 - 40) & (xs <= x1 + 40) & (ys >= y0 - 40) & (ys <= y1 + 60)).sum() for x0, y0, x1, y1 in caixas)
    assert dentro == len(ys)
    longe = np.asarray(r.original).astype(int)[:200]                     # céu e chapéu idênticos ao original
    assert np.abs(longe - fechada[:200]).max() == 0


@pytest.mark.skipif(not list((RAIZ / "ferramentas" / "rhubarb").glob("*/rhubarb*")),
                    reason="Rhubarb ainda não baixado (python ferramentas/baixar.py)")
def test_rhubarb_e_video_vertical(tmp_path):
    from robo import midia
    falas = []
    for i, quem in enumerate(("vo", "lucas")):
        f = tmp_path / f"f{i}.wav"
        _wav(f, 1.5)
        cues = labios.sincronizar(f, tmp_path / f"f{i}.json")
        falas.append(render.Fala(quem, "fala de teste aqui", wav=f, cues=cues, duracao=1.5))
    total = render.linha_do_tempo(falas, 0.3)
    cena = retrato.RetratoCena(retrato.carregar("vo_e_lucas"), falas, total, titulo="Teste")
    audio = render.mixar_audio(falas, total, tmp_path / "vozes.wav")
    video = render.renderizar(cena, audio, tmp_path / "v.mp4", progresso=lambda _: None)
    assert abs(midia.duracao(video) - total) < 0.3
    assert midia.tem_audio(video)


def test_dialogista_valida_e_corrige(tmp_path):
    from robo.animacao import dialogista
    from robo.llm import ErroLLM
    r = dialogista.validar({"titulo": "x" * 150, "falas": [
        {"quem": "lucas", "texto": "  Vô,   é verdade? ", "expressao": "bravo"},
        {"quem": "vo", "texto": "É sim.", "expressao": "feliz", "reacao": "surpreso"},
        {"quem": "lucas", "texto": "palavra " * 60},
        {"quem": "vo", "texto": "Então pega o remo."}]}, {"vo", "lucas"})
    assert len(r["titulo"]) == 100
    assert r["falas"][0]["texto"] == "Vô, é verdade?"
    assert r["falas"][0]["expressao"] == "neutro"                       # expressão desconhecida vira neutro
    assert len(r["falas"][2]["texto"].split()) == 40
    with pytest.raises(ErroLLM):
        dialogista.validar({"falas": [{"quem": "bisavo", "texto": "oi"}] * 4}, {"vo", "lucas"})


def test_fila_de_dialogos_pega_o_mais_antigo_e_pula_a_prova(tmp_path, monkeypatch):
    from robo.animacao import dialogista
    from robo.config import Config
    fila = tmp_path / "roteiros_animados"
    fila.mkdir()
    (fila / "prova_exemplo.json").write_text("{}", encoding="utf-8")
    bom = {"titulo": "A", "falas": [{"quem": "vo", "texto": "oi"}, {"quem": "lucas", "texto": "oi"}] * 2}
    (fila / "001.json").write_text(json.dumps(bom), encoding="utf-8")
    (fila / "000_ruim.json").write_text("{nao é json", encoding="utf-8")
    monkeypatch.setattr(dialogista, "PASTA_FILA", fila)
    cfg = Config.carregar(modo_teste=True)
    roteiro, origem = dialogista.pegar_da_fila(cfg, {"vo", "lucas"})
    assert origem.name == "001.json" and roteiro["titulo"] == "A"
    assert (fila / "usados" / "001.json").exists() and (fila / "com_erro" / "000_ruim.json").exists()
    assert (fila / "prova_exemplo.json").exists()                        # exemplo continua na fila


@pytest.mark.skipif(not (list((RAIZ / "ferramentas" / "rhubarb").glob("*/rhubarb*"))
                         and (RAIZ / "modelos" / "piper" / "pt_BR-faber-medium.onnx").exists()),
                    reason="Rhubarb/vozes offline ainda não baixados (python ferramentas/baixar.py)")
def test_desenho_animado_completo_em_modo_teste(tmp_path, monkeypatch):
    from robo import midia
    from robo.animacao.episodio import produzir_animado
    from robo.config import Config
    monkeypatch.setenv("VOZ_MOTOR", "piper")
    monkeypatch.setenv("TELEGRAM_TOKEN", "")
    cfg = Config.carregar(modo_teste=True)
    cfg.pasta_saida = tmp_path
    pasta = produzir_animado(cfg)
    video = pasta / "video_final.mp4"
    assert 30 < midia.duracao(video) < 70 and midia.tem_audio(video)
    pacote = (pasta / "PACOTE.txt").read_text(encoding="utf-8")
    for rede in ("YOUTUBE SHORTS", "INSTAGRAM REELS", "TIKTOK", "KWAI"):
        assert rede in pacote
    assert (pasta / "thumbnail.jpg").exists()


def test_amostras_de_voz_seguem_mesmo_se_uma_falhar(tmp_path, monkeypatch):
    def falso_edge(texto, cfg_voz, destino):
        if cfg_voz["voz"] == "pt-BR-NaoExisteNeural":
            raise RuntimeError("voz inexistente")
        destino.write_bytes(b"\xff" * 4000)
    monkeypatch.setattr(vozes, "_edge", falso_edge)
    feitas, falhas = vozes.amostras("Oi Vô", {
        "A": {"voz": "pt-BR-ThalitaMultilingualNeural", "velocidade": "+6%", "tom": "-4Hz"},
        "B": {"voz": "pt-BR-NaoExisteNeural"}}, tmp_path)
    assert [l.split(":")[0] for l, _ in feitas] == ["A"]
    assert "Thalita" in feitas[0][0] and feitas[0][1].exists()
    assert len(falhas) == 1 and falhas[0].startswith("B")


def test_candidatas_de_voz_no_serie_yaml():
    from robo.config import Config
    am = Config.carregar(modo_teste=True).serie["animacao"]["amostras_voz"]
    assert am["frase"] and len(am["lucas"]) >= 4 and len(am["vo"]) >= 2
    for cand in list(am["lucas"].values()) + list(am["vo"].values()):
        assert cand["voz"].startswith("pt-BR-") and cand["voz"].endswith("Neural")


def test_episodio_da_corrida_cobre_as_90_cenas_e_e_valido():
    from robo.animacao import longo_animado
    r = json.loads((RAIZ / "roteiros_longos_animados" / "a_corrida_mais_longa_do_vo.json").read_text(encoding="utf-8"))
    longo_animado.validar(r)
    lista = longo_animado.blocos(r)
    assert sorted({c for _, b in lista for c in b["cenas"]}) == list(range(1, 91))
    assert len(r["imagens"]) < 45                                         # 90 cenas, bem menos imagens
    assert {b["imagem"] for _, b in lista if b["tipo"] == "narracao"} == set(r["imagens"])
    assert sum(b["tipo"] == "conversa" for _, b in lista) >= 5
    assert len(r["cortes"]) == 6 and len(r["capitulos"]) == 6


def test_longo_animado_recusa_roteiro_quebrado():
    from robo.animacao import longo_animado
    base = {"tipo": "longo_animado", "imagens": {"a": {"prompt": "x"}},
            "capitulos": [{"titulo": "c", "blocos": [{"tipo": "narracao", "imagem": "b", "cenas": [1], "texto": "oi"}]}]}
    with pytest.raises(longo_animado.ErroRoteiro, match="imagem 'b'"):
        longo_animado.validar(json.loads(json.dumps(base)))
    base["capitulos"][0]["blocos"][0] = {"tipo": "conversa", "cenas": [1], "falas": [{"quem": "bisavo", "texto": "oi"}]}
    with pytest.raises(longo_animado.ErroRoteiro, match="fala inválida"):
        longo_animado.validar(base)


@pytest.mark.skipif(not (list((RAIZ / "ferramentas" / "rhubarb").glob("*/rhubarb*"))
                         and (RAIZ / "modelos" / "piper" / "pt_BR-faber-medium.onnx").exists()),
                    reason="Rhubarb/vozes offline ainda não baixados (python ferramentas/baixar.py)")
def test_longo_animado_completo_em_modo_teste(tmp_path, monkeypatch):
    from robo import midia
    from robo.animacao import longo_animado
    from robo.config import Config
    monkeypatch.setenv("VOZ_MOTOR", "piper")
    monkeypatch.setenv("TELEGRAM_TOKEN", "")
    roteiro = {"tipo": "longo_animado", "titulo": "Teste longo", "frase_capa": "TESTE", "capa_imagem": "rio",
               "imagens": {"rio": {"prompt": "river"}, "estrada": {"prompt": "road"}},
               "capitulos": [
                   {"titulo": "Começo", "blocos": [
                       {"tipo": "narracao", "imagem": "rio", "cenas": [1], "texto": "O rio estava calmo naquela manhã."},
                       {"tipo": "conversa", "retrato": "vo_e_lucas", "cenas": [2], "falas": [
                           {"quem": "lucas", "texto": "Vô, conta outra história!"},
                           {"quem": "vo", "texto": "Então senta, que essa é comprida."}]}]},
                   {"titulo": "Lembrança", "blocos": [
                       {"tipo": "narracao", "imagem": "estrada", "cenas": [3], "texto": "A estrada de chão parecia não ter fim."}]}],
               "cortes": [{"titulo": "O pedido do Lucas", "cenas": [2, 3]}]}
    arq = tmp_path / "ep.json"
    arq.write_text(json.dumps(roteiro, ensure_ascii=False), encoding="utf-8")
    cfg = Config.carregar(modo_teste=True)
    cfg.pasta_saida = tmp_path / "saida"
    pasta = longo_animado.produzir_longo_animado(cfg, arq)
    video = pasta / "video_longo.mp4"
    soma = sum(midia.duracao(c) for c in sorted((pasta / "blocos").glob("b*.mp4")))
    assert abs(midia.duracao(video) - soma) < 0.5 and midia.tem_audio(video)
    corte = pasta / "cortes" / "corte_1.mp4"
    assert corte.exists() and midia.duracao(corte) < midia.duracao(video)
    pacote = (pasta / "PACOTE.txt").read_text(encoding="utf-8")
    assert "00:00 Começo" in pacote and "Lembrança" in pacote and "TIKTOK" in pacote
    # continuar: rodar de novo na mesma pasta não refaz os blocos
    antes = {c.name: c.stat().st_mtime for c in (pasta / "blocos").glob("b*.mp4")}
    (pasta / "video_longo.mp4").unlink()
    longo_animado.produzir_longo_animado(cfg, pasta)
    assert {c.name: c.stat().st_mtime for c in (pasta / "blocos").glob("b*.mp4")} == antes
