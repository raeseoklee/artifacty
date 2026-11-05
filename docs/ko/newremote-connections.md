# 원격 연결 프로필

[English](../newremote-connections.md) | 한국어

원격 연결 프로필은 Artifacty 0.18.1부터 제공합니다. MCP 서버에 로컬 이름을 부여하고, 활성 프로필을 따르는 클라이언트는 각 MCP 설정을 다시 편집하지 않고 서버를 바꿀 수 있습니다.

가능하면 서버에 고정 DNS 이름을 사용하세요. DNS나 리버스 프록시의 대상만 바꾸면 클라이언트 설정 변경을 피할 수 있습니다. 실제 공개 URL이 바뀌어야 할 때는 연결 프로필을 사용할 수 있습니다.

## 프로필로 클라이언트 연결하기

대상 서버에서 Artifacty HTTP MCP를 제공해야 합니다. 서버의 HTTP MCP 기능을 활성화하고, 인증이 필요하면 해당 서버에서 발급한 토큰을 준비하세요.

```sh
artifacty remote add company https://artifacty.example.com
artifacty remote use company
artifacty remote check
artifacty install all --remote active
```

`add`는 서버의 기본 URL을 저장하고, `use`는 활성 프로필을 선택합니다. `check`는 MCP 초기화와 도구 검색을 검증하며 아티팩트를 생성하지 않습니다. `install`은 지원하는 클라이언트에 로컬 stdio 브리지를 등록합니다. 처음 설치한 뒤 클라이언트를 재시작하거나 다시 연결하세요.

인증이 필요한 서버는 프로필을 추가할 때 토큰을 지정합니다.

```sh
artifacty remote add company https://artifacty.example.com --api-token YOUR_SERVER_TOKEN
artifacty remote check company
```

`YOUR_SERVER_TOKEN`은 예시 값입니다. 실제 토큰이 셸 기록이나 공유 명령 로그에 남지 않도록 주의하세요. 프로필 명령의 출력에는 저장된 토큰을 표시하지 않습니다.

`artifacty remote list`로 저장된 프로필 이름과 활성 프로필을 확인합니다. `artifacty remote check company`는 활성 선택을 바꾸지 않고 지정한 프로필을 검사합니다.

## 연결 서버 바꾸기

```sh
artifacty remote add backup https://backup.example.com
artifacty remote check backup
artifacty remote use backup
```

`--remote active`로 설치한 브리지는 요청마다 활성 프로필을 읽습니다. 이후 요청은 선택한 서버로 전달하지만, 이전 서버의 세션·진행 중인 작업·아티팩트·사용자·권한이 이전되는 것은 아닙니다. 클라이언트가 이전 서버의 상태를 유지한다면 다시 연결하세요.

`artifacty install codex --remote company`는 해당 클라이언트를 `company` 프로필에 고정합니다. `company`의 주소 변경은 따르지만, `remote use backup`으로 활성 프로필을 바꿔도 이 클라이언트는 계속 `company`를 사용합니다. `remote use`를 따르게 하려면 `--remote active`로 설치하세요.

기존 HTTPS 프로필이나 HTTPS 연결을 HTTP로 바꾸려면 `--allow-insecure-downgrade`를 명시해야 합니다. 로컬 서버가 아니라면 HTTPS를 권장합니다.

기존 프로필의 URL을 바꾸면 저장된 토큰을 제거합니다. 인증 도구를 사용하기 전에 새 서버에서 발급한 토큰을 지정하세요. 이전 서버의 토큰을 새 서버로 자동 전달하지 않으며, 연결 검사에서도 HTTP 리디렉션을 따르지 않습니다.

## 기존 클라이언트 설정 이전하기

먼저 이전 URL과 일치하는 Artifacty 항목을 미리 확인하세요.

```sh
artifacty remote migrate http://192.0.2.10:8787 \
  --to https://artifacty.example.com --dry-run
```

