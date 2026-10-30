[English](../mcp-public-api.md) | 한국어

<!-- 번역 기준: 9e73a9f -->
<!-- 문장·의미 대조: 2026-10-20, 영문 동시 개정본 기준 -->
<!-- 컬렉션·카테고리·작성 이력 문서 대조: 2026-10-30 영문 동시 개정본 -->

# MCP 공개 API

Artifacty의 MCP 서버는 에이전트 간 연동을 위한 기본 인터페이스입니다. 기본적으로 로컬 stdio MCP를 사용합니다. 브라우저 서버에서 토큰으로 보호된 HTTP `/mcp` 엔드포인트를 제공할 수도 있습니다. stdio 브리지 모드를 사용하면 클라이언트의 로컬 stdio 설정으로 중앙 Artifacty 서버에 쓸 수 있습니다. 서버가 대상으로 하는 MCP 프로토콜 버전은 `2025-06-18`입니다.

## 기능

`initialize`는 다음 기능을 알립니다.

- `tools`: 아티팩트 생성, 가져오기, 목록 조회, 읽기, 수정, 아카이브, 복원, 관계 연결·해제, 비교, 감사 조회, 정보 조회입니다.
- `resources`: 정적·동적 읽기 전용 아티팩트 리소스입니다. `subscribe: true`와 `listChanged: true`를 포함합니다.
- `prompts`: 재사용할 수 있는 작업 흐름 프롬프트 템플릿입니다.

## 공개 범위와 접근 제어

관리자는 `/admin/access`에서 사이트 전체 접근 모드를 `public` 또는 `private`으로 선택할 수 있습니다. 공개 모드에서는 아래의 공개 범위 규칙을 유지합니다. 비공개 모드에서는 아티팩트의 공개 범위와 관계없이 개인 사용자 식별 정보가 필요합니다. 아티팩트를 읽을 수 있는 사람은 소유자, 관리자, 명시적으로 공유받은 사용자 또는 팀 구성원으로 제한합니다. 공유받은 사용자는 읽기, 댓글, 편집 권한 중 하나를 가집니다. 사용자에게 직접 부여된 권한과 팀을 통해 부여된 권한 중 가장 높은 권한을 적용합니다.

댓글 권한으로 피드백을 남기고 자신의 댓글을 해결 처리할 수 있습니다. 편집 권한으로는 새 버전도 추가할 수 있습니다. 공유, 아카이브·복원, 리뷰 상태 관리는 소유자와 관리자만 수행할 수 있습니다. stdio 브리지를 포함한 HTTP 전송에서는 토큰 범위를 추가 제한으로 적용합니다. 사용자에게 편집 권한이 있어도 읽기 범위의 토큰으로는 변경 작업을 수행할 수 없습니다. 신뢰할 수 있는 로컬 stdio는 토큰 범위를 검사하지 않지만, 식별된 사용자의 아티팩트 접근 권한은 적용합니다.

비공개 모드에서는 공유 서버 토큰이나 익명 stdio 연결로 아티팩트를 읽거나 생성할 수 없습니다. 에이전트 접근에는 개인 API 토큰을 사용하세요. 공유를 취소하거나 팀 구성원을 제거하면 이후 리소스 읽기, 검색, 실시간 알림에 반영됩니다. HTTP 전송은 관리자의 IP/CIDR 허용 목록도 따릅니다. 전달 헤더가 아닌 TCP 연결 상대의 주소를 사용하며, 로컬 stdio에는 HTTP 출발지 주소가 없습니다.

공개 모드에서는 서버에 사용자 계정이 생긴 뒤부터 아티팩트의 `visibility`와 `ownerUserId`로 접근을 제어합니다. 개인 API 토큰은 사용자를 식별합니다. 공유 `ARTIFACTY_API_TOKEN`은 개인 사용자를 식별하지 않습니다. Artifacty는 이를 익명 호출자로 취급합니다. 익명 호출자는 `public` 아티팩트를 읽을 수 있지만 수정할 수는 없으며, `team`이나 `private` 아티팩트는 읽을 수 없습니다. 인증된 사용자는 `team` 아티팩트를 읽고 수정할 수 있습니다. 단, `ARTIFACTY_TEAM_WRITE=owner`를 설정하면 팀 아티팩트의 쓰기 권한은 소유자와 관리자로 제한됩니다. `public` 아티팩트를 수정하거나 일반 아티팩트 경로로 `private` 아티팩트에 접근하려면 소유자나 관리자여야 합니다.

