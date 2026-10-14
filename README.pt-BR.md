# Savage Worlds Compatibility Package for Gravewright

![Savage Worlds Fan Product](assets/branding/savage-worlds-logo.png)

[English](README.md)

Lançamento `gravewright.savage-worlds` **0.1.0** desta implementação para Django, revisado com a
edição brasileira revisada de SWADE de 2026. Mantém o cabeçalho horizontal,
as cinco abas e a paleta do VTT. Toda a lógica Savage Worlds fica neste projeto;
o core oferece apenas seus contratos genéricos.

As coleções e descrições começam vazias. Não são distribuídos o PDF de referência,
descrições do livro, cenários, personagens ou compêndios. A única imagem oficial
incluída é o logo indicado para uso com permissão, preservado sem alterações.
O usuário cria seu conteúdo e configura seus efeitos mecânicos.

O pacote permanece gratuito e focado em compatibilidade técnica. Nome, marcas e
logo da Pinnacle ficam fora da licença MIT do código original.

This game references the Savage Worlds game system, available from Pinnacle Entertainment Group at www.peginc.com. Savage Worlds and all associated logos and trademarks are copyrights of Pinnacle Entertainment Group. Used with permission. Pinnacle makes no representation or warranty as to the quality, viability, or suitability for purpose of this product.

## Instalação

