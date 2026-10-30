[English](../release-checklist.md) | 한국어

<!-- 번역 기준: 9e73a9f -->
<!-- 문장·의미 대조: 2026-10-20, 영문 동시 개정본 기준 -->

# 릴리스 체크리스트

Artifacty를 게시하거나 배포하기 전에 이 체크리스트를 사용하세요.

## 수동 CI와 배포

일반 푸시, PR, 릴리스 생성, 주간 예약으로는 워크플로를 실행하지 않습니다. 개발 중에는 로컬 검사를 사용하고, 배포 후보가 정해지면 다음 순서로 진행하세요.

1. 후보 브랜치나 태그에서 **Release candidate** 워크플로(`verify.yml`)를 수동 실행하세요. Linux·macOS·Windows 검사와 CodeQL·Scorecard를 실행하며, npm에는 게시하지 않습니다.
2. 전체 실행이 성공할 때까지 기다리세요. 마지막 작업에서 npm 패키지와 체크섬을 14일간 보관합니다. 실행 요약의 실행 ID와 커밋 SHA를 기록하세요.
3. 같은 커밋을 가리키는 브랜치나 태그에서 **Publish**(`publish.yml`)를 별도로 실행하세요. `verification_run_id`에 성공한 후보 검증의 실행 ID를 입력하세요.
4. Publish는 워크플로 종류, 저장소, 성공 여부, 커밋 일치를 확인합니다. 해당 검증 시도의 패키지를 내려받아 재빌드나 패키지 라이프사이클 스크립트 실행 없이 게시합니다. 기존 OIDC Trusted Publishing 인증은 유지합니다.

선택한 커밋이 바뀌면 후보 검증을 다시 실행하세요. 보관된 패키지가 만료되거나 삭제된 경우에도 다시 검증해야 합니다. GitHub Release를 만드는 것만으로는 패키지가 게시되지 않습니다. **Security**는 배포와 별개로 수동 실행할 수도 있습니다. 주간 예약은 해제하며, 후보 검증에서는 자동으로 호출합니다. Scorecard 결과는 GitHub 코드 검사에 남기고, 외부 Scorecard 서비스로의 자동 결과 게시는 비활성화합니다.

수동 실행을 사용하려면 먼저 워크플로 파일을 커밋해 기본 브랜치에 반영해야 합니다. 브랜치 보호 규칙이 모든 PR의 검사를 요구하고 있다면 이 수동 검증 절차에 맞게 정책을 검토하세요. 워크플로 파일만으로 저장소 규칙이 바뀌지는 않습니다. GitHub Actions 사용 한도가 있으면 수동 실행도 제한될 수 있으며, 로컬 검사 성공만으로 배포 검증을 우회하지 않습니다.

## 필수 검증

```bash
npm run release:check
```

이 명령어는 구문 검사, 전체 Node 테스트, 문서·패키지 검사, 의존성 취약점 검사, 로컬 스모크 테스트를 실행합니다. 높음 또는 심각 등급의 취약점이 발견되면 중단합니다. 스모크 테스트에서는 다음 작업을 확인합니다.

- 토큰 인증을 사용해 HTTP 서버 시작
- 아티팩트 생성
- 탐지한 비밀 정보 차단
- 감사 로그 읽기
- 백업 기록
- MCP 도구, 리소스, 프롬프트 검색

로컬 진단을 실행하세요.

```bash
artifacty doctor
```

- 복구 명령어는 임시 저장소에서만 검증하세요. [업그레이드 스냅샷과 복구](upgrade-backups.md)를 참고하세요.
- 마이그레이션이 저장소를 변경하기 전에 필수 스키마 스냅샷 생성이 완료되는지 확인하세요.
- 최소 지원 버전인 Node.js 22.12.0에서 동작하는지 확인하세요. 선택적으로 사용하는 Babel 8 렌더러는 Node `^22.18.0 || >=24.11.0`이 필요합니다.
- ES2024를 지원하는 브라우저에서 Mermaid 12.2.0을 확인하세요. `classic` 스타일, `dagre` 레이아웃, `default` 테마를 유지하세요.

## 패키징

- 실제 설치된 의존성의 라이선스를 검토하고 [타사 고지](../../THIRD_PARTY_NOTICES.md)와 라이선스 파일을 보존하세요.
- 릴리스 커밋이 지원하는 모든 CI 플랫폼에서 통과했는지 확인하세요. 로컬 검사만으로 CI 검증을 대신할 수는 없습니다.

