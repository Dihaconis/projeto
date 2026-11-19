"""Testes. Rode com:  python -m pytest -q"""
from pathlib import Path

import pytest

from robo.agentes import diretor_arte, editor, roteirista
from robo.config import Config
from robo.llm import ErroLLM, _extrair_json


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_TOKEN", "")
    monkeypatch.setenv("MUSICA_FUNDO", "")
    c = Config.carregar(modo_teste=True)
    c.pasta_saida = tmp_path
    return c


def test_extrai_json_de_bloco_markdown():
    assert _extrair_json('```json\n{"a": 1}\n```') == {"a": 1}
    with pytest.raises(ErroLLM):
        _extrair_json("sem json aqui")


def test_roteiro_rejeita_poucas_cenas(cfg):
    with pytest.raises(ErroLLM):
        roteirista.validar_roteiro({"cenas": [{"narracao": "a", "descricao_visual": "b"}]}, cfg)


def test_prompt_de_imagem_inclui_personagem_e_estilo(cfg):
    p = diretor_arte.montar_prompt(cfg, {"descricao_visual": "Lucas pulando no rio",
                                         "imagem_en": "Lucas, the boy, jumping into the river"})
    assert p.startswith("Woodcut")              # estilo primeiro
    assert "11-year-old" in p and "jumping into the river" in p
    assert "leather hat" not in p               # o Vô não estava na cena
    assert len(p.split()) <= 70                 # curto: o gerador grátis corta textos longos


def test_filtro_xilogravura_mantem_tamanho(tmp_path):
    import numpy as np
    from PIL import Image
    from robo.agentes import estilo
    rng = np.random.default_rng(1)
    Image.fromarray(rng.integers(0, 255, (320, 180, 3), dtype=np.uint8)).save(tmp_path / "foto.jpg")
    estilo.aplicar_xilogravura(tmp_path / "foto.jpg", tmp_path / "xilo.jpg")
    assert Image.open(tmp_path / "xilo.jpg").size == (180, 320)


def test_legenda_tem_tempos_crescentes():
    cenas = [{"narracao": "Uma frase curta. Outra frase aqui."},
             {"narracao": "Segunda cena com várias palavras para quebrar em pedaços"}]
    srt = editor.gerar_legenda(cenas, [3.0, 4.0])
    assert srt.startswith("1\n00:00:00,000 --> ")
    assert "00:00:07,000" in srt                # termina na soma das durações


def test_episodio_completo_em_modo_teste(cfg):
    from robo.chefe import produzir_episodio
    pasta = produzir_episodio(cfg)
    for nome in ["video_final.mp4", "thumbnail.jpg", "roteiro.json",
                 "textos.json", "legendas.srt", "PACOTE.txt"]:
        assert (pasta / nome).exists(), nome
    from robo import midia
    dur = midia.duracao(pasta / "video_final.mp4")
    assert 20 < dur < 90
    assert midia.tem_audio(pasta / "video_final.mp4")


def test_colab_pede_imagens_e_depois_continua(cfg, tmp_path):
    """Sem imagens no Drive: grava o pedido e para. Com as imagens: segue até o vídeo."""
    import json
    from PIL import Image
    from robo.agentes.diretor_arte import AguardandoImagens, desenhar
    drive = tmp_path / "drive"
    drive.mkdir()
    cfg.modo_teste = False
    cfg.imagens_origem = "colab"
    cfg.pasta_drive = drive
    cfg.serie["formato"]["filtro_xilogravura"] = False
    roteiro = json.loads(json.dumps(roteirista.ROTEIRO_TESTE))
    pasta = tmp_path / "EP-teste"

    with pytest.raises(AguardandoImagens) as espera:
        desenhar(cfg, roteiro, pasta)
    assert espera.value.faltam == 6
    pedido = json.loads((drive / "pedidos" / "EP-teste.json").read_text(encoding="utf-8"))
    assert len(pedido["cenas"]) == 6 and pedido["largura"] == 768
    assert pedido["cenas"][0]["arquivo"] == "cena_01_bruta.jpg"

    # o Colab "devolve" as imagens
    volta = drive / "imagens" / "EP-teste"
    volta.mkdir(parents=True)
    for c in pedido["cenas"]:
        Image.new("RGB", (768, 1344), "#6B4423").save(volta / c["arquivo"])
    imagens = desenhar(cfg, roteiro, pasta)
    assert len(imagens) == 6
    assert Image.open(imagens[0]).size == (1080, 1920)


