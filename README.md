# TelaJunta

Aplicativo desktop para Windows, Linux e macOS: salas privadas, compartilhamento de tela e audio, chat e controle remoto opcional. O cliente Electron nao hospeda nem retransmite o video: o servidor Node.js faz a sinalizacao, e os participantes negociam uma conexao WebRTC ponto a ponto.

## Requisitos

- Node.js 20 ou superior e npm.
- Windows 10/11, uma distribuicao Linux compativel com Electron ou macOS 12 ou superior.
- Permissao do sistema operacional para compartilhar a tela. No macOS, conceda tambem Acessibilidade/Monitoramento de Entrada para controle remoto; no Linux, o controle depende da sessao grafica (Wayland pode bloquear automacao).
- Para compilar um instalador, use o sistema operacional de destino. A compilacao para macOS requer macOS e Xcode. A compilacao Windows produz o instalador NSIS; Linux produz AppImage e `.deb`.

## Executar localmente

```powershell
npm install
npm run server
```

Em outro terminal, dentro da pasta do projeto:

```powershell
npm start
```

O servidor local escuta em `ws://127.0.0.1:8787`. Para testar com outro computador na mesma rede, inicie-o com `HOST=0.0.0.0` e use TLS ou um proxy HTTPS; o aplicativo bloqueia `ws://` fora de localhost para nao enviar senhas em texto claro. A porta do servidor e configuravel pela variavel `PORT`. Para adicionar origens Web permitidas, configure `TELAJUNTA_ALLOWED_ORIGINS` como uma lista separada por virgulas; por padrao, apenas clientes locais Electron (`file://`/`null`) e conexoes sem cabecalho Origin sao aceitos.

## Gerar os instaladores

No Windows:

```powershell
npm install
npm run build:win
```

O build Windows gera o instalador `TelaJunta Setup 1.0.0.exe`, o executavel portatil autocontido `TelaJunta.exe` e a pasta com os arquivos do aplicativo em `release/`. O instalador cria atalhos no menu Iniciar e na area de trabalho; o executavel portatil pode ser aberto diretamente com dois cliques. Para Linux, execute `npm run build:linux` em Linux. Para macOS, execute `npm run build:mac` em macOS. Os instaladores resultantes sao produzidos na pasta `release/`. Os pacotes desta configuracao nao estao assinados: o Windows pode exibir o aviso do SmartScreen e o macOS pode exigir autorizacao explicita para abrir um app de desenvolvedor nao identificado. Distribuicao publica exige certificado de assinatura e, no macOS, notarizacao.

Os icones PNG, ICO e ICNS sao produzidos por `npm run build:icons` sem ferramentas externas. A tela inicial e apresentada pelo proprio aplicativo ao iniciar.

## Publicar o servidor na internet

O servidor precisa de HTTPS/WSS publico e um servidor TURN para redes em que a conexao ponto a ponto direta nao funcione. O trafego de tela/audio nao atravessa o servidor TelaJunta, mas as mensagens de sinalizacao, o chat, os codigos de sala e as senhas sim. Nao exponha o servidor sem TLS.

### TLS direto

Instale as dependencias (`npm install`) no host e disponibilize um certificado valido. Configure `PORT`, `HOST`, `TLS_CERT_FILE` e `TLS_KEY_FILE`, por exemplo:

```sh
HOST=0.0.0.0 PORT=8787 \
TLS_CERT_FILE=/etc/letsencrypt/live/exemplo.com/fullchain.pem \
TLS_KEY_FILE=/etc/letsencrypt/live/exemplo.com/privkey.pem \
npm run server
```

Opcionalmente, configure STUN/TURN em `TELAJUNTA_ICE_SERVERS` como um array JSON. Use credenciais TURN temporarias, com validade curta, e mantenha o segredo fora do repositorio e do aplicativo:

```sh
TELAJUNTA_ICE_SERVERS='[{"urls":["stun:turn.exemplo.com:3478"]},{"urls":["turn:turn.exemplo.com:3478?transport=udp","turn:turn.exemplo.com:3478?transport=tcp"],"username":"credencial-temporaria","credential":"segredo-temporario"}]'
```

