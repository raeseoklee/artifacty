[English](../artifact-schema-v1.md) | 한국어

<!-- 번역 기준: 9e73a9f -->
<!-- 문장·의미 대조: 2026-10-20, 영문 동시 개정본 기준 -->

# 아티팩트 스키마 v1

Artifacty 스키마 v1은 HTTP, CLI, MCP, 변환기, SQLite 저장소에서 사용하는 안정적인 레코드 구조를 정의합니다.

## 아티팩트 레코드

```json
{
  "id": "artifact-id",
  "schemaVersion": 1,
  "artifactType": "document",
  "title": "Readable title",
  "sourceAgent": "codex",
  "publisherId": "user@example.com",
  "publisherName": "User Name",
  "publisherUserId": "user-record-id",
  "visibility": "team",
  "ownerUserId": "user-record-id",
  "reviewStatus": "none",
  "tags": ["handoff"],
  "createdAt": "2026-06-24T00:00:00.000Z",
  "updatedAt": "2026-06-24T00:00:00.000Z",
  "archivedAt": null,
  "latestVersion": 1,
  "versions": []
}
```

허용되는 `artifactType` 값은 다음과 같습니다.

- `document`
- `html-page`
- `handoff`
- `code-review`
- `test-report`
- `dashboard`
- `design-option`
- `diff-walkthrough`
- `bundle`
- `asset`
- `diagram`
- `component`
- `snippet`
- `analysis-report`
- `table`
- `unknown`

변환기는 알 수 없는 레거시 유형이나 외부 유형을 거부하지 않고 `unknown`으로 매핑하는 것이 좋습니다. 네이티브 생성·수정 작업은 명시적으로 지정한 유형이 지원되지 않으면 요청을 거부합니다.

`sourceAgent`는 아티팩트를 만든 도구나 모델 인터페이스를 식별합니다. 예를 들어 `codex`나 `claude`를 사용합니다. `publisherId`는 Artifacty 저장소에 아티팩트를 게시한 사람을 식별합니다. 인증을 사용하는 중앙 서버에서는 개인 토큰 소유자의 이메일입니다. 서버가 요청을 로컬 사용자 레코드와 연결할 수 있으면 `publisherName`과 `publisherUserId`도 포함합니다. 레거시 아티팩트에서는 최초 `create` 또는 `import` 감사 기록의 작업자를 바탕으로 이 필드를 채우도록 시도합니다.

알려진 에이전트 별칭은 저장 전에 표준 이름으로 정규화합니다. 예를 들어 `claude-code`, `Claude Code`, `anthropic`은 `claude`가 되고, `github-copilot`은 `copilot`, `gemini-cli`는 `gemini`가 됩니다. 기존 `unknown` 레코드는 버전 메타데이터, 감사 데이터, 에이전트 태그에서 알려진 에이전트를 확인할 수 있을 때만 갱신합니다.

`visibility`는 `"private"`, `"team"`, `"public"` 중 하나이며, 기본값은 `"team"`입니다. `ownerUserId`는 소유자를 식별합니다. 사용자 계정이 있는 공개 사이트 모드에서는 누구나 `public` 아티팩트를 읽을 수 있지만, 소유자나 관리자만 수정할 수 있습니다. 인증된 사용자는 `team` 아티팩트를 읽고 수정할 수 있습니다. 팀 아티팩트의 쓰기 권한을 소유자와 관리자로 제한하려면 `ARTIFACTY_TEAM_WRITE=owner`를 설정하세요. 일반 아티팩트 경로로 `private` 아티팩트에 접근하려면 소유자나 관리자여야 합니다. API 인증 요구사항은 그대로 적용됩니다.

비공개 사이트 모드에서는 공개 범위가 public인 아티팩트에도 개인 사용자 식별 정보가 필요합니다. 소유자와 관리자는 계속 접근할 수 있습니다. 그 외 사용자는 자신에게 직접 부여되거나 소속 팀을 통해 부여된 읽기, 댓글, 편집 권한이 있어야 합니다. 여러 권한이 일치하면 가장 높은 권한을 적용합니다. 두 모드 모두 아카이브, 복원, 공유, 공개 범위 변경, 소유권 변경은 소유자나 관리자만 수행할 수 있습니다. 토큰 범위에 따라 접근이 추가로 제한될 수 있습니다.