위 주소는 문서용 예시입니다. 실제 이전 서버의 URL로 바꿔서 사용하세요.

결과를 확인한 뒤 변경을 적용합니다.

```sh
artifacty remote migrate http://192.0.2.10:8787 \
  --to https://artifacty.example.com
```

기본적으로 현재 프로젝트의 `.mcp.json`, `.gemini/settings.json`, `.vscode/mcp.json`, `.cursor/mcp.json`과 `~/.codex/config.toml`을 확인합니다. `--project-dir`로 다른 프로젝트를 지정하거나 `--agent`로 클라이언트 하나를 선택할 수 있습니다. 기본 경로에 없는 파일은 건너뜁니다.

지원하는 클라이언트 설정 파일에서 이전 URL과 일치하는 Artifacty 항목만 변경합니다. 다른 서버와 설정은 보존하고, 변경할 파일마다 접근을 제한한 백업을 만들며, 새 서버의 연결을 검증한 뒤 적용합니다. 이전 Artifacty 연결의 인증 정보와 네이티브 HTTP 헤더는 새 서버로 전달하지 않고 제거합니다. 브리지 항목에는 빈 `ARTIFACTY_API_TOKEN`도 설정하므로, 셸에서 상속한 값이 새 서버로 전달되지 않습니다. 명령을 실행한 환경에 이 변수가 있으면 결과에 경고가 포함됩니다. 서버별 환경 설정을 적용하지 않는 클라이언트를 시작하기 전에 변수를 해제하세요. Artifacty가 안전하게 고칠 수 없는 점 표기 TOML 키가 있으면 파일을 바꾸지 않고 이전을 중단합니다. 대상 서버에 필요한 별도 헤더가 있다면 이전 후 다시 설정하세요. 새 서버에 인증이 필요하면 해당 서버에서 발급한 토큰을 `--api-token`으로 지정하세요.

특정 설정 파일만 지정하려면 두 옵션을 함께 사용합니다.

```sh
artifacty remote migrate http://192.0.2.10:8787 \
  --to https://artifacty.example.com \
  --agent codex --config /path/to/config.toml --dry-run
```

지원하는 에이전트는 `claude`, `codex`, `gemini`, `copilot`, `cursor`입니다. 지원하지 않는 문법이 있는 설정 파일은 다시 쓰지 않고 오류를 반환합니다. 특히 주석이 들어 있는 JSON 파일은 일반 JSON으로 처리하지 않습니다. 적용 결과를 확인한 뒤 해당 클라이언트를 다시 연결하세요. 네이티브 HTTP 연결은 동적 로컬 프로필 브리지를 사용하지 않으므로 재연결이 필요합니다.

설정 이전은 서버 데이터를 옮기는 기능이 아닙니다. 실제 Artifacty 저장소는 별도로 백업·이전하고, 새 서버의 접근 권한을 확인한 뒤 이전 서버를 종료하세요.

## 설정과 인증 정보

`ARTIFACTY_REMOTE`는 사용할 프로필 이름이며, `active`이면 `remote use`로 선택한 프로필을 따릅니다. 프로필은 `ARTIFACTY_CONFIG_HOME`에 저장하며, 기본 경로는 `~/.config/artifacty`입니다. 프로필 파일은 로컬 계정만 접근할 수 있도록 제한하지만, 토큰 자체는 암호화하지 않습니다. 디렉터리와 백업의 접근을 보호하세요. 테스트나 별도 로컬 계정 설정을 분리하려면 다른 설정 홈을 사용합니다.

토큰은 프로필과 대상 서버별로 관리합니다. 별도의 `ARTIFACTY_API_TOKEN`을 프로필 연결에 자동으로 사용하지 않습니다. 새 연결을 검증할 때까지 이전 클라이언트 설정 백업을 보관하고, 프로필·설정 백업·토큰을 저장소에 커밋하지 마세요.