O exemplo acima mostra apenas o formato; credenciais permanentes embutidas na configuracao nao sao apropriadas para producao. Para producao, gere credenciais TURN de curta duracao em um servico autenticado e inicie o processo com elas. Configure o TURN (por exemplo, coturn) com autenticacao, uma faixa de portas de retransmissao, limites de conexao e regras de firewall apropriados. O STUN publico padrao ajuda a descobrir enderecos de rede, mas nao substitui TURN.

### Atras de um proxy HTTPS

Outra opcao e terminar TLS em Nginx, Caddy ou outro proxy e encaminhar WebSocket para `127.0.0.1:8787`. Nesse caso, inicie o servidor TelaJunta apenas em loopback (`HOST=127.0.0.1`) e configure no proxy a passagem dos cabecalhos `Upgrade` e `Connection` para WebSocket. Configure o cliente com `wss://sinalizacao.exemplo.com`. Abra apenas as portas publicas necessarias no firewall e proteja o acesso administrativo ao servidor.

O servidor usa salas em memoria: reiniciar o processo encerra as salas e seus participantes. Senhas de sala sao armazenadas somente como hashes scrypt com salt aleatorio. O servidor aceita ate oito convidados por sala; o anfitriao e o proprietario da sala.

## Como usar

1. Execute o servidor e abra TelaJunta em cada computador.
2. Informe a URL de sinalizacao. Em uma implantacao publica, use `wss://...`.
3. O anfitriao cria uma sala com uma senha forte e envia **o codigo e a senha por um canal privado**.
4. O anfitriao clica em **Compartilhar tela**, escolhe uma tela ou janela e confirma o pedido de permissao do sistema.
5. Participantes podem conversar no chat e assistir ao compartilhamento. Para operar o computador, o convidado solicita controle; o anfitriao precisa aprovar no aplicativo e pode revogar a permissao a qualquer momento.

Compartilhamento de audio depende do suporte do sistema operacional e da fonte. O loopback de audio do desktop nao esta disponivel em todas as combinacoes de Electron/Windows/macOS/Linux. Na janela de selecao, o anfitriao pode marcar a alternativa de solicitar permissao do microfone quando nao houver audio do sistema; sem essa permissao, a tela continua sendo compartilhada sem audio. Verifique o indicador na sala. Em conexoes WebRTC sem sucesso, confirme a configuracao TURN e a conectividade UDP/TCP. Conteudo e controle usam criptografia de transporte DTLS-SRTP/WebRTC; sinalizacao precisa de HTTPS/WSS.

## Seguranca e limites

- O app usa isolamento de contexto, preload restrito, CSP, sem Node.js no renderer e valida autorizacao de controle tambem no processo principal do Electron.
- A senha protege a entrada na sala, mas nao substitui um canal privado para compartilhar o convite. O criador da sala deve manter seu dispositivo protegido.
- Compartilhar uma tela pode revelar qualquer conteudo visivel nela. Feche janelas privadas antes de compartilhar.
- Controle remoto e poderoso: aprove apenas pessoas de confianca e revogue ao terminar. Uma autorizacao ativa permite entrada de mouse e teclado no computador do anfitriao.
- O servidor de sinalizacao deve permanecer atualizado e atras de limites de rede adequados; salas sao temporarias e nao tem persistencia nem contas de usuario.
- macOS requer permissoes de Gravacao de Tela e, para controle, Acessibilidade. Wayland pode restringir captura/entrada; use uma sessao suportada se o controle nao estiver disponivel.




O PowerShell está bloqueando o script npm.ps1. Você pode contornar isso sem alterar a política de segurança usando npm.cmd:

No primeiro terminal, na pasta do projeto:

"npm.cmd install
npm.cmd run server"

Deixe o servidor aberto. Em outro terminal, na mesma pasta, inicie o app:

"npm.cmd start"

Se as dependências já estiverem instaladas, pode pular "npm.cmd install."