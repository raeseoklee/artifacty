[English](../integrations.md) | 한국어

<!-- 번역 기준: 9e73a9f -->
<!-- 문장·의미 대조: 2026-10-20, 영문 동시 개정본 기준 -->

# 에이전트 연동

Artifacty는 여러 에이전트가 함께 사용하는 MCP stdio 서버와 로컬 브라우저 서버를 제공합니다.

Node.js 22.12.0 이상을 사용하세요. 선택 기능인 Babel 8 React 렌더러에는 Node `^22.18.0 || >=24.11.0`이 필요합니다. Mermaid 12.2.0에는 Safari 17.4 이상처럼 ES2024를 지원하는 브라우저가 필요합니다.

## 브라우저 서버 시작

```bash
npm start
```

대시보드는 기본적으로 `http://127.0.0.1:8787`을 사용합니다. 포트를 따로 지정하지 않았고 기본 포트가 사용 중이면, 서버는 다음으로 사용 가능한 로컬 포트를 선택합니다. 실제 URL은 저장소에 기록합니다. 기본 저장소는 `~/.artifacty`입니다. 다른 로컬 디렉터리를 사용하려면 `ARTIFACTY_HOME`을 설정하세요.

인증으로 보호되는 서버를 포그라운드에서 실행할 때는 시작 시 생성하는 토큰을 사용할 수 있습니다.

```bash
node src/cli.js serve --foreground --generate-token
node src/cli.js serve --foreground --host 0.0.0.0 --share-mode lan --generate-token
npm start -- --generate-token
```

서버를 포그라운드에서 실행하면 생성된 토큰과 아티팩트 생성·가져오기 화면의 URL을 출력합니다. 이 URL은 브라우저에서 바로 열 수 있습니다. 백그라운드에서 실행하면 같은 값을 JSON으로 반환합니다.

로컬 서버를 백그라운드에서 실행하려면 다음 관리 명령을 사용하세요.

```bash
node src/cli.js serve --port 8787
node src/cli.js start --port 8787
node src/cli.js status
node src/cli.js stop
```

`serve`, `serve --detach`, `start`는 같은 방식으로 분리된 프로세스를 실행합니다. 이 명령은 `ARTIFACTY_HOME` 아래에 `server.pid`, `server.json`, 로그를 기록합니다. 기본 경로는 `~/.artifacty`입니다. `--generate-token`을 지정하면 `serve`와 `start`의 부모 CLI 프로세스가 API 토큰을 생성합니다. JSON 응답에는 토큰과 생성·가져오기 URL이 포함됩니다. 디버깅 중 터미널에서 로그를 직접 보려면 `serve --foreground`를 사용하세요.

서버 관리 명령은 여러 운영체제에서 사용할 수 있도록 설계했습니다.

- macOS와 Linux: `stop`은 먼저 분리된 프로세스 그룹에 종료 신호를 보냅니다. 이 방법을 사용할 수 없으면 서버 프로세스 ID로 신호를 보냅니다.
- Windows: `start`는 자식 프로세스의 콘솔 창을 숨깁니다. `stop`은 `taskkill /PID <pid> /T`를 사용합니다. 강제 종료가 필요하면 `stop`은 `/F`를 붙여 다시 시도합니다. `--force`를 지정하면 처음부터 `/F`를 사용합니다.
- 모든 운영체제: `status`는 관리 대상 PID 파일과 HTTP `/health` 엔드포인트를 확인합니다. 오래된 PID가 남아 있다는 이유만으로 서버를 정상 상태로 보고하지 않습니다.

설정이 예상대로 동작하지 않으면 진단을 실행하세요.

```bash
node src/cli.js doctor
node src/cli.js doctor --skip-mcp
```

`doctor`는 Node 버전 지원 여부, 로컬 네트워크 노출 설정, 저장소 무결성, 관리 대상 서버 상태, 서비스 정의 생성, MCP 탐색을 확인합니다. 서버가 중지되어 있으면 실패가 아닌 경고로 보고합니다.

로그인하거나 시스템을 시작할 때 서버를 자동으로 실행하려면 운영체제의 서비스 관리자를 사용하세요. Artifacty의 `service` 명령은 macOS LaunchAgent, Linux systemd 사용자 유닛, Windows 작업 스케줄러 정의를 생성할 수 있습니다.