Requer [Gravewright VTT **0.2.3 ou posterior**](https://github.com/Gravewright/gravewright/releases/tag/v0.2.3),
SDK **1.0.0** e sua API de tradução. A versão 0.2.3 inclui os contratos genéricos
`context.host` e `card.asset.upload` usados na importação de baralhos.

Baixe os dois ZIPs na [release 0.1.0](https://github.com/Gravewright/Savage-Worlds-Compatibility-Package-for-Gravewright/releases/tag/v0.1.0),
ou instale pelo Marketplace assinado do Gravewright.
Este projeto produz dois pacotes:

1. Instale `dist/gravewright-savage-worlds-rules-0.1.0.zip` em **Módulos**, como
   extensão Django, e ative pelo instalador nativo. O Runner realiza o reinício.
2. Instale `dist/gravewright-savage-worlds-0.1.0.zip` em **Sistemas** e selecione
   **Savage Worlds Compatibility Package for Gravewright** na mesa. Mesas existentes precisam selecionar a
   versão nova explicitamente nas extensões da mesa.

O sistema e a extensão de regras do servidor usam **0.1.0** neste lançamento.
As numerações 0.2.x–0.4.0 eram internas de desenvolvimento. Em mesas de teste,
selecione **0.1.0** explicitamente; a versão numericamente maior pode continuar
selecionada. Os IDs dos pacotes, dados das fichas e configurações são preservados.
A numeração pertence à implementação nova e não renomeia releases do pacote
de compatibilidade publicado anteriormente.

Atualize instalações anteriores do Gravewright 0.2.2 para 0.2.3 antes de importar baralhos.

O build não instala nem ativa os pacotes em produção e não altera `.env`.
Sem a extensão de servidor, as fichas e rolagens continuam disponíveis, mas
avançar o combate exige a ativação do provedor correspondente.

## Idiomas com o Translator oficial

Instale e ative o [Translator](https://github.com/Gravewright/translator) nos
Módulos instalados. Na mesa, abra **Configurações → Preferências → Idioma da
interface** e escolha **Português (Brasil)**, **Español** ou **English**.
O idioma pertence à conta de cada participante; o fluxo nativo recarrega a mesma
mesa e conserva a escolha. A integração foi verificada com o Translator 0.1.2.

O SWADE registra seus 646 rótulos por idioma pelo `context.i18n.register` e usa
`api.i18n.t` e `api.i18n.onChange`. Os catálogos ficam no pacote do sistema,
isolados do catálogo nativo e dos outros módulos. Sem um pacote de idioma ativo,
o host usa inglês. A interface é marcada com `translate="no"` para evitar
tradução duplicada pelo mecanismo legado.

Fichas, itens, combate, modais e Personalizar traduzem seus rótulos, dicas e
mensagens. Uma atualização de idioma pelo adaptador conserva os controles,
rascunhos, foco, seleção e ações pendentes. Nomes, descrições e dados escritos
pelo usuário mantêm o texto original. O nome público do produto, o logo Fan
Product e o aviso literal da Pinnacle conservam sua apresentação autorizada.
As prévias de baralhos usam imagens sem títulos de interface embutidos;
os nomes e contadores são traduzidos pelo Translator.

## Recursos do sistema

Em **Extensões → Savage Worlds → Personalizar**, o mestre configura esta mesa:

- **Baralhos de ação**: Clássico Marfim, Gravewright Escuro e Gravura Aventura.
  Cada estilo traz 52 imagens de cartas, dois Coringas e um verso original.
  **Criar e usar** importa as imagens e cria um baralho nativo. A importação
  guarda o progresso; repetir a escolha reutiliza o baralho criado.
- **Configurações da mesa**: nome e visibilidade da moeda, uso de Pontos de
  Poder, limite de Ferimentos por golpe, Benes por Coringa, redução de Movimento
  por Ferimentos e penalidades de carga. **Salvar** compartilha as opções.
- **Sobre**: logo Fan Product autorizado, escopo gratuito de compatibilidade e
  aviso em inglês fornecido pela Pinnacle, reproduzido literalmente.

Participantes podem consultar as opções e visualizar as cartas. Somente mestres
alteram configurações e criam baralhos. As fichas herdam as regras da mesa;
**Configurar personagem** permite exceções individuais. Ocultar moeda ou
desativar PP preserva os saldos e reservas. Conflitos mantêm o rascunho.
As opções e configurações vivem exclusivamente no pacote SWADE.

- Personagens e NPCs podem representar Cartas Selvagens ou Extras. Configure
  o perfil, papel no encontro, Dado Selvagem, Tamanho, capacidade de Ferimentos,
  corrida, carga e exceções em **Configurar personagem**.
- Fichas novas calculam Aparar, Resistência, armadura, movimentação, carga e
  estágio. Substituições manuais têm prioridade. Fichas antigas preservam seus
  totais e ficam manuais até o usuário ativar os cálculos.
- Armaduras em camadas, escudos, áreas protegidas, unidades de peso, quantidades
  e o campo **Carregado** participam dos cálculos. **Equipar** usa uma modal.
- Características agrupam vantagens, complicações, ancestralidades, traços
  raciais e efeitos. Modificadores numéricos são preenchidos pelo usuário;
  habilidades nunca são identificadas pelo nome.
- Poderes têm reservas e perícias separadas por Antecedente Arcano, custos
  configuráveis, redução de PP, manutenção, duração e recarga.
- Dispositivos arcanos vinculam os poderes da ficha e têm reserva própria.
  Investir/recolher PP respeita o limite por ação e conserva a alocação, impedindo
  que uma recarga pessoal recrie pontos ainda investidos no dispositivo.
- O registro de Progressos verifica disponibilidade, estágios e frequência de
  aumento de atributos, sem uma lista de vantagens ou requisitos do livro.

Treze templates: `weapon`, `armor`, `equipment`, `consumable`, `skill`, `edge`,
`hindrance`, `ancestry`, `racial-feature`, `power`, `effect`, `vehicle` e
`arcane-device`. Itens de biblioteca e suas cópias independentes usam as APIs
nativas e seguem as permissões do host.

## Rolagens e combate

O motor nativo publica as rolagens. O pacote interpreta Ases, Dado Selvagem,
testes sem perícia, sucessos, ampliações, testes resistidos, falhas críticas e
rerrolagens com Benes. Ferimentos, Fadiga, estados, carga e Ações Múltiplas
aplicam penalidades conforme o contexto. Ataques oferecem modificadores
circunstanciais. Dano não recebe Dado Selvagem.

**Receber dano** apresenta o resultado contra Resistência e armadura, oferece
Absorção antes dos Ferimentos e respeita Extras, Cartas Selvagens e capacidades
configuráveis. Recuperação, cura natural, estabilização, Suporte e Desafios usam
resultados explícitos. Detalhes de lesões, poderes e decisões narrativas são
informados pelo usuário, sem reproduzir tabelas de conteúdo do livro.

O tracker exige um baralho criado e selecionado pelo sistema nativo de cartas.
**Personalizar → Baralhos de ação** cria um dos três estilos e define o padrão
da mesa. Combates mantêm seu baralho até serem encerrados. Uma escolha explícita
em **Combate → Configurar baralho** prevalece sobre o padrão da mesa.
Em **Sua mão → Baralhos → Criar baralho**, o mestre também pode fornecer suas
próprias imagens e nomes.
Para Cartas de Ação padrão, configure as 52 cartas de um baralho comum e dois
Curingas, com nomes como `A ♠`, `K ♥`, `★ 1` e `★ 2`. O pacote cria baralhos apenas
por uma escolha explícita em Personalizar. Trocar o baralho de um combate exige
encerrá-lo. As prévias do tracker usam apenas as faces autorizadas para quem vê
o painel pelos contratos nativos.
Ao migrar do protótipo interno 0.3.1, selecione um baralho nativo explicitamente; o ID
de um baralho automático antigo não vale como configuração. Cada Carta de Ação
sacada precisa ter sua imagem de frente no sistema nativo.

O tracker interpreta ordem por valor e naipe, grupos, Aguardar, saques extras
com Benes e bônus de Curinga a partir desse baralho. O mestre
controla sua reserva de Benes e pode transferir um Bene a um NPC/Extra sem Bene.
O mestre distribui as cartas e confirma **Começar rodada** após os saques adicionais.
No painel **Combate**, o mestre adiciona participantes e escolhe **Iniciar combate**;
o início exige pelo menos um participante e um baralho selecionado disponível.
**Pausar** preserva as cartas, a rodada
e o turno atual; **Retomar** continua dessa posição salva. A pausa persiste ao
reabrir o painel. **Encerrar combate** conclui o encontro. O painel indica se
o combate está parado, em andamento ou pausado.
Os turnos e as permissões pertencem ao combate nativo. A extensão de servidor
avança relógios configurados, inclusive em turnos pulados, sem rolar ações ou
dano por conta própria. Voltar no combate não desfaz resultados ou recursos.

## Modais e dados

Janelas auxiliares usam `api.ui.openModal` com elementos `section`, sem a tag
HTML `dialog` ou alertas do navegador. Foco, Escape, seleção de texto,
empilhamento e fechamento seguem os contratos nativos. O fechamento aguarda
operações; retries conservam a mesma criação, cópia, rolagem ou aplicação.

A edição salva automaticamente com versões. Conflitos preservam o rascunho
até uma revisão explícita. As permissões do servidor são respeitadas, inclusive
a exigência de mestre para gerar efeitos de Suporte. Tokens vinculados
compartilham a ficha; snapshots independentes preservam seus próprios dados.

Os dados ficam diretamente em `api.actors.sheet(...).data`, com `schemaVersion: 2`.
Dados dos protótipos anteriores e campos adicionais são preservados pela normalização.
Código de servidor: `server/gravewright_swade`, sem modelos, tabelas, rotas ou
dependências adicionais no host.

## Verificação e build

```sh
npm test
python -m unittest discover -s tests -p "test_package.py"
python tests/test_item_editor_browser.py
python tests/test_modal_browser.py
python tests/test_actions_browser.py
python tests/test_customization_browser.py
python tests/e2e/languages.py
python server/tests/run_django_tests.py
python scripts/build_server.py
python scripts/build.py
python scripts/validate_package.py
```

As suítes em `tests/e2e` instalam ZIPs reais em banco, mídia e mesa descartáveis,
sem alterar `.env` ou dados em uso. O ZIP de navegador exclui Python, ferramentas,
testes e referências privadas. Ambos os ZIPs têm SHA-256. Código original sob
[MIT](LICENSE.md); escopo em [NOTICE.md](NOTICE.md).
