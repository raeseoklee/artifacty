[English](../network-sharing.md) | 한국어

<!-- 번역 기준: 9e73a9f -->

# 네트워크 공유

Artifacty는 아티팩트를 로컬에 저장합니다. 기본적으로 서버는 한 컴퓨터에서 사용하도록 `127.0.0.1`에 바인딩합니다. 짧은 공유 세션을 위해 로컬 외부 주소에 바인딩할 수 있습니다. 이 경우 다른 컴퓨터에서도 서버에 접근할 수 있습니다.

## 권장 기본 설정

일상적인 작업에는 로컬 서버를 사용하세요.

```bash
artifacty serve
```

신뢰할 수 있는 LAN이나 사설 VPN의 다른 장치에서 읽기 접근이 필요하면 특정 인터페이스 주소에 바인딩하세요. 모든 인터페이스에서 수신하는 설정은 피하세요.

```bash
artifacty serve --host 192.168.1.20 --share-mode lan --generate-token
```

중앙 내부 MCP 서버를 운영하려면 `/mcp`를 명시적으로 활성화하세요. 클라이언트는 `--mcp-url`과 `/account`에서 발급한 개인 토큰으로 설치하세요.

```bash
ARTIFACTY_BOOTSTRAP_TOKEN="$(artifacty token --raw)"
artifacty serve --host 10.0.0.50 --share-mode team --api-token "$ARTIFACTY_BOOTSTRAP_TOKEN" --mcp-http --foreground
# Open /login to create the first admin, then /account to issue a personal token.
artifacty install all --mcp-url http://10.0.0.50:8787/mcp --api-token "$ARTIFACTY_PERSONAL_TOKEN"
```

모든 네트워크 인터페이스에서 Artifacty가 연결을 받도록 하려는 경우에만 `0.0.0.0`을 사용하세요.

```bash
artifacty serve --host 0.0.0.0 --share-mode lan --generate-token
```

## 필수 보호 조치

로컬 외부 주소에 바인딩하기 전에 `ARTIFACTY_SHARE_MODE=lan|team`과 API 토큰을 모두 설정하세요. Artifacty는 이 설정이 없으면 시작하지 않습니다.

생성된 토큰은 HTTP API 경로와 브라우저 쓰기 폼을 보호합니다. 스크립트에는 `x-artifacty-token` 또는 `Authorization: Bearer <token>` 헤더를 사용하세요. 로컬 포그라운드 세션에서는 `?token=...` URL을 사용할 수 있습니다. 이 URL은 브라우저 기록, 셸 기록, 리버스 프록시 로그, 리퍼러에 토큰을 노출할 수 있습니다.

Artifacty는 TLS 연결을 직접 처리하지 않습니다. 인터넷에 직접 노출하지 마세요. 공유 인스턴스가 신뢰할 수 없는 네트워크를 거쳐야 한다면 TLS 리버스 프록시 뒤에 배치하거나 사설 VPN을 사용하세요.

루프백 외부 주소에 바인딩하면 시작 출력에 다른 컴퓨터가 서버에 접근할 수 있다는 경고가 표시됩니다. 이 경고에는 Artifacty가 TLS를 제공하지 않는다는 내용도 포함됩니다. 백그라운드 `serve`는 경고를 JSON으로 반환합니다. 포그라운드 `serve`와 `src/server.js`는 stderr에도 경고를 출력합니다.

## 브라우저 쓰기 동작

원격 브라우저는 현재 접근 모드와 아티팩트 권한에서 허용하는 페이지를 읽을 수 있습니다. 브라우저 폼을 제출하려면 요청의 Origin이 Artifacty 호스트와 일치해야 합니다. 예를 들어 `Origin: http://10.0.0.50:8787`은 `Host: 10.0.0.50:8787`과 일치합니다. 데이터를 변경하는 경로는 CSRF 위험을 줄이기 위해 다른 출처의 브라우저 요청을 거부합니다. 스크립트와 에이전트는 명시적인 토큰 헤더를 사용하는 API 또는 MCP 쓰기 요청을 사용하세요.

Origin 검사를 유지하세요. 중앙 대시보드의 Origin이 서버와 일치하면 쓰기 요청이 성공해야 합니다. 다른 웹사이트의 쓰기 요청은 `NON_LOCAL_ORIGIN` 오류로 실패해야 합니다.

## 렌더러 운영 지침

아티팩트 콘텐츠를 신뢰할 수 없는 입력으로 취급하세요. Artifacty는 샌드박스와 CSP로 HTML, SVG, Mermaid, React 렌더링을 제어합니다. 이러한 보호 조치가 있어도 공유 콘텐츠는 각 사용자의 브라우저에 전달됩니다. 모든 사용자가 아티팩트 출처를 신뢰하는 경우가 아니면 LAN 세션에서 `ARTIFACTY_ENABLE_REACT_RENDERER`를 비활성 상태로 유지하세요.

전체 신뢰 경계 요약은 [위협 모델](threat-model.md)을 참고하세요.

여러 MCP 클라이언트가 하나의 중앙 Artifacty 인스턴스를 장기간 공유하는 내부 배포는 [중앙 팀 배포 설계(영문)](../central-team-deployment-design.md)를 참고하세요.