브라우저의 `http://127.0.0.1:8787/new`에서 아티팩트를 직접 생성할 수 있습니다.

LAN이나 VPN으로 공유할 때도 다른 컴퓨터의 접근이 꼭 필요한 경우가 아니면 기본 로컬 바인딩을 유지하세요. `--host 0.0.0.0`을 사용하기 전에 [네트워크 공유](network-sharing.md)를 확인하세요.

브라우저의 생성·가져오기·편집 화면은 CodeMirror 6를 사용합니다. Markdown, HTML, JSON, 소스 코드 형태의 텍스트, SVG, Mermaid, React, SARIF, CSV, 이미지, 동영상 아티팩트를 지원합니다. Artifacty는 로컬 npm 의존성에서 편집기와 렌더러 자산을 제공합니다. 이를 위해 `/assets/*.js`와 허용 목록에 있는 `/vendor/npm/*` 모듈 경로를 사용합니다. 샌드박스 iframe의 `Origin: null` 요청에는 `Access-Control-Allow-Origin: null`을 반환합니다. 이 방식으로 출처가 불투명한 iframe이 `allow-same-origin` 없이 로컬 ESM을 가져올 수 있습니다.

브라우저 UI의 기본 언어는 영어입니다. 한국어 UI를 사용하려면 브라우저 경로에 `?lang=ko`를 추가하세요. API와 MCP 페이로드는 번역하지 않습니다.

## MCP 서버 명령

저장소 루트에서 다음 stdio 명령을 사용하세요.

```bash
node /path/to/artifacty/src/mcp-server.js
```

주요 환경 변수:

- `ARTIFACTY_HOME`: 모든 에이전트가 함께 사용하는 저장소 디렉터리입니다.
- `ARTIFACTY_URL`: 브라우저 URL을 재정의하는 선택 설정입니다. 설정하지 않으면 MCP가 `server.json`에서 마지막으로 실행한 서버 URL을 읽습니다.
- `ARTIFACTY_MCP_MODE`: 기본값은 `local`입니다. stdio MCP를 중앙 HTTP MCP 엔드포인트로 전달하려면 `bridge`를 사용합니다.
- `ARTIFACTY_MCP_URL`: 브리지 모드에서 사용하는 중앙 MCP 엔드포인트입니다. 예: `http://10.0.0.50:8787/mcp`.
- `ARTIFACTY_API_TOKEN`: 설정하면 HTTP API 경로에서 이 토큰을 요구합니다. `node src/cli.js token --raw`로 생성할 수 있습니다.
- `ARTIFACTY_SHARE_MODE`: localhost 외부 주소에 바인딩하기 전에 `lan` 또는 `team`으로 설정합니다.
- `ARTIFACTY_ALLOW_SECRETS`: 탐지된 비밀정보를 의도적으로 저장하는 경우에만 `true`로 설정합니다.

## 자동 설치

Artifacty는 지원하는 로컬 에이전트의 MCP 설정을 작성할 수 있습니다.

```bash
node src/cli.js install claude
node src/cli.js install codex
node src/cli.js install gemini
node src/cli.js install copilot
node src/cli.js install cursor
node src/cli.js install all
node src/cli.js check
```

사용하는 에이전트의 명령을 선택하거나 `install all`로 지원하는 모든 클라이언트를 설정하세요. 파일을 변경하지 않고 설정을 미리 보려면 `--dry-run`을 붙이세요.

서버 터미널에서 중앙 팀 서버를 시작하세요.

```bash
ARTIFACTY_BOOTSTRAP_TOKEN="$(node src/cli.js token --raw)"
node src/cli.js serve --foreground \
  --host 10.0.0.50 \
  --share-mode team \
  --api-token "$ARTIFACTY_BOOTSTRAP_TOKEN" \
  --mcp-http
```

서버 터미널은 실행 상태로 두세요. `http://10.0.0.50:8787/login`에서 첫 관리자 계정을 만들고 `/account`에서 개인 토큰을 발급하세요. 각 클라이언트 컴퓨터의 Artifacty 체크아웃 디렉터리에서 별도 터미널을 여세요. 아래 예시 값을 해당 사용자의 개인 토큰으로 바꾼 뒤 MCP 설정을 설치하세요.

```bash
ARTIFACTY_PERSONAL_TOKEN="paste-your-personal-token-here"
node src/cli.js install all \
  --mcp-url http://10.0.0.50:8787/mcp \
  --api-token "$ARTIFACTY_PERSONAL_TOKEN"
```

