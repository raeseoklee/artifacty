# 문서 안내

[English](../README.md) | 한국어

설치 방법, 전체 기능, CLI 명령과 환경 변수는 [한국어 README](../../README.ko.md)에서 확인하세요.

## 브라우저 화면 언어

관리자는 `/admin/languages`에서 설치된 언어를 활성화하고 기본 언어를 선택합니다. 활성화된 URL 선택, 브라우저 쿠키, 저장한 기본값 순으로 적용합니다. 설정을 저장하기 전에는 `ARTIFACTY_LOCALE` 또는 영어가 초기 기본값입니다. 비활성화된 선택과 `Accept-Language`는 무시합니다. 가져오기와 대체 언어 규칙은 [언어 팩](language-packs.md)을 참고하세요. UI 번역은 명령어, API·MCP 식별자, 저장된 아티팩트 내용을 번역하지 않습니다.

## 사용자·운영자 안내

| 문서 | 한국어 | English |
| --- | --- | --- |
| 설치와 기능 참조 | [README](../../README.ko.md) | [README](../../README.md) |
| 언어 팩 | [안내](language-packs.md) | [Guide](../language-packs.md) |
| SMTP와 비밀번호 재설정 | [안내](smtp.md) | [Guide](../smtp.md) |
| 에이전트 연동 | [연동 안내](integrations.md) | [Guide](../integrations.md) |
| 네트워크 공유 | [안내](network-sharing.md) | [Guide](../network-sharing.md) |
| 업데이트 백업과 복구 | [안내](upgrade-backups.md) | [Guide](../upgrade-backups.md) |
| MCP 공개 API | [참조](mcp-public-api.md) | [Reference](../mcp-public-api.md) |
| 아티팩트 스키마 v1 | [참조](artifact-schema-v1.md) | [Reference](../artifact-schema-v1.md) |
| 보안 정책 | [정책](../../SECURITY.ko.md) | [Policy](../../SECURITY.md) |
| 위협 모델 | [참조](threat-model.md) | [Reference](../threat-model.md) |
| 릴리스 체크리스트 | [체크리스트](release-checklist.md) | [Checklist](../release-checklist.md) |
| 문서 작성 기준 | [안내](writing-style.md) | [Guide](../writing-style.md) |

## 설계와 구현 이력

다음 문서는 현재 영문으로 제공합니다. 제안과 과거 구현 기록이 포함되어 있으므로, 계획된 기능을 현재 릴리스에서 지원하는 기능으로 해석하지 마세요.

- [중앙 팀 서버 배포 설계 — 영문](../central-team-deployment-design.md)
- [로드맵과 설계 — 영문](../roadmap-design.md)
- [전체 저장소 암호화 설계 — 영문](../store-encryption-design.md): 외부 키 복구와 오프라인 복사 변환을 검증 중입니다. 운영 저장소 전환과 관리자 설정은 아직 지원하지 않습니다.
- [Claude 아티팩트 형식 — 영문](../claude-artifact-formats.md)
- [SARIF·CSV 아티팩트 지원 — 영문](../sarif-csv-artifact-plan.md)

## 번역 유지 관리

- 기본 영어 진입점은 `README.md`, 한국어 진입점은 `README.ko.md`로 유지합니다. 상세 한국어 문서는 `docs/ko/`에서 원문과 같은 파일명을 사용합니다.
- 두 언어의 문서가 서로 연결되도록 합니다. 번역본이 있으면 해당 문서로 연결하고, 영문만 있는 참조는 명확히 표시합니다.
- 명령어, API 식별자, 예제 값, 기본값, 권한 규칙과 요구사항을 보존합니다. 설명문은 [문서 작성 기준](writing-style.md)에 맞춰 자연스러운 한국어로 옮깁니다.
- 동작이 바뀌면 같은 PR에서 두 언어를 함께 수정합니다. 번역을 갱신하지 못했다면 최신 내용이 반영되지 않았음을 표시하고 최신 영문 절로 연결합니다.
- 번역본의 HTML 주석에 원문 기준 리비전을 기록합니다. 원문과 대조한 뒤 리비전을 갱신합니다. 최초 번역 기준은 `9e73a9f`입니다.
- 병합 전에 상대 링크, 절 앵커, 코드 예제와 환경 변수 누락 여부를 확인합니다. 번역을 검증하려고 파괴적 명령이나 운영 서버용 명령을 실행하지 않습니다.
- 저장소 번역을 추가해도 브라우저 언어 설정이나 이미 설치한 샘플 아티팩트 매뉴얼은 바뀌지 않습니다.