def test_fila_de_roteiros_usa_o_mais_antigo_e_separa_os_com_erro(cfg, tmp_path, monkeypatch):
    import json
    drive = tmp_path / "drive"
    fila = drive / "roteiros"
    fila.mkdir(parents=True)
    cfg.modo_teste = False
    cfg.pasta_drive = drive
    monkeypatch.setattr(roteirista, "RAIZ", tmp_path / "sem_fila_local")
    (fila / "001-quebrado.json").write_text("{nao e json", encoding="utf-8")
    bom = dict(roteirista.ROTEIRO_TESTE, textos={"titulo": "T", "descricao": "D", "hashtags": []})
    (fila / "002-bom.json").write_text(json.dumps(bom, ensure_ascii=False), encoding="utf-8")
    roteiro, origem = roteirista.pegar_da_fila(cfg)
    assert origem.name == "002-bom.json" and len(roteiro["cenas"]) == 6
    assert (fila / "usados" / "002-bom.json").exists()
    assert (fila / "com_erro" / "001-quebrado.json").exists()
    assert roteirista.pegar_da_fila(cfg) is None


def test_flow_kit_pausa_uma_vez_e_depois_usa_os_clipes(cfg, tmp_path):
    """Com ANIMAR=1: deixa o kit, para uma vez; no --continuar usa o clipe que existir."""
    import json
    from PIL import Image
    from robo import midia
    from robo.agentes.diretor_arte import AguardandoImagens, preparar_flow, trocar_por_clipes
    drive = tmp_path / "drive"
    pasta = tmp_path / "EP-flow"
    pasta.mkdir()
    cfg.modo_teste, cfg.pasta_drive, cfg.animar = False, drive, True
    roteiro = json.loads(json.dumps(roteirista.ROTEIRO_TESTE))
    imagens = []
    for i in range(1, 7):
        img = pasta / f"cena_{i:02d}.jpg"
        Image.new("RGB", (1080, 1920), "#1F3B2A").save(img)
        imagens.append(img)

    with pytest.raises(AguardandoImagens):
        preparar_flow(cfg, roteiro, imagens, pasta)
    kit = drive / "clipes" / "EP-flow"
    assert (kit / "MOVIMENTOS.txt").exists() and (kit / "cena_06.jpg").exists()
    preparar_flow(cfg, roteiro, imagens, pasta)          # segunda vez não para

    # "baixa do Flow" um clipe curto (2 s, 16:9) só para a cena 2
    midia.rodar(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24:duration=2",
                 "-pix_fmt", "yuv420p", str(kit / "cena_02.mp4")])
    visuais = trocar_por_clipes(cfg, pasta, imagens)
    assert visuais[1].suffix == ".mp4" and visuais[0].suffix == ".jpg"

    # o editor estica o clipe de 2 s para 5 s e corta para 9:16
    from robo.agentes.editor import _clipe_animado
    saida = tmp_path / "ajustado.mp4"
    _clipe_animado(visuais[1], 5.0, saida)
    assert abs(midia.duracao(saida) - 5.0) < 0.2


def test_postagem_por_rede_respeita_limites():
    from robo.agentes.social import por_rede
    textos = {"titulo": "T" * 150, "descricao": "Desc. Pergunta?",
              "hashtags": [f"#tag{i}" for i in range(12)]}
    redes = por_rede(textos)
    assert set(redes) == {"YOUTUBE SHORTS", "INSTAGRAM REELS", "TIKTOK", "KWAI"}
    assert "#shorts" in redes["YOUTUBE SHORTS"]
    assert redes["TIKTOK"].count("#") == 5 and redes["KWAI"].count("#") == 3
    assert ("T" * 101) not in redes["YOUTUBE SHORTS"]