관리자는 `/admin/users`에서 사용자를 한 명씩 생성하거나 같은 페이지에서 CSV를 가져올 수 있습니다. 서버에서 CLI를 실행하면 같은 파일을 가져올 수 있습니다.

```csv
email,name,role,password,password_reset_required
user@example.com,User,user,,
admin2@example.com,Admin Two,admin,temporary-password,true
```

```bash
artifacty users import --file users.csv
```

행에 비밀번호가 없으면 Artifacty가 임시 비밀번호를 생성합니다. 이 비밀번호는 가져오기 결과에만 표시하며, 반드시 변경해야 합니다. 직접 지정한 비밀번호도 기본적으로 변경을 요구합니다. 직접 지정한 비밀번호에 한해 CSV의 `password_reset_required=false`로 변경 요구를 해제할 수 있습니다. CLI의 `--no-password-reset`은 이 CSV 설정이 없는 행의 기본값을 바꿉니다. 비밀번호 변경이 필요한 사용자는 변경을 마쳐야 `/account`를 열고 MCP/API 토큰을 발급할 수 있습니다.

- Claude: 프로젝트의 `.mcp.json`을 작성합니다. 부모 프로세스에 설정한 `MCP_TIMEOUT` 환경 변수가 시작 제한 시간을 정합니다. 기본값은 30초입니다. Artifacty는 `.mcp.json`에 서버별 `timeout` 필드를 추가하지 않습니다.
- Codex: `~/.codex/config.toml`의 `[mcp_servers.artifacty]`를 작성하거나 교체합니다. 다른 파일을 사용하려면 `--config`를 지정하세요. 생성된 블록은 느린 Windows 환경이나 첫 실행에 대비해 시작 제한 시간을 30초로 설정합니다.
- Gemini: 프로젝트의 `.gemini/settings.json`을 작성하고 제한 시간을 30초로 설정합니다.
- VS Code의 GitHub Copilot: VS Code의 `servers` 구조로 워크스페이스 `.vscode/mcp.json`을 작성합니다. 사용자 프로필의 `mcp.json`에 적용하려면 `--config`를 지정하세요.
- Cursor: Cursor의 `mcpServers` 구조로 프로젝트 `.cursor/mcp.json`을 작성합니다. 전역 Cursor 설정에는 `--config ~/.cursor/mcp.json`을 사용하세요.
- `--dry-run`은 파일을 쓰지 않고 생성된 설정을 반환합니다.
- `--mcp-url <url>`은 중앙 Artifacty에 연결하는 stdio 브리지 모드를 설치합니다. URL에 경로가 없으면 `/mcp`를 추가합니다.
- `--api-token <token>`으로 지정한 토큰은 브리지 모드용 MCP 환경 설정에 기록됩니다. 중앙 서버에서는 `/account`에서 발급한 개인 토큰을 권장합니다.
- `--url <url>`은 브라우저 링크만 재정의합니다. 이 옵션만으로 중앙 MCP 연결을 활성화하지는 않습니다.
- `--timeout <ms>`는 Codex의 `startup_timeout_sec`와 Gemini의 `timeout`을 조정합니다. Claude Code의 시작 제한 시간은 변경하지 않습니다. Claude Code의 제한 시간을 늘리려면 실행 전에 `MCP_TIMEOUT`을 설정하세요.
- `artifacty install all --config <path>`는 사용하지 마세요. MCP 클라이언트마다 설정 파일 구조가 달라서 공통 설정 경로 재정의를 허용하지 않습니다. 한 에이전트만 지정할 때 `artifacty install <agent> --config <path>`를 사용하세요.
- JSON 기반 설치기는 다른 서버 설정을 보존하고 `artifacty` 항목만 교체합니다. 기존 `mcpServers` 또는 `servers`가 JSON 객체가 아니면 파일을 다시 쓰지 않고 오류로 중단합니다.
- `check`는 로컬 MCP 서버를 시작하고 MCP 탐색 메서드로 필수 도구, 리소스, 프롬프트를 확인합니다.
- `doctor`는 MCP 탐색과 함께 런타임, 저장소, 서버, 서비스 진단을 수행합니다.

Codex 문제 해결:

