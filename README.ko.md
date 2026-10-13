# Artifacty

[English](README.md) | 한국어

[한국어 문서 안내](docs/ko/README.md) · [English documentation](docs/README.md)

<!-- 번역 기준: 영문 README.md, commit 9e73a9f -->

[![Publish](https://github.com/raeseoklee/artifacty/actions/workflows/publish.yml/badge.svg)](https://github.com/raeseoklee/artifacty/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/artifacty.svg)](https://www.npmjs.com/package/artifacty)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >=22.12.0](https://img.shields.io/badge/node-%3E%3D22.12.0-339933.svg)](package.json)

Artifacty는 AI가 만든 아티팩트를 로컬에 보관하고 에이전트끼리 공유할 수 있는 저장소입니다. Claude, Codex, Gemini, GitHub Copilot, Cursor 등 MCP 도구가 같은 저장소에 아티팩트를 게시할 수 있습니다. 다른 에이전트는 채팅에 내용을 복사하지 않고도 결과물을 찾아 읽고 수정할 수 있습니다.

![여러 AI 에이전트가 로컬 저장소를 통해 아티팩트를 공유하는 Artifacty 개요](docs/assets/artifacty.png)

## MCP를 사용하는 이유

아티팩트는 세션의 결과물을 공유와 버전 관리가 가능한 페이지로 만듭니다. Artifacty는 이 페이지를 로컬에 보관하고 여러 에이전트가 함께 사용하도록 합니다. 브라우저 서버는 사람이 볼 화면을 렌더링하고, MCP stdio 서버는 에이전트에 공통 도구 인터페이스를 제공합니다.

## 설치

Node.js 22.12.0 이상이 필요합니다.

선택 기능인 React 렌더러는 Babel 8을 사용합니다. 지원하는 Node.js 버전은 `^22.18.0 || >=24.11.0`입니다. 이 렌더러를 활성화한다면 호환되는 버전을 사용하세요.

브라우저 렌더러는 Mermaid 12.1.0을 사용합니다. Safari 17.4 이상처럼 ES2024를 지원하는 최신 브라우저를 사용하세요. Mermaid의 `classic` 스타일, `dagre` 레이아웃, `default` 테마는 그대로 유지됩니다.

npm에서 CLI를 전역 설치하세요.

```bash
npm install -g artifacty
artifacty --help
```


전역 설치 없이 실행할 수도 있습니다.

```bash
npx artifacty@latest serve --foreground
```


로컬 대시보드를 백그라운드에서 시작하세요.

```bash
artifacty serve
```


JSON 응답의 `url`을 여세요. Artifacty는 먼저 `http://127.0.0.1:8787`을 사용합니다. 이 포트가 사용 중이고 별도 포트를 지정하지 않았다면 다음 사용 가능한 로컬 포트로 실행합니다. CLI와 MCP 응답에 사용할 실제 URL도 기록합니다.

백그라운드 서버는 다음 명령으로 관리합니다.

```bash
artifacty status
artifacty stop
```


`artifacty start`와 `artifacty serve --detach`는 `artifacty serve`와 같은 방식으로 서버를 관리합니다. 로그는 `~/.artifacty/logs/`에 기록합니다.
이 명령들은 macOS, Linux, Windows에서 Node의 분리 프로세스 기능을 사용합니다. `artifacty stop`은 macOS와 Linux에서 프로세스 그룹에 신호를 보냅니다. Windows에서는 `taskkill`을 사용하며, 강제 종료가 필요하면 `/F` 옵션으로 다시 시도합니다.

터미널에서 로그를 보며 디버깅하려면 포그라운드로 실행하세요.

```bash
artifacty serve --foreground
npm start
```


HTTP API와 브라우저 쓰기 경로를 보호하려면 시작할 때 API 토큰을 생성하세요.

```bash
artifacty serve --generate-token
artifacty serve --host 0.0.0.0 --share-mode lan --generate-token
artifacty serve --foreground --generate-token
```


백그라운드 `serve`는 생성된 토큰과 바로 열 수 있는 `/new?token=...`, `/import?token=...` URL을 JSON으로 반환합니다. 포그라운드 `serve`는 같은 값을 stderr에 출력합니다. 스크립트나 장시간 실행하는 서비스에 고정 토큰이 필요하면 먼저 생성하세요.

```bash
artifacty token
artifacty start --api-token "$(artifacty token --raw)"
```


로컬 에이전트의 MCP 설정을 설치하세요.

```bash
artifacty install claude
artifacty install codex --dry-run
artifacty install gemini
artifacty install copilot
artifacty install cursor
artifacty install all
artifacty check
```


내부 중앙 서버를 사용한다면 서버에서 HTTP MCP 엔드포인트를 활성화하세요. 사용자는 계정 페이지에서 개인 MCP/API 토큰을 발급할 수 있습니다.

```bash
ARTIFACTY_BOOTSTRAP_TOKEN="$(artifacty token --raw)"
artifacty serve --host 10.0.0.50 --share-mode team --api-token "$ARTIFACTY_BOOTSTRAP_TOKEN" --mcp-http --foreground
# Open http://10.0.0.50:8787/login, create the first admin, then create a personal token at /account.
artifacty install all --mcp-url http://10.0.0.50:8787/mcp --api-token "$ARTIFACTY_PERSONAL_TOKEN"
```


중앙 서버를 Linux의 `systemctl --user` 서비스로 실행한다면 서비스 계정의 lingering을 활성화하세요. 로그아웃한 뒤에도 Artifacty가 계속 실행됩니다.
`sudo loginctl enable-linger $USER`

관리자는 `/admin/users`에서 사용자를 개별 생성하거나 CSV로 가져올 수 있습니다. 헤더는 `email,name,role,password,password_reset_required`를 사용합니다. `password`가 비어 있으면 임시 비밀번호를 생성해 가져오기 결과에 한 번만 표시합니다. 사용자는 처음 로그인할 때 비밀번호를 변경해야 합니다.

```csv
email,name,role
user@example.com,User,user
admin2@example.com,Admin Two,admin
```


```bash
artifacty users import --file users.csv
```


로컬 런타임, 저장소, 서버, 서비스 정의, MCP 검색 기능을 진단하세요.

```bash
artifacty doctor
artifacty doctor --skip-mcp
```


`artifacty install codex --timeout 30000` 또는 `artifacty install gemini --timeout 30000`으로 해당 MCP 클라이언트의 시간 제한을 조정할 수 있습니다.

Claude Code, Codex, Gemini CLI, VS Code의 GitHub Copilot, Cursor 설정은 [에이전트 연동 가이드](docs/ko/integrations.md)를 참고하세요.

## 빠른 시작

브라우저에서 아티팩트를 만드세요.

```text
http://127.0.0.1:8787/new
```


저장소를 체크아웃해 로컬에서 개발한다면 다음을 실행하세요.

```bash
npm install
npm test
npm start
```


릴리스 준비 상태를 검사하세요.

```bash
npm run release:check
```


CLI에서 게시하세요.

```bash
artifacty publish --title "handoff note" --format markdown --source codex --content "# Next step\nReview the API plan."
```


다른 에이전트가 만든 아티팩트를 가져와 Artifacty 형식으로 변환하세요.

```bash
artifacty import --agent claude --file ./deploy-failures.html --tag review
artifacty import --agent gemini --content '{"title":"Plan","returnDisplay":"# Plan\n- Ship it"}'
artifacty import --agent codex --content '{"agent":"codex","title":"Implementation Handoff","goal":"Continue Phase 3","changedFiles":[{"path":"src/lib/render.js","status":"modified"}],"nextSteps":["Add CodeMirror read-only viewer"]}'
artifacty import --agent copilot --content '{"agent":"github-copilot","title":"PR Review","findings":[{"severity":"medium","file":"src/app.js","line":42,"title":"Handle missing state"}]}'
artifacty import --agent cursor --content '{"sourceAgent":"cursor","title":"Cursor Handoff","summary":"Editor pass complete.","nextSteps":["Run visual QA."]}'
```


Codex, GitHub Copilot, Cursor의 구조화된 payload가 `agent` 또는 `sourceAgent`로 에이전트를 명시하면 `handoff`, `bundle`, `diff-walkthrough`, `code-review`, `test-report` 아티팩트로 변환할 수 있습니다. 이 에이전트들이 만든 일반 Markdown은 `artifactType`을 명시하지 않으면 일반 `document`로 유지됩니다.

`format`을 생략하면 파일명, 콘텐츠 유형, 내용을 기준으로 형식을 추론합니다. HTML 파일이나 `<section>...</section>` 같은 HTML 조각은 `html`로 저장하므로 브라우저에서 일반 텍스트가 아닌 HTML로 렌더링됩니다.

## 에이전트 인수인계 예시

한 에이전트가 인수인계 아티팩트를 게시합니다. 다른 에이전트는 이를 찾아 맥락을 읽고 다음 버전을 추가합니다.

Codex가 인수인계 자료를 게시합니다.

```bash
artifacty import --agent codex --tag handoff --content '{
  "agent": "codex",
  "title": "Release Handoff",
  "goal": "Prepare Artifacty for an npm release",
  "changedFiles": [
    { "path": "src/lib/converters.js", "status": "modified", "summary": "Normalize agent outputs" }
  ],
  "commands": [
    { "command": "npm run release:check", "status": "passed" }
  ],
  "nextSteps": [
    "Review README",
    "Publish package"
  ]
}'
```


Claude나 Gemini가 자료를 찾아 같은 아티팩트에서 작업을 이어갑니다.

```bash
artifacty list --tag handoff
artifacty show release-handoff-abc12345 --raw
artifacty update release-handoff-abc12345 \
  --format markdown \
  --source claude \
  --tag handoff \
  --content "# Release Handoff\n\nReviewed README and prepared publish notes."
```


아티팩트 목록을 조회하세요.

```bash
artifacty list
artifacty list --query review --limit 20 --offset 20
```


MCP 서버를 실행하세요.

```bash
artifacty-mcp
ARTIFACTY_MCP_MODE=bridge ARTIFACTY_MCP_URL=http://10.0.0.50:8787/mcp ARTIFACTY_API_TOKEN=... artifacty-mcp
```


MCP 클라이언트는 `artifacty_create`로 아티팩트를 만들 수 있습니다. `artifacty_publish`는 하위 호환용 별칭으로 유지됩니다.
리소스나 프롬프트를 지원하는 클라이언트는 `artifacty://recent`, `artifacty://artifacts/{id}`, `artifacty://artifacts/{id}/raw{?version}`, `artifacty://schema/v1`도 읽을 수 있습니다. `artifacty_handoff`, `artifacty_review`, `artifacty_release_notes` 같은 프롬프트 템플릿도 사용할 수 있습니다.

운영에 사용하는 명령은 다음과 같습니다.

```bash
artifacty audit --limit 20
artifacty doctor
artifacty index rebuild
artifacty integrity
artifacty backup
artifacty backup --full
artifacty export --file ./artifacty-backup.json
artifacty export --file ./artifacty-backup-full.json --full
artifacty import-store --file ./artifacty-backup.json
artifacty import-store --file ./artifacty-backup-full.json --confirm replace-all [--force-users]
artifacty start
artifacty status
artifacty stop
artifacty service install --dry-run
artifacty service unit --dry-run
artifacty service task --dry-run
```


전역 설치 없이 소스 저장소에서 작업한다면 `artifacty` 대신 `node src/cli.js`, `artifacty-mcp` 대신 `node src/mcp-server.js`를 사용하세요.

## 저장소

기본 저장 위치는 `~/.artifacty`입니다.

```bash
ARTIFACTY_HOME=/path/to/shared/store artifacty serve
```


메타데이터는 `artifacty.sqlite`에 저장합니다. 일반적인 생성·수정 작업은 `artifacts/` 아래에 버전 파일을 추가합니다. 관리자는 브라우저에서 개별 버전을 복구하거나 삭제할 수 있으며, 이런 예외 작업은 감사 로그에 기록합니다.

현재 브라우저 서버 URL은 `server.json`에 기록합니다. 서버가 다른 포트를 선택하더라도 MCP 도구는 이 URL을 사용해 올바른 링크를 반환합니다. 기존 `index.json` 저장소는 처음 접근할 때 자동으로 마이그레이션합니다.

모든 아티팩트 레코드에는 `visibility`(`private`/`team`, 기본값 `team`)와 `ownerUserId`가 있습니다. 마이그레이션할 때는 `publisherUserId`로 소유자 정보를 채웁니다. 적용되는 접근 규칙은 아래 보안 모델 절을 참고하세요.

관리자는 `/admin/backup`에서 백업을 내려받거나 복원할 수 있습니다. 기본 `artifacts` 범위에는 아티팩트 메타데이터와 버전 내용이 들어가며, 사용자·세션·API 토큰 레코드·감사 로그는 포함하지 않습니다. 이 범위의 번들을 복원하면 대상 서버의 아티팩트 레코드를 교체하고 참조되지 않는 버전 파일을 정리합니다. 사용자, 토큰, 감사 이력은 그대로 둡니다.

`full` 범위 백업은 사용자와 비밀번호 해시, API 토큰 해시(원문 토큰 제외), 감사 로그, 아티팩트 관계, Webhook도 포함합니다. `artifacty backup --full`, 다운로드의 `?scope=full`, 또는 `/admin/backup`의 범위 선택기로 지정합니다. Webhook 비밀키는 내보내지 않습니다. 복원된 Webhook은 비활성 상태이며 비밀키를 다시 발급해야 합니다. 세션도 내보내지 않습니다.

`full` 번들을 복원하려면 명시적으로 확인해야 합니다. API에서는 `confirm: "replace-all"`, CLI에서는 `--confirm replace-all`, 브라우저에서는 확인 체크박스를 사용합니다. 대상 저장소에 사용자가 이미 있으면 `forceUsers`/`--force-users`도 지정해야 합니다. 의도치 않게 기존 계정을 병합하거나 덮어쓰는 일을 막기 위한 조건입니다. 이 기능 이전에 만든 번들(`bundleVersion`/`scope` 헤더 없음)도 복원할 수 있으며, 항상 아티팩트 전용으로 처리합니다. 대규모 마이그레이션이나 스크립트 기반 서버 이전에는 `artifacty backup --full`과 `artifacty import-store --file ./artifacty-backup.json --confirm replace-all`을 사용하세요.

로컬 Node SQLite 빌드가 FTS5를 지원하면 검색에 SQLite FTS5 인덱스를 사용합니다. 최신 버전 본문, 제목, 태그, 생성 에이전트, 아티팩트 유형, 형식, 메타데이터 요약을 검색합니다. FTS5가 없으면 메타데이터 검색을 사용합니다. 저장소를 재색인하거나 검사하려면 다음을 실행하세요.

```bash
artifacty index rebuild
artifacty integrity
```


### 업그레이드 스냅샷

기존 저장소의 스키마를 마이그레이션하기 전에 필수 로컬 스냅샷을 생성하고 검증합니다. 원본 SQLite 데이터베이스, 참조된 버전 파일, 레거시 인덱스를 포함합니다. 스냅샷 검증이 실패하면 마이그레이션을 중단합니다.

애플리케이션 버전이 바뀔 때도 스냅샷을 만들려면 `ARTIFACTY_BACKUP_ON_UPDATE=true`를 설정하세요. 기존 저장소에 애플리케이션 버전 기록이 없다면 이 설정으로 처음 열 때 기준 스냅샷을 만듭니다. `ARTIFACTY_UPGRADE_BACKUP_KEEP`는 기본적으로 최근 자동 스냅샷 3개를 보관하며, 1–1000을 지정할 수 있습니다.

`artifacty backups list`, `artifacty backups verify <id>`, `artifacty backups restore <id> --confirm restore-store`를 사용하세요. 업그레이드나 복원 전에 모든 서버와 MCP 프로세스를 중지해야 합니다. 복원은 저장소를 교체하기 전에 현재 상태의 복구 스냅샷을 만듭니다. 자격 증명과 보안 상태도 되돌리므로, 이전에 폐기한 세션·토큰·링크가 다시 유효해질 수 있습니다.

이 로컬 스냅샷은 이동용 `artifacty backup`/`export` JSON 번들과 다릅니다. 검증, 손상된 저장소 복구, 중단된 복원 처리 방법은 [업그레이드 스냅샷과 복구](docs/ko/upgrade-backups.md)를 참고하세요.

### 의미 검색

`GET /api/artifacts`의 `?mode=keyword|semantic|hybrid`, 대시보드, `artifacty list --mode`, MCP의 `artifacty_list`에서 FTS5에 더해 자연어 검색을 선택적으로 사용할 수 있습니다. 모델을 번들로 제공하거나 필수 의존성을 추가하지 않습니다.

- `keyword`는 기존 FTS5/메타데이터 검색을 사용합니다.
- `semantic`은 질의를 임베딩하고 저장된 벡터와의 코사인 유사도로 순위를 정합니다.
- `hybrid`는 reciprocal rank fusion으로 키워드와 의미 검색 순위를 결합합니다. 제공자를 설정하고 `q`/`query`를 지정하면 기본으로 사용합니다.

임베딩 제공자를 설정하지 않으면 `semantic`/`hybrid` 요청은 `keyword`로 대체하고 응답의 `search.fallback`을 `true`로 표시합니다. 환경 변수로 제공자 하나를 설정하세요.

```bash
# openai-compatible: POSTs { model, input } to <url>/embeddings
export ARTIFACTY_EMBEDDINGS_URL=https://api.openai.com/v1
export ARTIFACTY_EMBEDDINGS_MODEL=text-embedding-3-small
export ARTIFACTY_EMBEDDINGS_API_KEY=sk-...

# or: command, a local executable reading/writing JSON lines on stdin/stdout
# (wire in Ollama or any local model without an Artifacty dependency)
export ARTIFACTY_EMBEDDINGS_COMMAND="python3 embed.py"
```


API 키는 환경 변수에서만 읽습니다. 로그, 오류 응답, 저장소에 남기지 않습니다. `artifacty doctor`는 키를 가린 상태로 제공자와 모델을 표시합니다. 생성·수정 후에는 백그라운드에서 임베딩을 생성합니다. 기존 아티팩트의 임베딩을 16개씩 생성하거나 갱신하려면 다음을 실행하세요.

```bash
artifacty index rebuild --embeddings
```


### 관계

유형과 방향이 있는 관계로 인수인계 자료, 리뷰, 후속 작업을 연결하세요.

- v1에서 지원하는 관계 이름은 `derived-from`, `supersedes`, `reviews`, `references`, `part-of`입니다.
- 각 관계의 역방향 관계를 계산해 상대 아티팩트에 자동 표시합니다. 대응은 `derived-from` ↔ `derives`, `supersedes` ↔ `superseded-by`, `reviews` ↔ `reviewed-by`, `references` ↔ `referenced-by`, `part-of` ↔ `contains`입니다.
- HTTP에서는 `POST`/`GET`/`DELETE /api/artifacts/:id/relations`로 연결을 관리합니다. `GET /api/artifacts`는 `relatedTo`, `relation` 필터를 지원합니다.
- `artifacty_create`와 `artifacty_update`는 `relations` 배열을 받아 게시와 동시에 관계를 만들 수 있습니다. `artifacty_get` 응답에는 `relations: { outgoing, incoming }`이 들어갑니다.
- 대상이 삭제된 관계도 버리지 않고 `missing: true`로 표시합니다.

```bash
artifacty link <from-id> derived-from <to-id>
artifacty relations <artifact-id>
artifacty show <artifact-id> --relations
artifacty unlink <from-id> derived-from <to-id>
```


### 댓글과 리뷰 상태

새 버전이나 별도 리뷰 아티팩트를 만들지 않고 특정 버전에 피드백을 남길 수 있습니다.

- 댓글은 아티팩트와 같은 안전한 Markdown 렌더러를 사용하며, 댓글당 최대 16 KB입니다. 선택 사항인 `anchor`는 표시 위치의 힌트입니다. 텍스트에는 `{ line: 42 }`, JSON/SARIF에는 `{ path: "$.runs[0].results[3]" }`, CSV에는 `{ row: 7 }`을 사용할 수 있습니다. 힌트가 실제 내용과 일치하는지는 검증하지 않습니다.
- 답글은 한 단계까지만 지원합니다. 새 댓글의 `parentId`는 자신의 `parentId`가 없는 최상위 댓글을 가리켜야 합니다.
- 댓글 삭제는 소프트 삭제입니다. `artifacty comments`/`GET .../comments`에서는 사라지지만 감사 로그는 남습니다. 삭제된 댓글도 보려면 `--include-deleted`/`includeDeleted=true`를 지정하세요.
- 각 아티팩트의 `reviewStatus`는 `none`, `pending`, `changes-requested`, `approved` 중 하나입니다. 상태는 명시적으로 설정합니다. 승인된 아티팩트에 버전을 추가하면 자동으로 `pending`으로 돌아가며, 해당 수정의 감사 메타데이터에 기록합니다.
- HTTP에서는 `GET`/`POST /api/artifacts/:id/comments`, `POST /api/artifacts/:id/comments/:commentId/resolve`, `DELETE /api/artifacts/:id/comments/:commentId`, `POST /api/artifacts/:id/review-status`로 댓글과 리뷰 상태를 관리합니다.
- 대응하는 MCP 도구는 `artifacty_comment`, `artifacty_resolve_comment`, `artifacty_set_review_status`입니다. `artifacty_get`에 `includeComments: true`를 지정하면 요청한 버전의 미해결 댓글도 함께 반환합니다.
- 브라우저 아티팩트 페이지는 댓글을 버전별로 묶어 보여줍니다. 답글 폼, 해결 버튼, 소유자·관리자용 리뷰 상태 선택기를 제공합니다. 줄에 연결된 댓글은 CodeMirror 여백 표시 대신 “line 42” 같은 텍스트로 나타납니다.

```bash
artifacty comment release-handoff-abc12345 --body "Looks good, one nit" --line 42
artifacty comments release-handoff-abc12345
artifacty resolve-comment release-handoff-abc12345 <comment-id>
artifacty review-status release-handoff-abc12345 approved
```


### 버전 비교

`artifacty diff <id> [--from N] [--to M] [--structured] [--json]`은 아티팩트의 두 버전을 비교합니다. 기본적으로 `--to`는 최신 버전, `--from`은 `--to - 1`입니다.

JSON, SARIF, CSV, notebook, bundle은 기본적으로 구조화된 diff를 사용합니다. JSON 경로, CSV 행·셀, 번들 파일 단위의 결과를 제공합니다. 다른 형식은 줄 단위 diff를 사용합니다. 모든 형식에서 구조화된 diff를 요청하려면 `--structured`를 사용하세요. 텍스트 줄에는 변경 단어 강조가 포함됩니다. 일반 unified 텍스트 대신 기계가 읽을 수 있는 결과가 필요하면 `--json`을 사용하세요.

```bash
artifacty diff release-handoff-abc12345
artifacty diff release-handoff-abc12345 --from 1 --to 3 --json
```


### 보존 정책

기본적으로 아티팩트, 감사 로그, 이벤트의 보관량을 제한하지 않습니다. 관리자는 `/admin/retention`이나 `artifacty retention set`으로 보존 정책을 설정할 수 있습니다. 정책은 `meta` 테이블에 저장합니다.

- `archiveAfterDays`는 지정 기간 동안 수정하지 않은 아티팩트를 자동 아카이브합니다. 기본값과 아티팩트 유형별 예외를 설정할 수 있습니다. `keepTags`의 태그가 있거나 `reviewStatus: "approved"`이면 제외합니다.
- `purgeArchivedAfterDays`는 아카이브 후 지정 기간이 지난 아티팩트를 영구 삭제합니다. 버전 파일, 외래 키로 연쇄 삭제되는 댓글·관계·임베딩, `events`와 검색 인덱스 레코드도 삭제합니다. 감사 로그는 삭제 사실을 기록하기 위해 남깁니다(아래 `auditRetentionDays` 참고). 데이터를 완전히 지우는 유일한 보존 작업이므로 서버 환경에 `ARTIFACTY_RETENTION_ALLOW_PURGE=true`가 없으면 거부합니다. `--allow-purge` 또는 요청의 `allowPurge`는 한 번의 실행만 허용하며, 환경 변수 자체를 설정하지 않습니다. 먼저 `artifacty retention run --dry-run`이나 `/admin/retention` 보고서로 삭제 대상을 확인하세요.
- `auditRetentionDays`는 오래된 감사 로그를 정리합니다. `version-repair`, `version-delete`, `retention-purge`, `retention-policy-update`, `owner-change`는 예외로 영구 보관합니다.
- `eventRetentionRows`는 변경 알림용 `events` 테이블의 최대 행 수를 제한합니다.

HTTP 서버는 `ARTIFACTY_RETENTION_INTERVAL_MS`마다 백그라운드 정리를 실행합니다. 기본 간격은 1시간이며, 매번 현재 정책을 확인합니다. 정책이 없어도 타이머를 시작하므로 나중에 설정한 정책은 재시작 없이 다음 실행부터 적용됩니다.

영구 삭제가 중단되면 `artifacty integrity`/`checkStoreIntegrity`가 남은 파일을 보고합니다. `artifacty doctor`는 현재 보존 정책 요약을 표시합니다.

```bash
artifacty retention show
artifacty retention set --archive-after-days 90 --archive-after-days-for test-report=30 --purge-archived-after-days 180 --audit-retention-days 365 --event-retention-rows 10000 --keep-tag pinned
artifacty retention run --dry-run
ARTIFACTY_RETENTION_ALLOW_PURGE=true artifacty retention run --allow-purge
```


### 대시보드 필터와 저장된 뷰

`listArtifactsPage`와 이를 사용하는 `/` 대시보드, `GET /api/artifacts`, `artifacty list`, `artifacty_list`는 `q`/`tag`/`sourceAgent`/`relatedTo`/`relation`/`includeArchived` 외에도 다음 필터를 지원합니다.

- `artifactType`: 아티팩트 유형과 정확히 일치하는 항목입니다.
- `publisher`: `publisherId`, `publisherUserId`, `ownerUserId` 중 하나와 일치하는 항목입니다.
- `createdAfter` / `createdBefore`: `createdAt`의 ISO 날짜 또는 날짜·시간 범위입니다. 해석할 수 없는 값이면 `400`과 `code: "invalid_filter"`를 반환합니다.
- `reviewStatus`: 아티팩트의 리뷰 상태입니다. `none`, `pending`, `changes-requested`, `approved`를 지원합니다.

자주 쓰는 필터 조합을 **뷰**로 저장할 수 있습니다.

- `{ name, filters, shared }`를 담은 `POST /api/views`로 생성하고, `GET /api/views`로 현재 사용자가 볼 수 있는 뷰를 조회하며, `DELETE /api/views/:id`로 삭제합니다. `filters`에는 `query`, `tag`, `sourceAgent`, `artifactType`, `publisher`, `createdAfter`, `createdBefore`, `reviewStatus`, `relatedTo`, `relation`, `includeArchived`, `mode`만 허용합니다. 다른 키는 `code: "invalid_filter"`로 거부합니다.
- 계정이 없는 단일 사용자 모드에서는 뷰가 전역으로 적용됩니다. 팀 모드에서는 만든 사용자만 볼 수 있으며, `shared: true`이면 모든 사용자에게 보입니다.
- `/` 또는 `GET /api/artifacts`의 `?view=<name-or-id>`는 저장된 필터를 먼저 적용합니다. `view`와 함께 보낸 다른 쿼리 매개변수는 해당 필터만 덮어씁니다. `artifacty_list`와 `artifacty list --view <name-or-id>`도 같습니다.
- 대시보드 사이드바에는 뷰 목록, 삭제 버튼, “현재 필터 저장” 폼이 있습니다. CLI에서는 `artifacty views`, `artifacty views save <name> [--shared] [filters...]`, `artifacty views delete <id>`로 관리합니다.
- `groupBy=artifactType|sourceAgent|day`는 가져온 페이지를 유형·에이전트·날짜별로 묶어 표시합니다. 대시보드 쿼리 매개변수나 CLI의 `--group-by`로 지정합니다. 표시 방식만 바꾸며 조회 대상이나 정렬 순서는 바꾸지 않습니다.

```bash
artifacty list --type handoff --review-status pending --created-after 2025-01-01
artifacty views save open-handoffs --type handoff --review-status pending --shared
artifacty list --view open-handoffs --group-by sourceAgent
artifacty views delete <view-id>
```


## 이벤트

변경 작업(`artifact.created`, `artifact.updated`, `artifact.archived`, `artifact.restored`, `artifact.relation.added`, `artifact.version.repaired`, `artifact.version.deleted`)마다 이벤트를 게시합니다. 에이전트는 `artifacty_list`를 반복 조회하는 대신 이벤트에 반응할 수 있습니다.

**셸에서 감시하기:**

```bash
artifacty watch --tag handoff --type artifact.updated --json
artifacty watch --artifact release-handoff-abc12345 --exec "./on-change.sh"
artifacty watch --once   # exits 0 after the first match
```


`--exec`는 이벤트 JSON을 표준 입력으로 전달해 명령을 실행합니다. `ARTIFACTY_EVENT_TYPE`, `ARTIFACTY_EVENT_ARTIFACT_ID`, `ARTIFACTY_EVENT_VERSION` 환경 변수도 제공합니다. 연결이 끊기면 `watch`가 `Last-Event-ID`로 자동 재연결합니다.

**Server-Sent Events:**

```bash
curl -N -H "x-artifacty-token: $ARTIFACTY_API_TOKEN" \
  "http://127.0.0.1:8787/api/events?tag=handoff"
```


`type`, `tag`, `artifactId`, `sourceAgent`로 필터링합니다. 재연결 후 놓친 이벤트를 받으려면 마지막으로 본 이벤트의 `id:` 값을 `Last-Event-ID` 요청 헤더로 보내세요. `Accept: text/event-stream`이 없으면 `GET /api/events?since=<seq>`는 이벤트 한 페이지를 JSON으로 반환하므로 폴링이나 테스트에 쓸 수 있습니다. 서버는 25초마다 하트비트 주석을 보내고 동시 스트림을 `ARTIFACTY_SSE_MAX_CLIENTS`로 제한합니다. 기본값은 64이며 초과 연결에는 `503`을 반환합니다.

**Webhook**은 같은 이벤트를 외부 HTTP 엔드포인트에 전달합니다.

```bash
curl -s -X POST http://127.0.0.1:8787/api/webhooks \
  -H 'content-type: application/json' \
  -H "x-artifacty-token: $ARTIFACTY_API_TOKEN" \
  -d '{ "url": "https://example.com/hooks/artifacty", "eventTypes": ["artifact.updated"] }'
```


응답의 `secret`을 저장하세요. 한 번만 반환합니다. 각 전송은 `POST`로 JSON을 보내며 `X-Artifacty-Event`, `X-Artifacty-Delivery`, `X-Artifacty-Signature: sha256=<hmac>` 헤더를 포함합니다. 실패하면 2초, 10초, 60초 뒤 최대 세 번 재시도합니다. 20번 연속 실패하면 Webhook을 비활성화합니다.

브라우저에서는 `/admin/webhooks`에서 관리합니다. API는 `GET/POST /api/webhooks`, `DELETE /api/webhooks/:id`, `POST /api/webhooks/:id/test`를 제공합니다. 서명 방식과 SSRF 방어는 [위협 모델](docs/ko/threat-model.md)을 참고하세요.

**MCP:** `artifacty://artifacts/{id}` 또는 `artifacty://recent`에 `resources/subscribe`를 요청하면 stdio 전송으로 `notifications/resources/updated`를 받습니다. `artifacty_wait`(`{ artifactId?, tag?, type?, timeoutMs }`, 최대 120000ms)는 모든 전송 방식에서 사용할 수 있는 롱 폴링 대안입니다. `resources/subscribe`로 푸시 알림을 보낼 수 없는 stateless `/mcp` HTTP 전송에서도 작동합니다. 자세한 내용은 [MCP 공개 API](docs/ko/mcp-public-api.md)를 참고하세요.

## API 예시

재사용할 셸 토큰으로 보호된 서버를 시작하세요.

```bash
export ARTIFACTY_API_TOKEN="$(artifacty token --raw)"
artifacty serve --api-token "$ARTIFACTY_API_TOKEN"
```


```bash
curl -s http://127.0.0.1:8787/api/artifacts \
  -H 'content-type: application/json' \
  -H "x-artifacty-token: $ARTIFACTY_API_TOKEN" \
  -d '{
    "title": "PR review dashboard",
    "content": "<h1>Review</h1>",
    "format": "html",
    "sourceAgent": "claude",
    "tags": ["review"]
  }'
```


외부 에이전트의 아티팩트를 변환해 저장하세요.

```bash
curl -s http://127.0.0.1:8787/api/import \
  -H 'content-type: application/json' \
  -H "x-artifacty-token: $ARTIFACTY_API_TOKEN" \
  -d '{
    "agent": "claude",
    "fileName": "deploy-failures.html",
    "content": "<html><head><title>Deploy failures</title></head><body>...</body></html>",
    "tags": ["review"]
  }'
```


브라우저 관련 경로는 다음과 같습니다.

- `/`: 검색어, 태그, 생성 에이전트 필터로 아티팩트를 조회합니다.
- `/new`: CodeMirror 편집기로 Artifacty 아티팩트를 만듭니다.
- `/import`: 외부 에이전트의 결과물을 붙여넣고 변환합니다. 편집기 모드는 자동 감지합니다.
- `/artifacts/:id/edit`: Markdown, HTML, JSON, text, code, SVG, Mermaid, React, SARIF, CSV, image, video 구문 지원으로 새 버전을 저장합니다. 내용이 바뀌지 않은 브라우저 저장은 버전을 만들지 않고 `update-noop` 감사 이벤트로 기록합니다.
- `/artifacts/:id/diff?from=&to=&view=structured|lines`: 버전을 비교합니다. JSON 계열(`json`, `sarif`, `csv`, `notebook`, bundle)은 기본 `structured` 보기에서 JSON 경로, CSV 행·셀, 번들 파일별 변경을 보여줍니다. 다른 형식은 줄 단위 보기가 기본이며 변경된 줄의 단어를 강조합니다.
- `/api/artifacts/:id/diff?from=&to=&view=`: 같은 diff를 구조화된 JSON으로 반환합니다.
- `/admin/artifacts/:id/versions`: 관리자 전용 개별 버전 복구·삭제 화면입니다.
- `/admin/backup`: 관리자 전용 백업 다운로드·복원 화면입니다. `artifacts`/`full` 범위를 선택할 수 있습니다.
- `/api/admin/backup?scope=artifacts|full`: 관리자 전용 백업 JSON 다운로드입니다.
- `/api/admin/backup/import`: 관리자 전용 백업 복원입니다. 원본 번들 또는 `{ bundle, confirm, forceUsers }`를 받습니다.
- `/api/audit`: 감사 이벤트를 조회합니다.
- `/openapi.json`: 모든 `/api/*` 경로와 `/mcp`를 다루는 OpenAPI 3.1 명세입니다. `/docs/api`는 같은 경로의 참고 문서를 서버에서 렌더링합니다. 둘 다 인증 없이 볼 수 있습니다.

목록 API는 `limit`, `offset` 페이지네이션을 지원합니다. 응답은 최상위 `artifacts` 배열을 유지하며 `pagination`, `search` 메타데이터를 포함합니다.

```bash
curl -s "http://127.0.0.1:8787/api/artifacts?q=handoff&limit=20&offset=0" \
  -H "x-artifacty-token: $ARTIFACTY_API_TOKEN"
```


### 낙관적 동시성 제어

모든 아티팩트 응답에는 `latestVersion`과 `etag`(`"<id>:<latestVersion>"`)가 있습니다. 두 에이전트가 같은 버전을 읽고 새 버전을 저장하면 두 번째 저장이 첫 번째 작업 내용을 의도치 않게 대체할 수 있습니다. 이를 막으려면 읽었던 버전을 수정 본문의 `expectedVersion`으로 보내거나 `If-Match` 헤더로 보내세요. 약한 ETag 접두사 `W/"..."`도 지원합니다.

```bash
curl -s http://127.0.0.1:8787/api/artifacts/<id> \
  -H 'content-type: application/json' \
  -H "x-artifacty-token: $ARTIFACTY_API_TOKEN" \
  -H 'If-Match: "<id>:3"' \
  -d '{ "content": "updated content" }'
```


아티팩트의 `latestVersion`이 더 이상 일치하지 않으면 `409 Version conflict`로 수정을 거부합니다.

```json
{ "error": "Version conflict", "code": "version_conflict", "details": { "latestVersion": 4 } }
```


`GET /api/artifacts/:id`는 `ETag` 헤더를 설정합니다. 요청의 `If-None-Match`가 현재 버전과 일치하면 `304 Not Modified`를 반환합니다. `expectedVersion`은 선택 사항이므로 이를 보내지 않는 클라이언트도 계속 작동합니다.

브라우저 편집기는 숨겨진 `expectedVersion` 필드를 보냅니다. 다른 에이전트가 먼저 수정했다면 충돌 안내와 diff 보기 링크를 표시합니다.

## 화면 언어

브라우저 UI의 기본 언어는 영어입니다. `http://127.0.0.1:8787/new?lang=ko`처럼 브라우저 경로에 `?lang=ko`를 추가하면 한국어를 사용합니다. 폼과 앱 내부 링크는 선택한 언어를 유지합니다. 영문 가이드를 기본으로 제공하며, 한국어 가이드는 [문서 안내](docs/ko/README.md)에서 찾을 수 있습니다. 영어·한국어 문서는 [문서 작성 가이드](docs/ko/writing-style.md)를 따릅니다. 한국어는 자연스러운 어순과 표현을 사용합니다.

스키마와 저장소의 주요 사항은 다음과 같습니다.

- 메타데이터는 SQLite에 `schemaVersion: 1`, `artifactType`, `publisherId`, `archivedAt`과 함께 저장합니다.
- 아카이브는 버전을 삭제하지 않고 기본 목록에서 숨깁니다. 잘못 저장했거나 민감한 내용이 있는 과거 버전은 관리자가 복구·삭제할 수 있습니다. `version-repair` 또는 `version-delete` 감사 이벤트가 남습니다.
- bundle 아티팩트는 여러 파일이나 base64 자산을 이동 가능한 JSON으로 저장합니다. `files` 항목에는 PDF, DOCX, XLSX, ZIP 같은 바이너리 문서도 넣을 수 있습니다. 파일당 최대 32 MB이며 base64로 인코딩합니다. `GET /artifacts/:id/raw?file=<path>`로 제공하고, PDF는 샌드박스 iframe에서 미리보기하며 다른 문서는 다운로드 링크를 표시합니다.
- 지원 형식은 `html`, `markdown`, `text`, `json`, `code`, `svg`, `mermaid`, `react`, `sarif`, `csv`, `image`, `video`, `notebook`입니다.
- 생성·가져오기 시 형식을 명시하지 않으면 HTML 문서나 조각에서 `html`을 추론합니다.
- 저장 전에 `sourceAgent`를 정규화합니다. `claude-code`, `Claude Code`, `github-copilot`, `gemini-cli` 같은 별칭은 `claude`, `copilot`, `gemini`로 저장합니다. 기존 `unknown` 레코드는 버전 메타데이터, 감사 데이터, 에이전트 태그에서 알려진 에이전트를 확인할 수 있을 때만 보완합니다.
- 다이어그램, 컴포넌트, 코드 조각, 분석 보고서, 표, 미디어 자산은 각각 `diagram`, `component`, `snippet`, `analysis-report`, `table`, `asset` 유형을 사용합니다.
- Copilot/Cursor 예시에는 PR 리뷰, 스크린샷, 데모 녹화, 시각적 증거 번들이 있습니다.
- [아티팩트 스키마 v1](docs/ko/artifact-schema-v1.md)을 참고하세요.
- MCP 도구·리소스·프롬프트·호환성은 [MCP 공개 API](docs/ko/mcp-public-api.md)를 참고하세요.
- 중앙 팀 배포는 [중앙 팀 배포 설계(영문)](docs/central-team-deployment-design.md)를 참고하세요.
- SARIF/CSV 출력 아티팩트 로드맵은 [SARIF·CSV 아티팩트 계획(영문)](docs/sarif-csv-artifact-plan.md)을 참고하세요.
- 관계, 변경 알림, 낙관적 동시성 제어, 댓글, 의미 검색, 공개 범위, 토큰 권한 범위, 보존 정책 등의 설계는 [로드맵 설계(영문)](docs/roadmap-design.md)를 참고하세요.

## 퍼블릭·프라이빗 접근 모드

이 기능은 SQLite 저장소를 버전 10으로 업그레이드합니다. 이전 빌드는 접근 정책을 무시하는 대신 업그레이드된 저장소를 열지 않습니다.

관리자는 **Account → 접근 관리**(`/admin/access`)에서 재시작 없이 서버 접근 모드를 변경할 수 있습니다. 기존 설치의 기본값은 **퍼블릭**입니다. 팀 공개 아티팩트는 로그인 없이 대시보드에서 볼 수 있고, 비공개 아티팩트는 소유자와 관리자만 접근합니다. 퍼블릭 모드에서도 API 인증과 쓰기 보호는 적용됩니다.

**프라이빗** 모드에서는 브라우저 방문자가 로그인해야 합니다. 소유자·관리자 또는 직접이나 팀을 통해 권한을 받은 사용자만 아티팩트를 읽을 수 있습니다. 기존 `team` 공개 범위가 모든 사용자에게 접근을 허용하지는 않습니다. 공유 권한은 **읽기**, **댓글**, **편집**을 지원합니다. 댓글 권한은 피드백 작성과 자신의 댓글 해결을 허용하며, 편집 권한은 버전 추가도 허용합니다. 직접 부여한 권한과 팀 권한 중 가장 높은 권한이 적용됩니다. 소유권, 공유, 아카이브, 리뷰 상태 관리는 소유자와 관리자에게 남습니다. 관리자는 소유자가 없는 기존 아티팩트에도 접근해 소유자를 지정하거나 공유할 수 있습니다.

`/admin/access`에서 팀을 만들고 각 팀의 구성원을 선택하세요.

아티팩트 접근 권한을 부여하는 순서는 다음과 같습니다.

1. 소유자 또는 관리자 계정으로 아티팩트를 여세요.
2. **공유 관리**를 여세요.
3. 허용할 사용자와 팀을 선택하세요.
4. 각 권한 수준을 선택하세요.
5. 공유 설정을 저장하세요.

**실제 접근 권한** 보고서는 각 사용자의 적용 권한과 이유, 익명 접근 여부, 전역 IP 조건을 보여줍니다. 권한이나 팀 구성원을 제거하면 이후 조회·검색 결과·변경 알림부터 반영됩니다. 개인 API 토큰도 HTTP와 MCP에서 같은 사용자 권한을 따릅니다. 서버 공용 토큰에는 사용자 신원이 없으므로 프라이빗 모드의 일반 아티팩트 경로에서는 읽거나 생성할 수 없습니다. 신뢰할 수 있는 로컬 CLI/저장소 접근은 파일 시스템 관리자 권한으로 유지됩니다.

같은 관리자 페이지에서 IP/CIDR 허용 목록을 설정할 수 있습니다. `192.168.10.0/24`, `2001:db8:1234::/48`처럼 주소나 네트워크를 한 줄에 하나씩 입력하세요. 목록이 비어 있으면 모든 접속 주소를 허용합니다. 항목이 있으면 두 모드 모두에서 로그인, 원본 다운로드, API, HTTP MCP를 포함한 **모든 HTTP 경로**를 제한합니다. IP 허용은 사용자나 아티팩트 권한을 대체하지 않습니다.

관리자의 현재 접속 주소를 제외한 목록은 저장할 수 없습니다. 브라우저 변경은 **120초** 동안 임시 적용됩니다. 접속이 정상인지 확인해 확정하거나 이전 설정으로 되돌리세요. 확정하지 않으면 기한이 지난 다음 정책 검사 전에 복구하며, 서버를 재시작해도 이 동작을 유지합니다. 확정 대기 중에는 다른 변경을 막습니다. 접근 모드는 적용 전에 익명으로 읽을 수 있게 될 아티팩트 수를 미리 보여줍니다.

주소 검사는 IPv4-mapped IPv6를 포함한 실제 TCP 연결 상대를 기준으로 합니다. `X-Forwarded-For`, `Forwarded`는 신뢰하지 않습니다. 리버스 프록시 뒤에서는 프록시가 연결 상대이므로 최종 사용자 IP 제한은 프록시에서 적용하세요. 로컬 stdio MCP와 CLI에는 HTTP 접속 IP가 없으므로 네트워크 허용 목록이 적용되지 않습니다.

전체 백업에는 모드, 네트워크 설정, 팀, 구성원, 공유 권한, 알림함 항목이 포함됩니다. 확정 대기 중인 네트워크 상태와 공유 링크 토큰은 내보내지 않습니다. 아티팩트 전용 복원은 공유 권한을 복원하지 않으며, 기존 권한을 대체한다면 확인이 필요합니다. 프라이빗 서버에 전체 백업을 복원하면 백업이 퍼블릭이었더라도 프라이빗을 유지하고 기존 네트워크 정책도 보존합니다.

퍼블릭으로 다시 전환하면 팀 공개 아티팩트를 로그인 없이 읽을 수 있습니다. 나중에 프라이빗으로 돌아갈 때 사용할 명시적 공유 권한은 유지합니다.

## 공유 링크와 알림함

소유자와 관리자는 아티팩트의 **공유 관리**에서 읽기 전용 링크를 만들 수 있습니다.

1. 최신 버전을 선택하거나 특정 버전으로 고정하세요.
2. 만료 기간을 설정하세요. 기본값은 7일입니다.
3. 처음 표시될 때 URL을 복사하세요.

해시만 저장하므로 전체 URL은 다시 표시하지 않습니다. 링크는 개별 폐기할 수 있으며 소유권을 이전하면 영구 폐기됩니다. 아카이브한 아티팩트나 삭제된 버전은 링크로 읽을 수 없습니다.

링크는 계정 없이 선택한 아티팩트를 읽게 하므로 프라이빗 모드에서는 관리자가 `/admin/access`의 **프라이빗 모드에서 공유 링크 허용**을 켜야 합니다. 이를 끄면 서버가 프라이빗인 동안 기존 링크도 사용할 수 없습니다. 모든 링크 요청은 네트워크 허용 목록을 따릅니다. 대시보드, 버전 이력, 댓글, 편집 기능은 링크에 노출하지 않습니다. 공개 HTML 미리보기는 정적 화면이며 스크립트와 외부 리소스를 차단합니다. React, Mermaid, SVG, notebook은 실행 대신 소스를 보여줍니다.

**알림함**(`/inbox`)은 로그인한 사용자에게 새 공유 아티팩트, 댓글, 리뷰 요청, 새 버전을 표시합니다. 자신이 발생시킨 이벤트는 제외합니다. 알림을 개별 확인하거나 모두 읽음 처리할 수 있습니다. 아티팩트 접근 권한을 회수하면 관련 알림도 숨기고 읽지 않은 알림 수에서 제외합니다.

## 샘플 매뉴얼

영문 샘플 아티팩트 **Start here**, **Feature guide**, **Architecture**, **Handoff exercise** 네 개를 설치할 수 있습니다. 관리자는 `/admin/access`의 샘플 기능을 사용하고, 로컬 CLI에서는 다음을 실행하세요.

```bash
artifacty samples install
artifacty samples remove
```


같은 설치 계정 또는 로컬 CLI 범위에서 반복 설치해도 중복 생성하지 않습니다. 다시 설치하면 수정 내용을 덮어쓰지 않고 아카이브된 샘플을 복원합니다. 제거는 관리 대상 샘플을 아카이브하고 버전을 보존합니다. 이름이나 태그가 비슷한 다른 아티팩트는 삭제하지 않습니다. 프라이빗 모드에서는 각 아티팩트의 공유 관리에서 필요한 사용자나 팀에 매뉴얼을 공유하세요.

## 보안 모델

- HTTP 서버는 기본적으로 `127.0.0.1`에 바인딩합니다.
- `ARTIFACTY_API_TOKEN`이 설정되면 HTTP API에 `Authorization: Bearer <token>` 또는 `x-artifacty-token`이 필요합니다. 스크립트에서는 `?token=...` URL보다 헤더를 사용하세요.
- 사용자가 있으면 `/account`에서 발급한 개인 API 토큰으로도 HTTP API와 MCP 요청을 인증합니다. 생성한 아티팩트는 토큰 소유자의 이메일을 `publisherId`로, 감사 로그는 같은 신원을 `actor`로 기록합니다.
- API 토큰은 타이밍 공격에 안전한 다이제스트 비교로 검사합니다.
- 개인 API 토큰은 `read`, `write`, `admin` 권한 범위를 지원하며 기본값은 `read`+`write`입니다. `/account`에서 생성할 때 선택합니다. `admin`은 관리자 토큰에만 부여할 수 있습니다. 각 `/api/*` 경로에는 해당 토큰 범위가 필요합니다. 공용 `ARTIFACTY_API_TOKEN`과 브라우저 세션은 전체 범위를 가집니다.
  범위 검사가 실패하면 `403`과 `code: "scope_denied"`를 반환하고 빈도를 제한한 `token-scope-denied` 감사 로그를 기록합니다. `write`가 없는 MCP 토큰의 `tools/list`에서는 쓰기 도구를 숨깁니다. 직접 호출해도 `structuredContent.code: "scope_denied"` 오류가 납니다.
- 계정이 하나라도 있으면 각 아티팩트에는 `visibility`(`private` 또는 `team`, 기본값 `team`)와 `ownerUserId`가 있습니다. 퍼블릭 접근 모드의 `team`은 인증된 주체가 읽고 쓸 수 있습니다. 다만 `ARTIFACTY_TEAM_WRITE=owner`이면 쓰기는 소유자·관리자로 제한합니다. `private`은 소유자·관리자만 읽고 쓰며, 다른 사용자의 조회에는 존재 여부를 숨기기 위해 403 대신 404를 반환합니다. 아카이브, 복원, 공개 범위·소유권 변경은 공개 범위와 무관하게 소유자·관리자만 할 수 있습니다. 공용 `ARTIFACTY_API_TOKEN`이나 첫 계정 생성 전 요청에는 개인 신원이 없으며 익명 팀 주체로 처리합니다. `team`은 읽고 쓸 수 있지만 `private`은 보지 못합니다. 계정이 전혀 없는 단일 사용자 모드에서는 이 검사를 생략해 기존 공개 범위 기능 이전의 동작을 유지합니다. 공개 범위·소유권 변경에는 `POST /api/artifacts/:id/visibility`, `POST /api/artifacts/:id/owner`, CLI의 `artifacty visibility <id> private|team`, MCP의 `artifacty_set_visibility`를 사용합니다.
- HTTP와 HTTP MCP 요청은 `(token or user or remote address, bucket)` 조합(토큰·사용자·원격 주소 중 하나와 버킷)별로 고정된 1분 구간에서 횟수를 제한합니다. `write`는 변경 경로에 기본 분당 120회(`ARTIFACTY_RATE_WRITE_PER_MIN`), `auth`는 `/login`에 주소별 분당 10회(`ARTIFACTY_RATE_AUTH_PER_MIN`), `search`는 `GET /api/artifacts?q=`에 분당 300회(`ARTIFACTY_RATE_SEARCH_PER_MIN`)입니다. 루프백 바인딩에서는 `ARTIFACTY_RATE_LIMIT=always`가 없으면 비활성화하며, `ARTIFACTY_RATE_LIMIT=off`이면 항상 비활성화합니다. 한도를 넘으면 `429`, `Retry-After` 헤더, `code: "rate_limited"`를 반환하고 빈도를 제한한 `rate-limited` 감사 로그를 남깁니다.
- localhost 외부에 바인딩하려면 `ARTIFACTY_SHARE_MODE=lan` 또는 `team`과 `ARTIFACTY_API_TOKEN`이 모두 필요합니다.
- 외부 공유는 신뢰할 수 있는 LAN이나 VPN 세션을 위한 기능입니다. `0.0.0.0`보다 특정 인터페이스 IP를 사용하고 React 렌더링은 비활성화하세요. [네트워크 공유](docs/ko/network-sharing.md)를 참고하세요.
- Artifacty는 TLS를 직접 처리하지 않으므로 외부 바인딩 시 시작 경고를 표시합니다.
- 저장 전에 일반적인 API 키와 개인키 패턴을 탐지합니다. 의도적인 예외에만 `--allow-secrets` 또는 `ARTIFACTY_ALLOW_SECRETS=true`를 사용하세요.
- 생성, 수정, 조회, 가져오기, 아카이브, 복원, 내용이 바뀌지 않은 브라우저 저장, 관리자 버전 복구·삭제는 SQLite에 감사 이벤트를 남깁니다. 게시자 정보가 없는 기존 아티팩트는 첫 `create` 또는 `import` 감사 이벤트의 주체로 가능한 범위에서 보완합니다.
- CodeMirror 편집기·뷰어와 렌더러 자산은 공개 CDN 대신 허용 목록에 있는 로컬 npm 의존성에서 제공합니다. JavaScript 자산 경로는 `Origin: null`에 `Access-Control-Allow-Origin: null`로 응답합니다. 샌드박스 iframe이 `allow-same-origin` 없이 로컬 ESM을 가져올 수 있습니다.
- 데이터를 변경하는 HTTP 경로는 서버와 출처가 다른 브라우저 요청을 거부합니다.
- HTML은 샌드박스 iframe에서 렌더링합니다.
- SVG는 스크립트가 없는 샌드박스 iframe에서 렌더링하며, 뷰어에서 `<script>`, `on*` 속성, `javascript:` 링크를 제거합니다. 원본 소스는 바꾸지 않습니다.
- Mermaid는 로컬에 포함된 Mermaid 패키지를 사용하며 `allow-same-origin`이 없는 샌드박스 iframe에서 렌더링합니다.
- React는 기본적으로 소스만 표시합니다. `ARTIFACTY_ENABLE_REACT_RENDERER=true`이면 JSX 변환을 허용하는 프레임 전용 CSP와 샌드박스에서 실행합니다.
- SARIF는 결과 요약을 제한된 범위로 렌더링하고 전체 정렬된 JSON을 원본 소스 상세 패널에 둡니다. 클라이언트에서는 수준(error/warning/note) 필터, 규칙 ID 텍스트 필터, 수준·규칙·위치 정렬을 추가합니다. 점진적 향상 방식이므로 JavaScript 없이도 서버 출력은 올바르게 보입니다.
- CSV는 이스케이프한 제한된 크기의 표로 표시하고 `/raw`는 원문을 유지합니다. 머리글을 클릭하면 숫자를 고려해 열을 정렬하며, 열별 포함 문자열 필터와 표시 행 수를 제공합니다.
- `GET /artifacts/:id/export?format=csv&sort=<col>&dir=asc|desc&filter=<col>:<text>[,...]`와 `GET /artifacts/:id/export?format=sarif&level=error,warning&rule=<text>`는 저장된 원본을 다시 파싱합니다(`/raw` 자체를 사용하지 않음). 필터·정렬을 적용한 새 파일을 `Content-Disposition: attachment`로 스트리밍하며 아티팩트 최대 바이트 크기로 제한합니다. 잘못된 매개변수는 400과 `code: "invalid_export"`를 반환합니다.
- image와 video는 base64 미디어를 내부에 저장하고 안전하게 미리보기하며 `/raw`에서 바이트로 디코딩합니다.
- Markdown의 fenced 코드 블록은 클라이언트의 CodeMirror 읽기 전용 구문 강조를 사용합니다. 서버 출력은 이스케이프한 일반 HTML이므로 JavaScript 없이도 작동합니다. ```mermaid``` 블록은 전체 Mermaid 아티팩트와 같은 샌드박스 iframe으로 표시합니다. 다이어그램마다 필요할 때 iframe을 만들며 `ARTIFACTY_MAX_INLINE_DIAGRAMS`(기본 20개)로 제한하고 나머지는 이스케이프된 코드로 둡니다. 작업 목록은 비활성 체크박스, 표는 가로 스크롤 컨테이너로 표시합니다. Markdown 내부 HTML은 항상 이스케이프합니다.
- notebook(`.ipynb`)은 원본 JSON을 그대로 저장합니다. 셀은 순서대로 표시하며 Markdown 셀은 같은 Markdown 처리 과정을 사용하고, 코드 셀은 실행 횟수와 구문 강조된 이스케이프 소스를 보여줍니다. 출력은 `text/plain`, `text/markdown`, `image/png`, `image/jpeg`, `image/svg+xml`(스크립트 없는 샌드박스 iframe), `text/html`(샌드박스 iframe)만 지원합니다. 다른 MIME 유형은 자리표시자로, 2 MB 초과 출력은 잘림 안내로 대체합니다. 처음 500개 셀까지만 렌더링합니다.
- 아티팩트 내용은 여전히 신뢰할 수 없는 데이터로 취급하세요. 에이전트에 다시 전달할 때는 원본 보기를 사용하세요.
- npm 릴리스는 lint, 테스트, smoke 검사를 통과한 뒤 GitHub Actions의 OIDC Trusted Publishing으로 게시합니다.

게시하거나 공유 인스턴스를 운영하기 전에 [보안 정책](SECURITY.ko.md), [위협 모델](docs/ko/threat-model.md), [릴리스 체크리스트](docs/ko/release-checklist.md)를 확인하세요.

## 환경 변수

Artifacty가 읽는 모든 `ARTIFACTY_*` 변수를 아래에 정리했습니다. `node src/cli.js help`도 같은 목록을 출력합니다.

| 변수 | 용도 | 기본값 |
| --- | --- | --- |
| `ARTIFACTY_HOME` | 저장소 디렉터리 | `~/.artifacty` |
| `ARTIFACTY_BACKUP_ON_UPDATE` | 애플리케이션 버전 변경 전에 기존 저장소를 스냅샷으로 보관. 스키마 마이그레이션 스냅샷은 항상 필수 | `false` |
| `ARTIFACTY_UPGRADE_BACKUP_KEEP` | 보관할 자동 업그레이드 스냅샷 수. 1–1000의 정수 | `3` |
| `ARTIFACTY_URL` | 공개 URL 재정의. 미설정 시 CLI/MCP가 마지막 서버 URL 사용 | — |
| `ARTIFACTY_HOST` | HTTP 서버의 바인딩 호스트 | `127.0.0.1` |
| `ARTIFACTY_PORT` | HTTP 서버의 바인딩 포트 | `8787` |
| `ARTIFACTY_MCP_URL` | 브리지 모드의 중앙 MCP HTTP 엔드포인트 | — |
| `ARTIFACTY_MCP_MODE` | `local` 또는 `bridge`. `bridge`는 stdio MCP를 `ARTIFACTY_MCP_URL`로 전달 | `local` |
| `ARTIFACTY_MCP_HTTP` | `true`이면 실행 중인 서버에 HTTP MCP도 제공 | `false` |
| `ARTIFACTY_MCP_TIMEOUT_MS` | 브리지 모드 MCP HTTP 요청 시간 제한 | `30000` |
| `ARTIFACTY_API_TOKEN` | HTTP API와 LAN/팀 공유에 필요한 공용 토큰 | — |
| `ARTIFACTY_LOCALE` | 요청이 언어를 지정하지 않을 때 사용할 UI 언어(`en`, `ko` 등) | `en` |
| `ARTIFACTY_EMBEDDINGS_URL` | OpenAI 호환 임베딩 엔드포인트의 기본 URL. 의미·하이브리드 검색 활성화 | — |
| `ARTIFACTY_EMBEDDINGS_MODEL` | 임베딩 모델 이름 | 제공자 기본값 |
| `ARTIFACTY_EMBEDDINGS_API_KEY` | OpenAI 호환 제공자의 API 키. 로그나 저장소에 남기지 않음 | — |
| `ARTIFACTY_EMBEDDINGS_COMMAND` | stdin으로 JSON 줄을 읽고 stdout으로 벡터를 쓰는 로컬 명령 | — |
| `ARTIFACTY_EMBEDDINGS_MAX_CHARS` | 아티팩트당 임베딩할 최대 문자 수 | `8000` |
| `ARTIFACTY_EMBEDDINGS_TIMEOUT_MS` | 로컬 임베딩 명령의 시간 제한 | `30000` |
| `ARTIFACTY_EMBEDDINGS_MAX_CANDIDATES` | 의미·하이브리드 검색 한 번에 평가할 최대 임베딩 행 수 | `20000` |
| `ARTIFACTY_EMBEDDINGS_SYNC` | `true`이면 백그라운드 대신 동기식으로 임베딩 색인. 테스트에 사용 | `false` |
| `ARTIFACTY_SHARE_MODE` | `lan` 또는 `team`. localhost 외부 바인딩 전에 필요 | — |
| `ARTIFACTY_TEAM_WRITE` | `owner`이면 `team` 공개 범위 아티팩트 쓰기를 소유자·관리자로 제한 | — |
| `ARTIFACTY_ALLOW_SECRETS` | 탐지된 비밀정보 패턴에 해당하는 내용을 의도적으로 저장할 때만 `true` | `false` |
| `ARTIFACTY_ENABLE_REACT_RENDERER` | `true`이면 React 소스 표시 대신 샌드박스 프레임에서 실행 | `false` |
| `ARTIFACTY_RETENTION_INTERVAL_MS` | 백그라운드 보존 정책 실행 간격 | `3600000` (1시간) |
| `ARTIFACTY_RETENTION_ALLOW_PURGE` | `true`이면 보존 정책 실행 시 아카이브된 아티팩트 영구 삭제 허용 | `false` |
| `ARTIFACTY_WEBHOOK_TIMEOUT_MS` | Webhook 전송 시도당 시간 제한 | `10000` |
| `ARTIFACTY_WEBHOOK_ALLOW_PRIVATE` | `true`이면 사설·루프백 주소로 해석되는 Webhook URL 허용 | `false` |
| `ARTIFACTY_EVENT_POLL_MS` | 새 이벤트를 확인하는 SSE 폴링 간격 | `1000` |
| `ARTIFACTY_EVENT_HISTORY` | 재전송용 메모리 이벤트 이력의 최대 수 | `10000` |
| `ARTIFACTY_SSE_MAX_CLIENTS` | 최대 동시 SSE 연결 수 | `64` |
| `ARTIFACTY_MAX_WAITS` | 최대 동시 `artifacty_wait` MCP 롱 폴링 수 | `64` |
| `ARTIFACTY_MAX_DIFF_ENTRIES` | `artifacty diff`당 계산할 최대 diff 항목 수 | `5000` |
| `ARTIFACTY_MAX_INLINE_DIAGRAMS` | Markdown 아티팩트당 렌더링할 최대 인라인 Mermaid 다이어그램 수 | `20` |
| `ARTIFACTY_MAX_COMMENTS_PER_ARTIFACT` | 아티팩트당 보관할 최대 댓글 수 | `2000` |
| `ARTIFACTY_MAX_SAVED_VIEWS_PER_USER` | 사용자당 보관할 최대 저장 뷰 수 | `100` |
| `ARTIFACTY_RATE_LIMIT` | `always` 또는 `off`. 기본값(루프백에서는 비활성화, 나머지는 활성화)을 재정의 | — |
| `ARTIFACTY_RATE_WRITE_PER_MIN` | 변경 요청의 횟수 제한 | `120`/분 |
| `ARTIFACTY_RATE_AUTH_PER_MIN` | 주소별 `/login` 요청의 횟수 제한 | `10`/분 |
| `ARTIFACTY_RATE_SEARCH_PER_MIN` | `GET /api/artifacts?q=` 검색 요청의 횟수 제한 | `300`/분 |