소유자가 만든 공유 링크는 별도의 읽기 전용 접근 경로를 제공합니다. 비공개 사이트 모드에서는 관리자가 공유 링크를 명시적으로 허용해야 합니다. 만료와 폐기 규칙은 [공개 공유 링크](threat-model.md#public-share-links-and-network-restrictions)를 참조하세요.

사용자 계정이 없는 공개 모드에서는 사용자 접근 검사를 적용하지 않습니다. `ownerUserId`의 기본값은 `publisherUserId`에서 가져온 생성자의 사용자 ID입니다. 마이그레이션도 같은 규칙으로 기존 레코드의 이 필드를 채웁니다. 전체 권한 표는 [README의 보안 모델](../../README.ko.md)을 참조하세요.

`reviewStatus`는 `none`(기본값), `pending`, `changes-requested`, `approved` 중 하나입니다. 소유자나 관리자가 `POST /api/artifacts/:id/review-status`, `artifacty_set_review_status`, `artifacty review-status`로 설정할 수 있습니다.

`approved` 상태에서 새 버전이 추가되면 상태를 `pending`으로 되돌립니다. `update` 감사 레코드의 메타데이터에는 `reviewStatusReset: { from: "approved", to: "pending" }`를 기록합니다.

## 버전 레코드

일반적인 생성·수정 작업은 버전을 추가합니다. 각 버전은 콘텐츠 파일 하나를 가리킵니다. 관리자는 실수로 저장했거나 민감한 콘텐츠를 바로잡기 위해 과거 버전을 복구하거나 삭제할 수 있습니다. 이러한 예외적인 유지보수 작업은 `version-repair` 또는 `version-delete` 감사 이벤트를 남깁니다.

```json
{
  "version": 1,
  "createdAt": "2026-06-24T00:00:00.000Z",
  "format": "markdown",
  "contentType": "text/markdown; charset=utf-8",
  "path": "artifacts/id/v1.md",
  "sizeBytes": 128,
  "sha256": "...",
  "metadata": {}
}
```

허용되는 `format` 값은 `html`, `markdown`, `text`, `json`, `code`, `svg`, `mermaid`, `react`, `sarif`, `csv`, `image`, `video`, `notebook`입니다.

자주 사용하는 `artifactType` 값으로는 `document`, `handoff`, `code-review`, `test-report`, `dashboard`, `bundle`, `diagram`, `component`, `snippet`, `analysis-report`, `table`이 있습니다.

## 렌더러 정책

저장소는 아티팩트 원본을 변경 불가능한 콘텐츠로 보존합니다. 브라우저 뷰어는 모든 원본을 신뢰할 수 없는 콘텐츠로 취급해야 합니다.

- `code`: 읽기 전용 CodeMirror 뷰어를 사용하며, 이를 사용할 수 없으면 이스케이프한 원본을 표시합니다.
- `svg`: 뷰어에서 위험 요소를 제거한 뒤 스크립트를 실행하지 않는 샌드박스 iframe에 표시합니다. `/raw`는 원본을 그대로 보존합니다.
- `mermaid`: 함께 배포하는 로컬 Mermaid 번들을 `allow-same-origin`이 없는 샌드박스 iframe에서 실행합니다. 출처가 불투명한 프레임에서도 ESM을 가져올 수 있도록, 로컬 JavaScript 자산은 `Origin: null` 요청에 `Access-Control-Allow-Origin: null`을 사용합니다.
- `react`: 기본적으로 소스만 표시합니다. `ARTIFACTY_ENABLE_REACT_RENDERER=true`를 설정하면 JSX 변환과 실행을 위한 별도의 샌드박스 프레임을 활성화합니다. CSP는 해당 프레임에만 적용합니다.
- `sarif`: 크기가 제한된 분석 결과 요약과 형식을 정리한 원본 JSON 상세 패널을 표시합니다.
- `csv`: 행과 열의 수를 제한하고, RFC 4180 방식으로 해석한 데이터를 이스케이프하여 표로 표시합니다.
- `image`: base64 미디어 원본을 `<img>`로 표시합니다. `/raw`는 바이트로 디코딩합니다.
- `video`: base64 미디어 원본을 `<video controls>`로 표시합니다. `/raw`는 바이트로 디코딩합니다.
- `markdown`: fenced 코드 블록은 서버에서 이스케이프한 `<pre><code class="language-x">`로 렌더링합니다. 브라우저에서는 함께 배포하는 언어 패키지를 사용해 읽기 전용 CodeMirror 뷰로 전환합니다. JavaScript가 없어도 이스케이프된 마크업만으로 올바르게 표시됩니다. ```mermaid``` 블록은 문서 전체가 Mermaid인 아티팩트와 같은 샌드박스 Mermaid iframe으로 표시합니다. 다이어그램마다 iframe 하나를 만들며, `IntersectionObserver`를 통해 필요한 시점에 생성합니다. 문서별 개수는 `ARTIFACTY_MAX_INLINE_DIAGRAMS`로 제한하며 기본값은 20입니다. 한도를 넘는 블록은 안내문과 함께 이스케이프된 소스로 남깁니다. 작업 목록 항목(`- [ ]`/`- [x]`)은 비활성 체크박스로, 표는 가로로 스크롤할 수 있는 컨테이너 안에 표시합니다. Markdown 원본의 인라인 HTML은 항상 이스케이프하며 HTML로 해석하지 않습니다.
- `notebook`: 원본 `.ipynb` JSON을 저장하고 렌더링할 때만 파싱합니다. 파싱에 실패하면 안전하게 형식을 정리한 JSON으로 표시합니다. 셀은 원래 순서대로 렌더링합니다. Markdown 셀에는 위와 같은 Markdown 처리 과정을 사용하고, 코드 셀에는 실행 횟수와 함께 이스케이프하고 구문을 강조한 소스를 표시합니다. 셀 출력은 `text/plain`, `text/markdown`, `image/png`, `image/jpeg`(base64에서 디코딩), `image/svg+xml`(스크립트 없는 샌드박스 iframe), `text/html`(샌드박스 iframe)만 허용합니다. 다른 MIME 유형은 유형 이름을 적은 자리표시자로 표시합니다. `stream`/`error` 출력은 이스케이프한 텍스트로 표시하며, 2 MB가 넘는 출력은 잘림 안내문으로 대체합니다. 처음 500개 셀까지만 렌더링하고, 셀이 더 많으면 안내문을 표시합니다.

## 메타데이터

메타데이터는 자유 형식의 JSON입니다. 다만 변환기가 생성하는 메타데이터는 다음 키를 사용합니다.

- `artifactyImport`: 변환기 이름, 원본·출처 에이전트, 파일 이름·경로, 콘텐츠 유형, 아티팩트 유형, 변환 시각입니다.
- `originalPayloadShape`: `gemini-llmContent`, `content`, `artifact-bundle` 등 원본 payload의 계열입니다.
- `assetPolicy`: 내장 자산을 보존한 방식입니다.
- `bundlePolicy`: 번들 파일을 보존한 방식입니다.
- `language`: 상위 에이전트가 제공한 코드 또는 컴포넌트 아티팩트의 소스 언어입니다.
- `continuation`: 에이전트 출력에 관한 구조화된 인수인계·리뷰·검증 메타데이터입니다. 변경 파일, 명령어, 테스트, 장애 요인, 결정 사항, 다음 단계, 발견 사항, diff 텍스트, 잔여 위험을 포함합니다.
- `<agent>Continuation`: 호환성을 위해 유지하는 구조화된 작업 인수인계 메타데이터의 사본입니다. 예를 들어 `codexContinuation`, `copilotContinuation`, `cursorContinuation`을 사용합니다.

## 관계

아티팩트는 다른 아티팩트와 유형 및 방향이 있는 관계를 맺을 수 있습니다. 관계는 `artifact_relations` 테이블에 저장합니다. 필드는 `from_id`, `to_id`, `relation`, `created_at`, `created_by`, `metadata_json`이며, `(from_id, to_id, relation)` 조합은 고유합니다.

허용되는 `relation` 값은 다음과 같으며, v1에서는 이 목록으로 제한합니다.

- `derived-from` — `to`를 읽고 `from`을 생성했습니다.
- `supersedes` — `from`이 `to`를 대체합니다.
- `reviews` — `from`은 `to`의 리뷰입니다.
- `references` — 느슨한 인용 관계입니다.
- `part-of` — `from`이 번들 또는 컬렉션 `to`에 속합니다.

역방향 이름은 저장하지 않고 계산해서 상대 아티팩트에 표시합니다. `derived-from` ↔ `derives`, `supersedes` ↔ `superseded-by`, `reviews` ↔ `reviewed-by`, `references` ↔ `referenced-by`, `part-of` ↔ `contains`가 대응합니다.

`createArtifact`와 `updateArtifact`는 선택적인 `relations` 배열(`[{ toId, relation }]`)을 받습니다. 이를 사용하면 아티팩트를 생성하거나 수정하는 호출에서 관계도 함께 추가할 수 있습니다. `getArtifact` 응답에는 다음 내용이 포함됩니다.

```json
{
  "relations": {
    "outgoing": [
      { "id": "rel-id", "relation": "derived-from", "artifactId": "other-id", "artifact": { "...": "summary" }, "missing": false, "createdAt": "2026-06-24T00:00:00.000Z" }
    ],
    "incoming": []
  }
}
```

`artifact`에는 연결된 아티팩트의 요약이 들어갑니다. 대상이 더 이상 없으면 `artifact`는 `null`, `missing`은 `true`가 됩니다. 응답에는 대상이 사라진 관계도 남겨 둡니다. 대상은 있지만 호출자에게 읽기 권한이 없으면 `artifactId`와 `artifact`는 `null`, `restricted`는 `true`, `missing`은 `false`가 됩니다. Artifacty는 자기 자신을 가리키는 관계(`fromId === toId`)와 허용 목록에 없는 관계 이름을 거부합니다.

`GET /api/artifacts`와 `artifacty_list`는 `relatedTo=<id>`를 받으며, 선택적으로 `relation=<name>`도 받습니다. 이를 사용하면 지정한 아티팩트와 어느 방향으로든 연결된 아티팩트로 결과를 제한할 수 있습니다.

## 댓글과 리뷰 상태

댓글은 특정 버전에 연결하는 짧은 메모입니다. `artifact_comments` 테이블에 저장하며 필드는 `id`, `artifact_id`, `version`, `parent_id`, `author_user_id`, `author_label`, `source_agent`, `body`, `anchor_json`, `status`, `created_at`, `resolved_at`, `resolved_by`, `deleted_at`입니다.

```json
{
  "id": "comment-id",
  "artifactId": "artifact-id",
  "version": 3,
  "parentId": null,
  "authorUserId": "user-record-id",
  "authorLabel": "User Name",
  "sourceAgent": "mcp",
  "body": "Please add a test for the empty-input case.",
  "anchor": { "line": 42 },
  "status": "open",
  "createdAt": "2026-06-24T00:00:00.000Z",
  "resolvedAt": null,
  "resolvedBy": null,
  "deletedAt": null
}
```

- `version`을 생략하면 아티팩트의 `latestVersion`을 사용합니다.
- `body`는 Markdown이며 16 KB로 제한합니다(`MAX_COMMENT_BYTES`). 뷰어는 Markdown 형식 아티팩트와 같은 렌더러로 위험 요소를 제거한 뒤 표시합니다.
- `anchor`는 선택 사항이며 형식에 따라 다릅니다. 텍스트 형식은 `{ "line": 42 }`, JSON/SARIF는 `{ "path": "$.runs[0].results[3]" }`, CSV는 `{ "row": 7 }`을 사용합니다. 렌더링을 위한 힌트일 뿐이며 실제 아티팩트 콘텐츠와 일치하는지 검증하지 않습니다.
- 답글은 한 단계까지만 허용합니다. `parentId`를 지정한다면 자체 `parentId`가 없는 최상위 댓글을 가리켜야 합니다. 답글에 다시 답글을 달면 `code: "THREAD_TOO_DEEP"`를 반환합니다.
- `status`는 `"open"` 또는 `"resolved"`입니다. 해결 처리를 통해 설정하며, 이때 `resolvedAt`/`resolvedBy`도 채웁니다.
- 댓글을 삭제해도 실제 행은 지우지 않고 삭제 상태로 표시합니다. Artifacty는 `deletedAt`을 설정하고, 기본적으로 `listComments`와 `GET .../comments` 결과에서 해당 행을 숨깁니다. 삭제된 댓글을 요청하려면 `includeDeleted: true`를 전달하세요. 인증된 접근에서는 관리자가 읽을 수 있는 아티팩트의 삭제된 댓글을 모두 볼 수 있습니다. 다른 사용자는 자신이 작성한 삭제된 댓글만 볼 수 있습니다. 로컬 단일 사용자 모드와 신뢰하는 코드의 저장소 직접 접근에는 이 작성자 제한을 적용하지 않습니다. 댓글 행과 `comment-delete` 감사 기록은 보존합니다.
- 댓글을 읽으려면 해당 아티팩트에 접근할 수 있어야 합니다. 비공개 사이트 모드에서 댓글을 작성하려면 댓글·편집 권한이 있거나 소유자·관리자여야 합니다. 댓글 권한을 받은 사용자는 자신의 댓글을 해결 처리할 수 있습니다.
- `author_label`은 호출자의 감사 컨텍스트에서 가져옵니다. 인증된 사용자의 표시 이름이나 이메일을 사용하고, 없으면 게시자 ID, `sourceAgent`, `"anonymous"` 순서로 대체합니다.

HTTP에서는 `GET`/`POST /api/artifacts/:id/comments`, `POST /api/artifacts/:id/comments/:commentId/resolve`, `DELETE /api/artifacts/:id/comments/:commentId`로 댓글을 관리합니다. MCP에서는 `artifacty_comment`와 `artifacty_resolve_comment`가 같은 역할을 합니다. MCP의 `artifacty_get`에는 추가로 `includeComments: true`를 전달해 요청한 버전의 미해결 댓글을 아티팩트와 함께 받을 수 있습니다. HTTP에는 같은 플래그가 없으므로 `GET /api/artifacts/:id/comments`를 별도로 호출해야 합니다.

## 아카이브 동작

아카이브하면 `archivedAt`을 설정하고 기본 목록 결과에서 아티팩트를 숨깁니다. 아카이브된 레코드까지 포함하려면 `includeArchived=true`를 사용하세요. 복원하면 `archivedAt`을 지웁니다. 일반적인 아카이브·복원 작업은 아티팩트를 삭제하거나 버전 파일을 변경하지 않습니다. 관리자는 `/admin/artifacts/:id/versions`에서 개별 버전을 복구하거나 삭제할 수 있지만, 마지막 남은 버전은 삭제할 수 없습니다.

## 번들 형식

번들은 `artifactType: "bundle"`인 JSON 아티팩트입니다. 콘텐츠 유형은 `application/vnd.artifacty.bundle+json; charset=utf-8`입니다.

```json
{
  "schemaVersion": 1,
  "artifactType": "bundle",
  "title": "Patch bundle",
  "files": [
    {
      "path": "README.md",
      "content": "# Readme",
      "contentType": "text/markdown; charset=utf-8",
      "sizeBytes": 8,
      "sha256": "..."
    }
  ]
}
```

Gemini 멀티모달 payload도 같은 번들 유형을 사용하며, `parts`와 `assets`를 포함합니다.

### 문서 자산

`files` 항목은 인라인 텍스트 대신 바이너리 문서 콘텐츠를 담을 수 있습니다. 이때 `encoding: "base64"`와 허용된 바이너리 유형의 `contentType`을 설정합니다. 허용 유형은 `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`(`.docx`), `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`(`.xlsx`), `application/zip`입니다. `content`에는 base64로 인코딩한 바이트가 들어가며, `sizeBytes`와 `sha256`은 *디코딩한* 바이트를 설명합니다.

```json
{
  "path": "report.pdf",
  "contentType": "application/pdf",
  "encoding": "base64",
  "content": "JVBERi0xLjQ...",
  "sizeBytes": 20480,
  "sha256": "..."
}
```

모든 쓰기 작업(`createArtifact`/`updateArtifact` 및 `convertAgentArtifact`를 통한 변환)에는 다음 규칙을 적용합니다.

- 각 바이너리 파일 항목은 디코딩 후 32 MiB로 제한합니다. 저장되는 번들 JSON 전체에는 고정된 16 MiB `MAX_ARTIFACT_BYTES` 한도도 적용합니다. 크기는 UTF-8 바이트로 계산하며, base64 텍스트도 포함합니다. 개별 파일 한도가 더 크더라도 전체 아티팩트 한도를 넘을 수 없습니다. 실행 시 설정으로 이 한도를 늘릴 수는 없습니다.
- `path` 또는 `name`은 안전한 상대 경로여야 합니다. `..` 구간, 절대 경로, 드라이브 문자로 시작하는 경로, 제어 문자를 허용하지 않습니다.
- 바이너리 항목의 `contentType`이 허용 목록에 없으면 거부합니다.
- 바이너리 파일 콘텐츠와 바이너리 자산의 `data`는 텍스트가 아니므로 비밀정보 검사를 건너뜁니다. 다만 파일·자산 이름과 `files`/`assets`의 비바이너리 텍스트 콘텐츠는 계속 검사합니다.

뷰어는 PDF 항목을 `GET /artifacts/:id/raw?file=<path>`를 가리키는 샌드박스 iframe에 표시합니다. 이 프레임에는 `allow-same-origin`과 스크립트를 허용하지 않습니다. 다른 문서 유형에는 메타데이터와 다운로드 링크를 표시합니다. 다운로드 링크도 같은 경로를 사용합니다. 이 경로는 항목의 `contentType`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`를 응답에 포함합니다. PDF에는 `Content-Disposition: inline`, 그 외에는 `attachment`를 사용합니다. 다른 아티팩트 읽기와 동일한 `access` 규칙을 적용하며, 호출자에게 아티팩트 읽기 권한이 없거나 `file` 이름을 찾을 수 없으면 404를 반환합니다.

## 자산 정책

번들 JSON은 base64 자산을 인라인으로 보존합니다. 각 자산은 `encoding: "base64"`, `mimeType`, `sizeBytes`, `sha256`을 가집니다. 이를 사용하는 쪽은 디코딩된 자산을 신뢰할 수 없는 콘텐츠로 취급해야 합니다.

독립적인 `image`와 `video` 아티팩트는 변경 불가능한 버전 파일에 base64 콘텐츠를 저장합니다. 가져오기 도구는 `metadata.encoding: "base64"`와 지원되는 미디어 유형 중 하나인 `metadata.mimeType`을 설정하는 것이 좋습니다. 브라우저의 `/raw`는 저장된 base64를 바이트로 디코딩하고 미디어 콘텐츠 유형으로 응답합니다. API와 MCP 읽기는 저장된 base64 문자열을 반환합니다. 지원하는 미디어 유형은 PNG, JPEG, GIF, WebP, MP4, WebM입니다. 대용량 바이너리를 외부로 분리하는 기능은 의도적으로 보류했습니다. 스키마 v1은 변환된 자산을 직접 확인하고 다른 환경으로 옮길 수 있도록 유지합니다.