def _roteiro_longo(n_caps=4, por_cap=5):
    caps = []
    for c in range(n_caps):
        caps.append({"titulo": f"Capítulo {c + 1}", "cenas": [
            {"narracao": f"Cena {c}-{i}. O Vô contou mais um pedaço do causo pro Lucas.",
             "descricao_visual": "Lucas e o Vô na canoa", "imagem_en": "Lucas, the boy, and Grandpa in a canoe"}
            for i in range(por_cap)]})
    return {"titulo_episodio": "Teste longo", "capitulos": caps,
            "cortes": [{"titulo": "Corte um", "cenas": [1, 5], "descricao": "D1", "hashtags": ["#a"]},
                       {"titulo": "Corte dois", "cenas": [11, 15], "descricao": "D2", "hashtags": ["#b"]}],
            "textos": {"titulo": "Teste longo", "texto_capa": "TESTE LONGO", "descricao": "Desc.",
                       "hashtags": ["#x"]}}


def test_longo_valida_e_calcula_capitulos():
    from robo.agentes.longo import capitulos_youtube, validar_longo
    r = validar_longo(_roteiro_longo())
    assert len(r["cenas"]) == 20 and r["tipo"] == "longo"
    caps = capitulos_youtube(r, [10.0] * 20).splitlines()
    assert caps[0] == "00:00 Capítulo 1" and caps[1] == "00:50 Capítulo 2" and len(caps) == 4
    ruim = _roteiro_longo()
    ruim["cortes"][0]["cenas"] = [18, 25]
    with pytest.raises(ErroLLM):
        validar_longo(ruim)


def test_episodio_longo_com_cortes_em_modo_teste(cfg, tmp_path, monkeypatch):
    import json
    from robo import midia
    from robo.agentes import longo
    fila = tmp_path / "fila_longa"
    fila.mkdir()
    (fila / "001.json").write_text(json.dumps(_roteiro_longo(), ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(longo, "_pastas_fila", lambda c: [fila])
    pasta = longo.produzir_longo(cfg)
    video = pasta / "video_longo.mp4"
    assert video.exists() and midia.tem_audio(video)
    w, h = midia_tamanho(video)
    assert (w, h) == (1920, 1080)
    for n in (1, 2):
        corte = pasta / f"corte_{n:02d}" / "video_final.mp4"
        assert corte.exists()
        assert midia_tamanho(corte) == (1080, 1920)
    pacote = (pasta / "PACOTE.txt").read_text(encoding="utf-8")
    assert "00:00 Capítulo 1" in pacote and "CORTE 2" in pacote
    assert (pasta / "thumbnail_youtube.jpg").exists()


def midia_tamanho(video):
    import subprocess
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height", "-of", "csv=p=0", str(video)],
                         capture_output=True, text=True).stdout.strip()
    w, h = out.split(",")
    return int(w), int(h)


def test_vigia_so_monta_quando_todas_as_imagens_chegaram(cfg, tmp_path):
    import json
    from PIL import Image
    from robo import vigia
    drive = tmp_path / "drive"
    cfg.pasta_drive = drive
    pasta = cfg.pasta_saida / "EP-vigia"
    pasta.mkdir(parents=True)
    (pasta / "roteiro.json").write_text(json.dumps(roteirista.ROTEIRO_TESTE), encoding="utf-8")
    assert not vigia.imagens_completas(cfg, pasta)
    volta = drive / "imagens" / "EP-vigia"
    volta.mkdir(parents=True)
    for i in range(1, 7):
        Image.new("RGB", (10, 10)).save(volta / f"cena_{i:02d}_bruta.jpg")
    assert vigia.imagens_completas(cfg, pasta)
    chamados = []
    vigia.vigiar(cfg, 0.0005, lambda c, continuar: chamados.append(continuar) or True, intervalo=0)
    assert chamados and chamados[0] == pasta