- `package.json`의 `version`과 `files`가 의도한 값인지 확인하세요.
- `npm pack --dry-run`을 실행하세요.
- 패키지 출력에 나오는 경로를 검토하세요.
- 렌더러 의존성을 포함한 패키지 크기를 검토하세요. Mermaid는 기본 의존성입니다. React, ReactDOM, Babel standalone은 설정으로 활성화하는 React 렌더러의 선택적 의존성입니다.
- 설치 후 셸에서 전역 명령어 `artifacty`, `artifacty-mcp`를 찾을 수 있는지 확인하세요.

## 보안

- 기본 HTTP 바인드 주소를 `127.0.0.1`로 유지하세요.
- `0.0.0.0`에 바인드하기 전에 `ARTIFACTY_API_TOKEN`과 `ARTIFACTY_SHARE_MODE=lan` 또는 `team` 설정을 필수로 요구하세요.
- 루프백이 아닌 주소로 시작할 때 출력에 LAN·팀 경고가 포함되는지 확인하세요.
- `artifacty serve`가 관리 대상 백그라운드 서버를 시작하고 JSON을 반환하는지 확인하세요.
- 현재 터미널에서 서버 로그를 직접 확인하려면 `artifacty serve --foreground`를 사용하세요.
- `artifacty service plist|unit|task --dry-run`이 macOS, Linux, Windows 서비스 정의를 생성하는지 확인하세요.
- 스크립트에서는 쿼리 토큰보다 `x-artifacty-token` 또는 `Authorization: Bearer <token>`을 사용하세요.
- 비밀 정보 검사를 우회하는 설정을 각각 검토하세요. 의도적인 임시 예외에만 `--allow-secrets`와 `ARTIFACTY_ALLOW_SECRETS=true`를 사용하세요.
- 인증, 렌더링, MCP, 네트워크 공유 동작을 변경할 때는 [보안 정책](../../SECURITY.ko.md)과 [위협 모델](threat-model.md)을 검토하세요.
- 아티팩트 HTML과 가져온 에이전트 페이로드를 신뢰할 수 없는 콘텐츠로 취급하세요.
- 스크립트를 실행하는 아티팩트 iframe에 `allow-same-origin`이 포함되지 않는지 확인하세요.
- `/assets/*`와 `/vendor/npm/*`의 JavaScript 응답이 `Origin: null` 요청에만 `Access-Control-Allow-Origin: null`을 반환하는지 확인하세요. 출처가 불투명한 샌드박스 iframe이 로컬 ESM을 가져올 수 있어야 합니다. 샌드박스 플래그를 완화하거나 와일드카드 CORS 정책을 사용해서는 안 됩니다.
- SVG 뷰어 출력에서 `<script>`, `on*` 속성, `javascript:` 링크를 제거하는지 확인하세요.
- `/raw`가 원본 소스를 유지하는지 확인하세요.
- 클라이언트 코드를 실행하는 각 렌더러를 브라우저에서 테스트하세요. 렌더링된 결과를 확인하세요. HTTP 응답이 성공했다고 해서 iframe 안에서 Mermaid나 React가 렌더링되었다고 볼 수는 없습니다.
- `ARTIFACTY_ENABLE_REACT_RENDERER`는 기본적으로 비활성화하세요. 운영자가 임의의 컴포넌트 실행 위험을 수용하는 경우에만 활성화하세요.
- 상위 애플리케이션의 CSP가 `unsafe-eval`을 허용하지 않는지 확인하세요.
- React 프레임 응답의 CSP만 `unsafe-eval`을 허용하는지 확인하세요.
- CodeQL, Scorecard, Dependabot 설정 변경이 의도한 것인지 확인하세요.
- npm 게시에 장기 유효한 npm 토큰 대신 OIDC Trusted Publishing을 계속 사용하는지 확인하세요.

## 운영

- 업그레이드하거나 서버를 옮기기 전에 백업을 내보내세요. 아티팩트만 백업하려면 `artifacty backup`을 사용하세요. 사용자, 토큰, 감사 로그, 관계, 웹훅도 포함하려면 `artifacty backup --full`을 사용하세요.
- `artifacty audit --limit 20`에 최근 생성·업데이트·읽기·보관 이벤트가 표시되는지 확인하세요.
- `artifacty doctor`가 실패 항목을 보고하지 않는지 확인하세요. 오프라인 저장소를 검사하려고 서버를 중지한 경우에는 서버 중지 경고가 표시되어도 됩니다.
- 백그라운드 서비스를 설치하기 전에 `artifacty service install --dry-run`을 실행하세요.
- 다른 운영체제의 정의를 검토하려면 `--platform macos|linux|windows`를 사용하세요.