로컬 stdio는 `ARTIFACTY_API_TOKEN`이 로컬 저장소의 개인 토큰으로 확인될 때만 개인 사용자를 식별합니다. 그렇지 않으면 사용자 계정이 있는 저장소에서 익명으로 취급합니다. 사용자 계정이 생기기 전에는 공개 모드에서 이러한 사용자 접근 검사를 적용하지 않습니다.

호출자가 아티팩트를 읽을 수 없으면 `artifacty_get`과 리소스 읽기는 `ARTIFACT_NOT_FOUND`를 반환하고, 목록 결과에서는 해당 아티팩트를 제외합니다. 아티팩트의 존재 자체가 노출되지 않도록 하는 규칙입니다. 읽기 권한은 있지만 필요한 쓰기 또는 관리 권한이 없으면 도구 결과에 `structuredContent.code === "forbidden"`을 포함합니다. 전체 권한 표는 [README의 보안 모델](../../README.ko.md)을 참조하세요.

## 도구

안정적으로 유지하는 도구 이름은 다음과 같습니다.

- `artifacty_create`: 네이티브 Artifacty 아티팩트를 생성합니다. 선택적인 `relations` 배열(`[{ toId, relation }]`)로 같은 호출에서 새 아티팩트를 다른 아티팩트와 연결할 수 있습니다. 선택적인 `visibility`도 받습니다. 값은 `"private"`, `"team"`, `"public"` 중 하나이며, 기본값은 `"team"`입니다.
- `artifacty_publish`: 이전 버전과의 호환성을 위한 `artifacty_create`의 별칭입니다.
- `artifacty_import`: 외부 Claude, Codex, Gemini, Copilot, Cursor, Artifacty 또는 일반 payload를 변환합니다.
- `artifacty_list`: `query`, `tag`, `sourceAgent`, `artifactType`, `publisher`, `createdAfter`, `createdBefore`, `reviewStatus`, `relatedTo`, `relation`, `mode`, `includeArchived`, `view`, `limit`, `offset`으로 아티팩트 목록을 조회합니다. `relatedTo`는 지정한 아티팩트 ID와 어느 방향으로든 관련된 아티팩트로 결과를 제한하며, `relation`은 지정한 관계 이름으로 추가 제한합니다. `publisher`는 `publisherId`, `publisherUserId`, `ownerUserId`와 일치하는 항목을 찾습니다. `createdAfter`/`createdBefore`는 ISO 날짜 또는 날짜·시간을 받습니다. 파싱할 수 없으면 `isError: true` 결과와 `structuredContent.code === "invalid_filter"`를 반환합니다. `view`는 ID 또는 이름으로 저장된 뷰를 지정합니다([영문 로드맵 8절](../roadmap-design.md#8-dashboard-filters-and-saved-views) 참조). 먼저 해당 뷰의 필터를 적용한 다음, `view`와 함께 전달된 다른 인수로 해당 필터만 덮어씁니다. `mode`는 `"keyword"`, `"semantic"`, `"hybrid"` 중 하나입니다([영문 로드맵 6절](../roadmap-design.md#6-semantic-search) 참조). `query`를 지정하면 `hybrid`가 기본값이며, 다른 제공자를 선택하지 않으면 기본 포함 ONNX 모델을 사용합니다([임베딩 안내](embeddings.md) 참조). 임베딩을 끄거나 사용할 수 없으면 `semantic`/`hybrid`는 별도 오류 없이 `keyword`로 대체되며, 응답의 `search.fallback`은 `true`가 됩니다. 응답에는 `search.mode`가 포함됩니다. `semantic`/`hybrid` 결과에는 아티팩트별 `searchScore`도 포함됩니다.
- `artifacty_get`: `id`와 선택적인 `version`으로 아티팩트 하나를 읽습니다. 응답에는 `relations: { outgoing, incoming }`이 포함됩니다. 각 항목에는 관련 아티팩트의 요약이 들어가며, 대상이 더 이상 없으면 `missing: true`를 포함합니다. `includeComments: true`를 전달하면 요청한 버전의 열린 댓글, 즉 미해결 상태이면서 삭제되지 않은 댓글을 `comments`로 함께 반환합니다. 기본적으로 댓글은 포함하지 않습니다.
- `artifacty_update`: 변경 불가능한 버전을 추가합니다. 선택적인 `expectedVersion`을 받으며, 여기에 `artifacty_get`이 반환한 `latestVersion`을 전달합니다. 그 사이 아티팩트가 다른 `latestVersion`으로 바뀌었다면 새 버전을 생성하지 않습니다. 대신 `isError: true` 도구 결과에 `structuredContent.code === "version_conflict"`와 `structuredContent.latestVersion`을 포함합니다. 이를 통해 동시에 이루어진 다른 변경 사항이 알림 없이 덮어써지는 일을 방지합니다. 에이전트는 수정할 때 마지막 `artifacty_get`의 `latestVersion`을 `expectedVersion`으로 전달하는 것이 좋습니다. `artifacty_create`와 같은 선택적 `relations` 배열도 받습니다.
- `artifacty_archive` / `artifacty_restore`: 아카이브 상태를 전환합니다. 사용자 계정이 하나라도 있으면 아티팩트 소유자 또는 관리자여야 합니다.
- `artifacty_set_visibility`: `id`의 `visibility`를 `"private"`, `"team"`, `"public"` 중 하나로 변경합니다. 사용자 계정이 하나라도 있으면 아티팩트 소유자 또는 관리자여야 합니다.
- `artifacty_link`: 한 아티팩트(`id`)에서 다른 아티팩트(`toId`)로 유형과 방향이 있는 관계를 만듭니다. `relation` 이름은 `derived-from`, `supersedes`, `reviews`, `references`, `part-of` 중 하나입니다.
- `artifacty_unlink`: 동일한 `id`, `toId`, `relation`을 지정해 기존 관계를 제거합니다.
- `artifacty_comment`: 아티팩트(`id`)에 댓글이나 답글을 추가합니다. `body`는 Markdown이며 최대 16 KB입니다. 선택적으로 `version`(기본값은 최신 버전), `anchor`(형식별 렌더링 힌트로, 예를 들어 `{ line: 42 }`이며 콘텐츠와 일치하는지 검증하지 않음), `parentId`를 받습니다. 답글은 최상위 댓글에만 달 수 있습니다. 스레드 깊이는 한 단계이므로 대상 댓글이 답글이어서는 안 됩니다.
- `artifacty_resolve_comment`: 댓글(`id`, `commentId`)을 해결 상태로 표시합니다.
- `artifacty_set_review_status`: 아티팩트(`id`)의 `status`를 `none`, `pending`, `changes-requested`, `approved` 중 하나로 설정합니다. 사용자 계정이 하나라도 있으면 아티팩트 소유자 또는 관리자여야 합니다. `approved` 이후 새 버전이 추가되면 자동으로 `pending`으로 되돌리고, 해당 수정의 감사 메타데이터에 기록합니다.
- `artifacty_diff`: `id`와 선택적인 `from`/`to`로 아티팩트의 두 버전을 비교합니다. 기본값은 `to` = 최신 버전, `from` = `to - 1`입니다. `view`는 `structured` 또는 `lines`입니다. JSON 계열 형식인 `json`, `sarif`, `csv`, `notebook`, `bundle`에서는 `structured`가 기본값이고, 그 외에는 `lines`가 기본값입니다. `content[].text`에 간결한 unified diff 텍스트를 반환하고, `structuredContent`에 구조화된 diff를 반환합니다. 구조화된 결과에는 JSON 경로 항목, CSV 행·셀 항목, 단어 단위 강조 범위가 포함된 줄 항목, 번들의 파일별 항목이 들어갑니다. 결과 수는 `ARTIFACTY_MAX_DIFF_ENTRIES`로 제한하며 기본값은 5000입니다. 한도에 도달하면 `structuredContent.structuredDiff.truncated`를 설정합니다.
- `artifacty_audit`: 감사 이벤트 목록을 조회합니다.
- `artifacty_info`: 저장소, 브라우저 URL, 전송 방식, 프로토콜 정보를 반환합니다. 의미 검색용 임베딩 제공자의 설정 여부를 알리는 `embeddings: { provider, model } | null`도 포함합니다.
- `artifacty_wait`: `{ artifactId?, tag?, type?, timeoutMs }`로 필터와 대기 시간을 지정합니다. `timeoutMs` 동안 필터와 일치하는 첫 변경 이벤트를 기다리며, 기본값은 30000, 최댓값은 120000입니다. 이벤트가 오면 `structuredContent.event`로 반환하고, 시간 안에 오지 않으면 `{ timedOut: true }`를 반환합니다. 모든 전송 방식에서 작동합니다. `resources/subscribe`가 알림을 푸시할 수 없는 상태 비저장 HTTP 전송도 포함합니다(아래 리소스 절 참조). 푸시 알림을 받을 수 없는 클라이언트가 사용할 수 있는 롱 폴링 기능입니다.

도구 스키마는 Artifacty 스키마 v1의 형식과 아티팩트 유형을 사용합니다. 0.x 릴리스에서는 유지보수 담당자가 선택적 속성을 추가할 수 있습니다. 기존 속성의 이름은 마이그레이션을 문서화하지 않고 변경하지 않는 것이 좋습니다.

저장소 검증 오류와 찾을 수 없음 오류에는 프로그램에서 처리할 수 있는 `code`가 포함됩니다. 관계와 댓글 오류도 여기에 해당합니다. `tools/call`은 JSON-RPC 프로토콜 오류 대신 `isError: true` 도구 결과와 `structuredContent.code`를 반환합니다. 오류 코드에는 `INVALID_RELATION`, `SELF_RELATION`, `ARTIFACT_NOT_FOUND`, `RELATION_NOT_FOUND`, `COMMENT_NOT_FOUND`, `THREAD_TOO_DEEP`, `COMMENT_TOO_LARGE`, `INVALID_REVIEW_STATUS` 등이 있습니다. 클라이언트는 오류 메시지 텍스트를 파싱하지 않고 코드를 사용할 수 있습니다.

## 컬렉션과 작성 정보 — 다음 릴리스

이 추가 기능은 배포된 0.16.1에는 포함되지 않습니다.

- `artifacty_collection_create`: `title`, 선택적 `description`, `sections`로 컬렉션을 만듭니다. 각 섹션에는 `id`, `title`, `items`가 있습니다. 항목은 `artifactId`를 참조하며, `version`은 `"latest"` 또는 양의 버전 번호, `display`는 `"inline"` 또는 `"card"`입니다.
- `artifacty_collection_update`: `id`, 전체 섹션 목록, 마지막으로 읽은 `expectedVersion`으로 컬렉션의 새 버전을 만듭니다. 버전이 오래되었으면 충돌을 반환합니다. 기존 참조를 사용할 수 없다면 접근 권한을 복구하거나 `dropUnavailableReferences: true`를 명시해 새 버전에서 제거하세요. 이전 버전은 유지됩니다.
- `artifacty_get`과 아티팩트 리소스로 기존 인터페이스에서 컬렉션을 읽습니다. 컬렉션에 접근할 수 있어도 포함된 아티팩트의 권한까지 생기지 않습니다. 읽을 수 없는 참조는 반환된 컬렉션 콘텐츠에서 제외합니다.

생성, 가져오기, 업데이트, 컬렉션 도구에는 `provenance: { tool, provider, model }`을 전달할 수 있습니다. 실제 값을 사용하고 모르는 필드는 생략하세요. 서버는 요청 컨텍스트에서 사용자 정보를 가져오므로, 클라이언트의 작성 정보로 다른 사용자를 지정할 수 없습니다. `createdBy`는 최초 작성자, `version.provenance`는 선택한 버전의 작성자입니다. 아티팩트 수준의 `provenance`는 최신 버전의 정보를 나타냅니다.

stdio에서는 `initialize`에 선언한 클라이언트 이름으로 도구를 식별할 수 있습니다. 이 이름은 클라이언트의 선언이며 검증된 소프트웨어 신원은 아닙니다. 모델 식별자도 자체 신고한 값입니다. 상태를 유지하지 않는 HTTP와 브리지 요청에는 이전 초기화의 클라이언트 정보가 보존되지 않습니다. 전체 컬렉션 호출 예시와 작성 정보는 [아티팩트 정리와 작성 이력](organizing-artifacts.md)을 참고하세요.

## 리소스

정적 리소스는 다음과 같습니다.

- `artifacty://recent`: 페이지네이션과 브라우저 URL을 포함하는 최근 아티팩트의 JSON 목록입니다.
- `artifacty://schema/v1`: Artifacty 스키마 v1의 Markdown 참조 문서입니다.

리소스 템플릿은 다음과 같습니다.

- `artifacty://artifacts/{id}`: JSON 아티팩트 메타데이터, 선택한 버전, 콘텐츠, URL입니다.
- `artifacty://artifacts/{id}/raw{?version}`: 최신 버전 또는 지정한 버전의 아티팩트 원본 콘텐츠입니다.
- `artifacty://artifacts/{id}/graph`: 관계를 따라 `{id}`에서 도달할 수 있는 아티팩트를 깊이 2의 JSON 인접 목록으로 반환합니다. 형태는 `{ rootId, nodes, edges }`이며, `nodes`는 아티팩트 요약이고 각 간선은 `{ from, to, relation }`입니다.

리소스는 읽기 전용이며, 아티팩트 콘텐츠를 읽을 때 `read` 감사 이벤트를 기록할 수 있습니다.

### 구독

`resources/subscribe`는 `{ uri }`를 받습니다. URI로 `artifacty://artifacts/{id}`를 지정하면 해당 아티팩트만, `artifacty://recent`를 지정하면 모든 아티팩트를 구독합니다. 구독 중에 일치하는 변경 이벤트가 발생하면 같은 `{ uri }`와 함께 `notifications/resources/updated`를 전송합니다. `resources/unsubscribe`도 같은 `{ uri }` 형식을 받으며 알림 전송을 중단합니다.

구독 알림은 **stdio 전송**에서만 전달합니다. MCP 컨텍스트 하나가 프로세스 전체 수명 동안 유지되며 stdout으로 알림을 씁니다.

streamable-HTTP `/mcp` 전송은 POST 요청마다 상태를 유지하지 않는 JSON-RPC 컨텍스트를 만듭니다. stdio 브리지(`ARTIFACTY_MCP_MODE=bridge`)도 같은 HTTP 전송을 사용합니다. 서버가 응답을 보낸 뒤에는 푸시 알림을 보낼 연결이 남지 않습니다. 이 전송 방식들은 프로토콜 요구에 따라 `resources/subscribe`를 수락하지만 알림은 전달하지 않습니다. 클라이언트는 `artifacty_wait`로 요청 하나 안에서 시간 제한이 있는 롱 폴링을 수행하는 것이 좋습니다. 또는 `artifacty_list`로 주기적으로 조회할 수 있습니다.

## 프롬프트

프롬프트 이름은 다음과 같습니다.

- `artifacty_handoff`
- `artifacty_review`
- `artifacty_test_report`
- `artifacty_visual_qa`
- `artifacty_release_notes`

각 프롬프트는 사용자 메시지 하나를 반환합니다. 이 메시지는 검색 가능한 `artifactType`, `sourceAgent`, 태그를 포함해 아티팩트를 생성하거나 수정하도록 에이전트에 지시합니다. 프롬프트는 `artifactId`, `goal`, `scope`, `target`, `version` 같은 선택적 컨텍스트 인수를 받습니다.

`artifacty_handoff`와 `artifacty_review`는 생성·수정 호출에 `relations`를 전달하도록 추가로 지시해 Artifacty가 관계 그래프를 자동으로 구성하도록 합니다. `artifacty_handoff`는 `relations: [{ toId: <source artifact ID>, relation: "derived-from" }]`를, `artifacty_review`는 `relations: [{ toId: <reviewed artifact ID>, relation: "reviews" }]`를 권장합니다.

발견 사항이 몇 개뿐인 짧은 리뷰에서는 `artifacty_review`가 `artifacty_comment`를 권장합니다. 리뷰 판단을 기록할 때는 `artifacty_set_review_status`를 권장합니다. 긴 리뷰와 여러 파일을 대상으로 하는 리뷰는 별도의 리뷰 아티팩트를 사용합니다.

## OpenAPI

OpenAPI 3.1 문서는 모든 `/api/*` HTTP 경로와 `/mcp` JSON-RPC 엔드포인트를 설명합니다. HTTP 경로에는 아티팩트, 버전, 가져오기, 감사, 관리자 백업이 포함됩니다.

- `GET /openapi.json`: 프로그램에서 처리할 수 있는 문서입니다. 인증이 필요하지 않습니다. `cache-control: no-store`로 제공하므로 실행 중인 서버의 경로 구성을 항상 반영합니다.
- `GET /docs/api`: 같은 문서에서 생성한 서버 렌더링 HTML 참조 페이지입니다. 외부 UI 번들이나 CDN에 의존하지 않습니다.
- MCP 도구 `artifacty_info`와 `artifacty doctor`는 문서 URL을 `<serverUrl>/openapi.json`으로 알립니다.

문서는 MCP 도구의 `outputSchema` 정의에 있는 JSON 스키마를 사용합니다(`src/lib/schemas.js` 참조). 따라서 HTTP API와 MCP 도구는 같은 아티팩트 요약, 전체 아티팩트 레코드, 버전, 감사 이벤트, 관계 항목을 사용합니다. 오류 형식도 `{ error, code?, details? }`로 같습니다. `test/openapi.test.js`는 문서의 경로 테이블과 `src/server.js`의 요청 분기가 일치하는지 검증합니다.

## 호환성 참고 사항

### 프로토콜 버전 호환성 표

| 클라이언트가 요청한 `protocolVersion` | 서버 동작 |
| --- | --- |
| `2025-06-18` | 같은 값을 반환합니다. 공개 MCP 명세에 대해 구현 검증을 마친 유일한 프로토콜 버전입니다. |
| 그 외의 값(이전 버전 또는 서버에서 아직 검증하지 않은 새 버전) | 연결을 거부하는 대신 `initialize` 응답에서 `2025-06-18`로 대체합니다. 이를 통해 서버가 모르는 버전의 클라이언트도 사용할 수 있는 세션을 받습니다. |

`tools/list`는 `structuredContent`를 반환하는 모든 도구에 `outputSchema`를 제공합니다. 스키마는 앞에서 설명한 공유 스키마 테이블에서 생성합니다.

- 로컬 stdio가 기본값입니다. `artifacty serve --mcp-http`로 중앙 HTTP 엔드포인트를 활성화하고, `artifacty install <agent> --mcp-url http://host:8787/mcp --api-token <token>`으로 브리지 모드를 설치하세요.
- 중앙 서버에서는 `/account`에서 만든 개인 토큰을 사용하세요. 생성된 아티팩트의 `publisherId`에 토큰 소유자의 이메일이 포함되고, 감사 로그의 `actor`에도 같은 사용자가 기록됩니다.
- 원격 MCP는 bearer 또는 헤더 토큰 인증을 사용합니다. 개인 토큰은 `read`, `write`, `admin` 범위를 지원합니다. OAuth는 지원하지 않습니다.
- 바이너리 미디어 리소스는 MCP를 통해 저장된 base64 텍스트를 반환합니다. 브라우저의 `/raw`는 독립적인 `image`와 `video` 아티팩트를 바이트로 디코딩합니다.
- 클라이언트마다 리소스와 프롬프트를 표시하는 방식이 다를 수 있습니다. 도구는 Claude, Codex, Gemini, Copilot, Cursor 전반에서 가장 널리 지원되는 연동 방식입니다.