- Codex가 `mcp_servers.artifacty.env` 또는 `artifacty.env` 키 중복을 보고하면 Artifacty를 업데이트한 뒤 Codex 설치기를 다시 실행하세요. 이전 설치기는 새 인라인 `env = { ... }` 값을 추가하면서 기존 `[mcp_servers.artifacty.env]` 하위 테이블을 남길 수 있었습니다.

```bash
npm install -g artifacty@latest
artifacty install codex \
  --mcp-url http://10.0.0.50:8787/mcp \
  --api-token "$ARTIFACTY_PERSONAL_TOKEN"
```

## 클라이언트 호환성 표

| 클라이언트 | 설정 구조 | 적용 범위 | 제한 시간 동작 | 다시 시작 필요 여부 | 참고 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `.mcp.json` `mcpServers` | 프로젝트 | 부모 프로세스의 `MCP_TIMEOUT`, 기본 30초 | Claude Code 다시 시작 | 서버별 시작 제한 시간 필드 없음 |
| Codex | TOML `[mcp_servers.artifacty]` | 사용자 또는 명시한 설정 파일 | `startup_timeout_sec = 30.0` | Codex 세션 다시 시작 | Windows 첫 실행에는 기본값 30초가 필요할 수 있음 |
| Gemini CLI | JSON `mcpServers` | 사용자 또는 프로젝트 | `timeout: 30000` | `/mcp` 다시 로드 또는 재시작 | 설치 옵션의 `trust` 값 보존 |
| VS Code의 GitHub Copilot | `.vscode/mcp.json` `servers` | 워크스페이스 또는 사용자 프로필 | 클라이언트에서 관리 | VS Code MCP 서버 다시 로드 | 주로 도구 호출을 검증함 |
| Cursor | `.cursor/mcp.json` `mcpServers` | 워크스페이스 또는 전역 | 클라이언트에서 관리 | Cursor MCP 다시 시작 또는 다시 로드 | 주로 도구 호출을 검증함 |

모든 클라이언트는 MCP 도구를 지원해야 합니다. 리소스와 프롬프트의 표시 방식은 클라이언트마다 다릅니다. Artifacty의 핵심 워크플로는 도구를 사용하므로, 클라이언트가 리소스나 프롬프트를 표시하지 않아도 동작합니다.

보호된 HTTP 경로에 사용할 토큰을 생성하세요.

```bash
node src/cli.js token
node src/cli.js serve --generate-token
npm start -- --generate-token
ARTIFACTY_API_TOKEN="$(node src/cli.js token --raw)" node src/cli.js serve --foreground
```

## Claude Code

로컬 stdio MCP 서버 수동 등록:

```bash
claude mcp add --transport stdio artifacty -- node /path/to/artifacty/src/mcp-server.js
```

프로젝트 범위의 `.mcp.json` 구조:

```json
{
  "mcpServers": {
    "artifacty": {
      "command": "node",
      "args": ["/path/to/artifacty/src/mcp-server.js"],
      "env": {
        "ARTIFACTY_HOME": "/absolute/path/to/artifacty-store"
      }
    }
  }
}
```

Claude 플러그인은 MCP 서버를 포함할 수 있습니다. 따라서 나중에 이 MCP 서버를 플러그인으로 묶을 수 있습니다. MVP에서는 Claude, Codex, Gemini, GitHub Copilot, Cursor 등 여러 MCP 클라이언트가 같은 인터페이스로 연동할 수 있도록 서버를 독립적으로 제공합니다.

Claude Code의 기본 MCP 시작 제한 시간은 30초입니다. 느린 환경에서 더 많은 시간이 필요하면 `MCP_TIMEOUT` 값을 늘려 실행하세요. 예를 들어 `MCP_TIMEOUT=45000 claude`를 사용할 수 있습니다. 시작 제한 시간을 설정하기 위해 `.mcp.json`에 `timeout` 필드를 추가하지 마세요. 이 필드는 도구 실행 제한 시간에 사용합니다.

## Codex

Codex 설정에 로컬 MCP 서버 항목을 추가하세요.

```toml
[mcp_servers.artifacty]
command = "node"
args = ["/path/to/artifacty/src/mcp-server.js"]
startup_timeout_sec = 30.0
env = { ARTIFACTY_HOME = "/absolute/path/to/artifacty-store" }
```

설정을 편집한 뒤 Codex 세션을 다시 시작하면 MCP 서버를 불러옵니다.

Codex는 MCP로 후속 작업용 아티팩트를 직접 게시할 수 있습니다. 콘텐츠가 이미 Markdown이면 `sourceAgent: "codex"`와 `artifactType`을 명시하는 방식을 권장합니다.

```json
{
  "title": "Implementation Handoff",
  "content": "# Handoff\n\n- Continue Phase 3.",
  "format": "markdown",
  "artifactType": "handoff",
  "sourceAgent": "codex",
  "tags": ["handoff"]
}
```

구조화된 후속 작업 페이로드에는 `artifacty_import`와 `agent: "codex"`를 사용하세요. Artifacty는 인수인계, 파일 번들, 변경 설명, 코드 리뷰, 검증 보고서를 공통 스키마로 변환합니다. 메타데이터에는 변경한 파일, 명령, 테스트, 진행을 막는 문제, 다음 단계를 보존합니다.

## Gemini CLI

`~/.gemini/settings.json` 또는 `.gemini/settings.json`에 서버를 추가하세요.

```json
{
  "mcpServers": {
    "artifacty": {
      "command": "node",
      "args": ["/path/to/artifacty/src/mcp-server.js"],
      "env": {
        "ARTIFACTY_HOME": "/absolute/path/to/artifacty-store"
      },
      "timeout": 30000,
      "trust": false
    }
  }
}
```

그런 다음 Gemini CLI에서 `/mcp`를 실행해 Artifacty 도구가 연결되었는지 확인하세요.

## MCP 도구

- `artifacty_create`: Artifacty 기본 형식으로 새 아티팩트를 생성합니다.
- `artifacty_publish`: 이전 버전과의 호환성을 위한 `artifacty_create`의 별칭입니다.
- `artifacty_import`: Claude, Codex, Gemini, GitHub Copilot, Cursor, Artifacty 또는 일반 아티팩트 페이로드를 Artifacty 형식으로 변환하고 저장합니다.
- `artifacty_list`: 검색어, 태그, 생성 에이전트로 아티팩트를 찾습니다.
- `artifacty_get`: 아티팩트 메타데이터와 콘텐츠를 읽습니다.
- `artifacty_update`: 새 버전을 추가합니다.
- `artifacty_archive`: 버전을 삭제하지 않고 아티팩트를 숨깁니다.
- `artifacty_restore`: 아카이브 상태를 해제합니다.
- `artifacty_audit`: 최근 감사 이벤트를 나열합니다.
- `artifacty_info`: 로컬 서버와 저장소 설정을 확인합니다.

데이터를 변경하는 MCP 도구는 저장 전에 일반적인 API 키와 개인키 패턴을 검사합니다. 의도적으로 예외를 허용하는 경우에만 `allowSecrets: true`를 전달하세요.

## MCP 리소스와 프롬프트

Artifacty는 읽기 전용 MCP 리소스도 제공합니다.

- `artifacty://recent`: 페이지네이션과 브라우저 URL을 포함한 최근 아티팩트 목록입니다.
- `artifacty://schema/v1`: 아티팩트 스키마 v1의 Markdown 문서입니다.
- `artifacty://artifacts/{id}`: 메타데이터, 콘텐츠, URL을 포함한 아티팩트 JSON입니다.
- `artifacty://artifacts/{id}/raw{?version}`: 최신 버전 또는 지정한 버전의 원본 콘텐츠입니다.

프롬프트 템플릿:

- `artifacty_handoff`: 후속 작업을 위한 인수인계입니다.
- `artifacty_review`: 발견 사항을 먼저 제시하는 코드 리뷰 아티팩트입니다.
- `artifacty_test_report`: 검증 근거입니다.
- `artifacty_visual_qa`: 스크린샷, 미디어, 브라우저 검증 근거입니다.
- `artifacty_release_notes`: 게시 근거와 위험을 포함한 릴리스 노트입니다.

공개 MCP 인터페이스는 [MCP 공개 API](mcp-public-api.md)를 참고하세요.

## 에이전트 아티팩트 가져오기

다른 에이전트가 생성한 아티팩트를 공유하기 전에 공통 형식으로 정리해야 한다면 `artifacty_import` 또는 CLI `import` 명령을 사용하세요.

```bash
node src/cli.js import --agent claude --file ./artifact.html --tag review
node src/cli.js import --agent codex --file ./handoff.md --tag handoff
node src/cli.js import --agent codex --content '{"agent":"codex","title":"Verification","verification":{"status":"passed","commands":[{"command":"npm test","status":"passed"}]}}'
node src/cli.js import --agent copilot --content '{"agent":"github-copilot","title":"PR Review","findings":[{"severity":"medium","file":"src/app.js","line":42,"title":"Handle missing state"}]}'
node src/cli.js import --agent cursor --content '{"sourceAgent":"cursor","title":"Cursor Handoff","summary":"Editor pass complete.","nextSteps":["Run visual QA."]}'
node src/cli.js import --agent cursor --file ./browser-screenshot.png --tag visual
node src/cli.js import --agent cursor --file ./demo.webm --tag demo
node src/cli.js import --agent gemini --content '{"title":"Options","returnDisplay":"# Options\n- A\n- B"}'
```

변환기가 지원하는 입력:

- Claude: 로컬 `.html`, `.htm`, `.md`, `.svg`, `.mmd`, `.jsx`, `.tsx`, 소스 파일 또는 `title`/`content`/Claude 아티팩트 `type`을 포함한 JSON 페이로드입니다.
- Codex: Markdown·텍스트·JSON 인수인계 파일, Artifacty 호환 JSON 페이로드, `agent` 또는 `sourceAgent`가 `codex`인 구조화된 인수인계·번들·변경 설명·리뷰·검증 JSON 페이로드입니다.
- GitHub Copilot: Markdown·텍스트·JSON 출력, Artifacty 호환 JSON 페이로드, `agent` 또는 `sourceAgent`가 `github-copilot` 또는 `copilot`인 구조화된 인수인계·리뷰·변경 설명·검증 JSON 페이로드입니다.
- Cursor: Markdown·텍스트·JSON 출력, Artifacty 호환 JSON 페이로드, `agent` 또는 `sourceAgent`가 `cursor`인 구조화된 인수인계·리뷰·변경 설명·검증·스크린샷·데모/동영상·시각 자료를 모은 검증 번들 JSON 페이로드입니다.
- Gemini: `returnDisplay`, `llmContent`, 텍스트 블록 또는 로컬 Markdown·텍스트·JSON 파일입니다.
- 일반 입력: 파일 확장자, 콘텐츠 유형, HTML doctype과 조각, JSON 구조, 미디어 data URL, Markdown 제목을 이용해 형식과 제목을 추론합니다. 일반 `text/plain` 업로드라도 파일명이나 내용으로 형식이 분명하면 `html` 같은 구체적인 형식으로 처리합니다.

변환기는 생성 에이전트의 별칭을 정규화합니다. 예를 들어 `claude-code`와 `Claude Code`는 `claude`로 저장합니다. `imported` 태그와 생성 에이전트 태그를 추가합니다. 원본 콘텐츠는 변경 불가능한 Artifacty 버전으로 보존하고, 출처 정보는 `metadata.artifactyImport`에 기록합니다.

`test/fixtures/`에는 Copilot과 Cursor의 PR 리뷰, 스크린샷, 데모 녹화, 시각 자료를 모은 검증 번들 예제가 있습니다. 변환기 테스트에서 이 예제를 검증합니다.

## HTTP API

- `GET /`: 대시보드입니다.
- `GET /new`: 브라우저 아티팩트 편집기입니다.
- `POST /new`: 브라우저 편집기에서 아티팩트를 생성하고 해당 아티팩트로 이동합니다.
- `GET /import`: 브라우저 아티팩트 가져오기 폼입니다.
- `POST /import`: 붙여넣은 에이전트 출력을 변환하고 저장합니다.
- `GET /health`: 상태 확인입니다.
- `POST /mcp`: `--mcp-http` 또는 `ARTIFACTY_MCP_HTTP=true`가 활성화되면 제공하는, 토큰으로 보호된 MCP Streamable HTTP JSON-RPC 엔드포인트입니다.
- `GET /api/artifacts`: 아티팩트를 나열합니다.
- `POST /api/artifacts`: 아티팩트를 생성합니다.
- `POST /api/import`: 에이전트가 생성한 아티팩트를 변환하고 저장합니다.
- `GET /api/artifacts/:id`: 메타데이터와 콘텐츠를 읽습니다.
- `POST /api/artifacts/:id`: 버전을 추가합니다.
- `POST /api/artifacts/:id/archive`: 버전을 삭제하지 않고 아카이브합니다.
- `POST /api/artifacts/:id/restore`: 아카이브한 아티팩트를 복원합니다.
- `GET /api/audit`: 최근 감사 이벤트를 나열합니다. `artifactId`로 필터링할 수 있습니다.
- `GET /artifacts/:id`: 브라우저 뷰어입니다.
- `GET /artifacts/:id/react-frame?version=n`: 설정으로 활성화하는 React 렌더러 프레임입니다. `ARTIFACTY_ENABLE_REACT_RENDERER=true`일 때만 콘텐츠를 반환합니다.
- `GET /artifacts/:id/edit`: 브라우저 버전 편집기입니다.
- `POST /artifacts/:id/edit`: 브라우저 편집기에서 버전을 추가합니다. 내용이 바뀌지 않은 편집은 새 버전을 만들지 않고 `update-noop`만 기록합니다.
- `POST /artifacts/:id/archive`: 브라우저에서 아카이브합니다.
- `POST /artifacts/:id/restore`: 브라우저에서 복원합니다.
- `GET /artifacts/:id/diff`: 두 버전을 비교합니다.
- `GET /artifacts/:id/raw?version=n`: 원본 콘텐츠입니다.
- `GET /admin/artifacts/:id/versions`: 관리자 전용 버전 복구·삭제 화면입니다.
- `POST /admin/artifacts/:id/versions/:version/repair`: 관리자가 한 버전의 콘텐츠와 형식을 교체합니다.
- `POST /admin/artifacts/:id/versions/:version/delete`: 관리자가 한 버전을 삭제합니다. 마지막 남은 버전은 삭제할 수 없습니다.

`ARTIFACTY_API_TOKEN`이 설정되어 있으면 `/api/*` 경로는 `Authorization: Bearer <token>` 또는 `x-artifacty-token: <token>`을 요구합니다. 사용자가 있는 저장소에서는 `/account`의 개인 토큰으로도 API와 MCP 요청을 인증할 수 있습니다. 새 아티팩트의 `publisherId`에는 토큰 소유자의 이메일을 기록합니다. 감사 항목의 `actor`에도 같은 식별 정보를 사용합니다. 브라우저 폼은 URL의 `?token=<token>`도 받을 수 있습니다. Artifacty는 로컬 팀 작업을 위해 이 토큰을 숨겨진 폼 필드에 복사합니다.

렌더러 참고 사항:

- `code` 아티팩트는 읽기 전용 CodeMirror 뷰어를 사용합니다. 뷰어를 사용할 수 없으면 이스케이프한 소스를 표시합니다.
- `svg` 아티팩트는 뷰어에서 안전하게 정제한 뒤 스크립트가 없는 샌드박스 iframe에 표시합니다. `/raw`는 원본 SVG를 그대로 반환합니다.
- `mermaid` 아티팩트는 `allow-same-origin`이 없는 샌드박스 iframe에서 `/vendor/npm/mermaid/...`의 로컬 Mermaid 번들을 불러옵니다. JavaScript 자산 경로는 iframe의 `Origin: null` 모듈 요청에 `Access-Control-Allow-Origin: null`로 응답합니다.
- `react` 아티팩트는 `ARTIFACTY_ENABLE_REACT_RENDERER=true`를 설정하지 않으면 소스만 표시합니다. 활성화하면 JSX 변환과 React 실행은 `/artifacts/:id/react-frame`에서만 수행합니다. `unsafe-eval`은 해당 프레임의 CSP에만 적용합니다.
- `sarif` 아티팩트는 크기가 제한된 발견 사항 요약을 표시합니다. 전체 JSON은 형식을 정리한 상태로 브라우저 뷰어와 `/raw`에서 확인할 수 있습니다.
- `csv` 아티팩트는 행과 열 수를 제한한 이스케이프 표로 표시합니다. `/raw`는 원본 CSV 텍스트를 보존합니다.
- `image`와 `video` 아티팩트는 base64 콘텐츠를 인라인으로 저장합니다. 브라우저 기본 미디어 요소로 표시하며, `/raw`에서 바이트로 디코딩합니다.

## 백그라운드 서비스

운영체제별 서비스 정의를 생성하세요.

```bash
node src/cli.js service plist --dry-run
node src/cli.js service unit --dry-run
node src/cli.js service task --dry-run
```

현재 운영체제용 정의를 설치하세요.

```bash
node src/cli.js service install --dry-run
node src/cli.js service install
node src/cli.js service uninstall --dry-run
```

다른 호스트용 정의를 준비할 때는 `--platform macos|linux|windows`를 사용하세요. 출력 경로는 `--path`로 지정할 수 있습니다. 운영체제별 별칭인 `--plist`, `--unit`, `--script`도 사용할 수 있습니다.

생성된 서비스는 `--host`와 `--home`을 명시해 `src/server.js`를 실행합니다. 포트를 설정하면 `--port`도 포함합니다. 포트를 지정하지 않으면 기본 포트가 사용 중일 때 다른 포트를 선택하는 동작을 유지합니다. `--api-token`, `--share-mode`, `--allow-secrets`를 지정하면 생성된 정의에도 해당 값을 보존합니다.

서비스 활성화는 운영체제의 서비스 관리자가 담당합니다.

- macOS: `launchctl load ~/Library/LaunchAgents/com.artifacty.server.plist`
- Linux: 먼저 `sudo loginctl enable-linger $USER`를 실행한 뒤 `systemctl --user enable --now com.artifacty.server.service`를 실행합니다.
- Windows: 생성된 PowerShell 스크립트를 실행합니다. 이 스크립트가 `ArtifactyServer` 예약 작업을 등록하고 시작합니다.

Linux 중앙 서버에서는 linger를 활성화하지 않으면 사용자의 systemd 관리자가 종료될 때 사용자 서비스도 중지됩니다. `loginctl show-user $USER -p Linger`로 설정을 확인하세요. 결과가 `Linger=yes`여야 합니다. linger가 없으면 로그아웃 후 Artifacty가 중지되고, 사용자가 다시 로그인해야 사용할 수 있게 될 수 있습니다.

백그라운드 서비스에는 고정된 `ARTIFACTY_API_TOKEN` 또는 `--api-token` 값을 권장합니다. `serve --generate-token`은 임시 대화형 세션에 적합합니다. 부모 CLI는 생성한 토큰을 JSON으로 반환합니다.

## 백업과 감사

관리자는 `/admin/backup`에서 아티팩트 백업 JSON 파일을 내려받거나 현재 서버에 백업을 복원할 수 있습니다. 소규모·중규모 저장소를 이전할 때는 브라우저에서 복원할 수 있습니다. 큰 번들을 복원할 때는 CLI를 사용하세요.

```bash
node src/cli.js audit --limit 20
node src/cli.js backup
node src/cli.js export --file ./artifacty-backup.json
node src/cli.js import-store --file ./artifacty-backup.json
```

기본 백업은 아티팩트 메타데이터와 변경 불가능한 버전 콘텐츠를 하나의 JSON 번들에 담습니다. 사용자, 세션, API 토큰 기록, 감사 로그, 댓글, 관계, 공유 권한은 제외합니다. 저장소 가져오기는 대상 아티팩트 기록을 교체하고 참조하지 않는 버전 파일을 제거합니다. 가져오기 전에 `ARTIFACTY_HOME`을 새 저장소나 교체하려는 대상 저장소의 경로로 설정하세요. 대상에 댓글, 관계, 공유 권한이 있으면 `--confirm replace-all` 없이는 아티팩트 전용 백업을 가져올 수 없습니다. 이 확인 옵션은 해당 기록의 삭제를 허용합니다. 기본 백업으로는 삭제된 기록을 복원할 수 없습니다.

더 많은 데이터를 함께 이전하려면 `--full`로 내보내고 `--confirm replace-all`로 가져오세요. 대상에 사용자가 이미 있으면 사용자를 교체하기 위한 `--force-users`도 필요합니다. 복원 전에 [백업 범위와 제외 항목](../../README.ko.md#저장소)을 확인하세요.

업그레이드 스냅샷은 스키마 마이그레이션을 보호하며, 선택적으로 애플리케이션 업데이트도 보호합니다. JSON 내보내기 백업과 달리 데이터베이스의 보안 상태를 원본 형태로 보존합니다. 복구 전에 모든 서버와 MCP 프로세스를 중지하세요. 자세한 내용은 [업그레이드 스냅샷과 복구](upgrade-backups.md)를 참고하세요.
