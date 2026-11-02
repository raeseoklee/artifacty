# PostgreSQL 저장소

[English](../postgresql.md) | 한국어

PostgreSQL 지원은 Artifacty 0.18.0부터 제공합니다.

기본 데이터베이스는 SQLite입니다. `ARTIFACTY_DATABASE_URL`을 설정하면 PostgreSQL을 명시적으로 선택합니다. 설정한 PostgreSQL 서버에 연결할 수 없거나 인증에 실패해도 SQLite로 자동 전환하지 않습니다.

## PostgreSQL에 저장하는 데이터

PostgreSQL은 아티팩트 메타데이터, 버전 기록, 사용자, 권한, 카테고리, 댓글, 설정, 감사 기록, 임베딩 벡터를 보관합니다. 아티팩트 본문과 첨부 파일은 기존처럼 `ARTIFACTY_HOME` 아래의 변경 불가능한 파일로 저장합니다. 데이터베이스만 백업하면 이 파일들은 포함되지 않습니다.

하나의 Artifacty 서버와 하나의 저장소 디렉터리를 사용하세요. MCP 클라이언트는 해당 서버에 연결합니다. PostgreSQL을 사용하더라도 서로 다른 호스트가 각자의 아티팩트 디렉터리로 같은 데이터베이스를 사용하는 구성은 지원하지 않습니다. 비공개 파일 `.postgres-store-id`는 디렉터리와 데이터베이스 스키마를 연결하므로, 기존 설치를 이전할 때 함께 보존해야 합니다.

## 연결 설정

선택적 패키지를 포함해 의존성을 설치하세요. `pg` 드라이버는 SQLite 설치에는 선택 사항이지만 PostgreSQL에는 필요합니다. `--omit=optional`로 설치했다면 드라이버를 설치하기 전에는 이 백엔드를 사용할 수 없습니다.

전용 데이터베이스와 Artifacty 스키마를 생성·관리할 수 있는 로그인 역할을 준비하세요. 애플리케이션에 PostgreSQL 슈퍼유저 계정을 사용하지 마세요. 연결 URL은 비공개 환경 파일이나 배포 환경의 비밀 관리 도구에 보관합니다. 저장소에 커밋하거나 공용 로그에 남기지 말고, 운영 비밀번호를 문서 예제에 붙여 넣지 마세요.

폐기 가능한 로컬 데이터베이스의 설정 형태는 다음과 같습니다.

```sh
export ARTIFACTY_HOME="$HOME/.artifacty-postgres"
export ARTIFACTY_DATABASE_URL='postgresql://artifacty:example-password@127.0.0.1:5432/artifacty'
export ARTIFACTY_DATABASE_SCHEMA='artifacty'
export ARTIFACTY_DATABASE_TIMEOUT_MS='15000'
artifacty serve
```

`example-password`는 예시 값이며 제공되는 인증 정보가 아닙니다. 실제 URL 비밀번호의 예약 문자는 퍼센트 인코딩하세요. 원격 데이터베이스에는 `pg`가 지원하는 PostgreSQL 연결 매개변수로 TLS를 설정합니다. 연결을 성사시키려고 인증서 검증을 끄지 마세요. 인증서 설정은 [node-postgres SSL 안내](https://node-postgres.com/features/ssl)를 참고하세요.

| 환경 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `ARTIFACTY_DATABASE_URL` | 미설정 | 데이터베이스를 지정하는 `postgres://` 또는 `postgresql://` URL입니다. 미설정이거나 빈 값이면 SQLite를 선택합니다. |
| `ARTIFACTY_DATABASE_SCHEMA` | `artifacty` | 전용 스키마입니다. 소문자로 시작하고 소문자·숫자·밑줄을 사용하며 최대 63자입니다. `public`, `information_schema`, `pg_`로 시작하는 이름은 거부합니다. |
| `ARTIFACTY_DATABASE_TIMEOUT_MS` | `15000` | 연결·쿼리 대기 제한입니다. 1000~120000밀리초 범위의 정수입니다. |

이 저장소에 접근하는 모든 CLI, 서버, 직접 연결한 stdio MCP 프로세스에 같은 백엔드 환경 변수를 설정하세요. PostgreSQL에 연결된 홈은 별도 셸에서 데이터베이스 URL 없이 열 수 없습니다. 별도의 SQLite 저장소를 만드는 대신 설정 오류를 반환합니다. 데이터베이스 종류를 바꿀 때는 새 디렉터리를 사용하세요. 중앙 서버의 설정을 사용해야 하는 클라이언트에는 HTTP MCP 연결을 권장합니다.

처음 사용할 때 서버가 새 스키마를 초기화합니다. URL을 바꾸는 것만으로 기존 SQLite 데이터가 PostgreSQL로 이동하지는 않습니다. 운영 설정이 빈 대상으로 연결됐다고 해서 사용자와 아티팩트가 이전됐다고 판단하지 마세요.

## 검색과 동시성

PostgreSQL 텍스트 검색은 이 백엔드의 부분 문자열 검색 경로를 사용합니다. SQLite FTS5를 사용하지 않으며 PostgreSQL 전문 검색으로 설명하지 않습니다. 의미 기반 순위 계산은 Artifacty에 설정한 임베딩 공급자와 저장된 벡터를 계속 사용합니다. 데이터베이스를 바꿔도 임베딩 모델이 자동으로 변경되지 않습니다.

쓰기 트랜잭션은 스키마 범위의 PostgreSQL 어드바이저리 잠금을 사용해 기존 저장소 서비스가 전제하는 직렬 쓰기 동작을 유지합니다. 첫 구현은 동기식 저장소 인터페이스를 유지하므로 원격 데이터베이스의 지연이 요청 처리 시간에 영향을 줄 수 있습니다. 처리량 증가나 여러 호스트의 동시 운영을 보장하는 기능은 아닙니다.

## 기존 SQLite 저장소 이전

원본 서버와 모든 직접 쓰기 프로세스를 중지하세요. 내보내기 전에 검증된 원본 백업을 보존합니다. 새 PostgreSQL 스키마와 빈 대상 디렉터리를 사용하세요. 다음 명령은 대상의 내용을 교체합니다.

```sh
# 현재 셸이 PostgreSQL을 선택하더라도 기존 SQLite 저장소를 내보냅니다.
ARTIFACTY_DATABASE_URL='' artifacty export \
  --home "$HOME/.artifacty" \
  --file "$HOME/artifacty-migration.json" --full

# 먼저 ARTIFACTY_DATABASE_URL을 대상 PostgreSQL 주소로 비공개 설정하세요.
export ARTIFACTY_DATABASE_SCHEMA='artifacty_migration'
artifacty import-store --home "$HOME/.artifacty-postgres" \
  --file "$HOME/artifacty-migration.json" --confirm replace-all
artifacty integrity --home "$HOME/.artifacty-postgres"
```

가져오기는 데이터베이스 기록과 대상의 버전 파일을 함께 생성합니다. 전체 범위 가져오기에는 `--confirm replace-all`이 필요하며, 대상에 사용자가 이미 있으면 명시적으로 강제하지 않는 한 거부합니다. 빈 대상으로 정상 이전할 때는 `--force-users`를 추가하지 마세요. 원본 내보내기는 기존 저장소를 전환하거나 삭제하지 않습니다.

무결성 검사에서 `ok: true`를 확인한 뒤 같은 PostgreSQL 환경 변수와 대상 홈으로 서버를 시작하세요. `/health`는 `databaseBackend: "postgres"`를 반환하며 연결 URL은 노출하지 않습니다. 클라이언트 주소를 바꾸기 전에 사용자, 카테고리, 댓글, 아티팩트 수와 대표 본문을 비교합니다. 검증이 끝날 때까지 원본은 중지 상태로 유지하세요. 역방향 이전도 같은 전체 JSON 형식을 사용합니다. PostgreSQL을 선택한 상태에서 내보낸 다음 `ARTIFACTY_DATABASE_URL=''`로 빈 SQLite 홈에 가져옵니다.

전체 JSON 형식에도 모든 로컬 운영 비밀 파일이 포함되는 것은 아닙니다. SMTP를 사용한다면 `secrets/smtp.key`를 포함해 로컬 비밀 파일을 따로 보존하세요. 가져온 세션이 무효화되고 일부 연동은 다시 설정해야 하는 등 기존 백업 규칙도 적용됩니다. 이전 JSON을 비공개로 보관하고 복구 검증 후 백업 보존 정책에 따라 삭제하세요.

## 백업·이전·업데이트

운영 백업을 만들기 전에 서버와 모든 쓰기 프로세스를 중지하세요. `pg_dump` 같은 PostgreSQL 도구로 데이터베이스를 백업하고, 같은 중지 상태에서 Artifacty의 비공개 디렉터리 전체를 백업합니다. 아티팩트 파일, `.postgres-store-id`, 로컬 비밀 파일을 포함하세요. 백업을 비공개로 보관하고 격리된 대상에서 복구를 검증합니다.

호스트를 이전할 때는 데이터베이스와 일치하는 Artifacty 디렉터리를 함께 복구하세요. 이전 설치를 중지한 상태로 유지하면서 대상의 아티팩트 수, 버전 무결성, 로그인, 권한, 대표 아티팩트 본문을 확인합니다. 데이터베이스 연결 성공만으로 버전 파일이 존재한다고 판단할 수는 없습니다.

`artifacty backups`의 물리 스냅샷 명령은 SQLite 전용입니다. PostgreSQL 설치에서는 불완전한 스냅샷을 만들지 않고 명령을 거부합니다. CLI와 관리자 화면의 자동 서버 업데이트도 PostgreSQL에서는 지원하지 않으며, 업데이트 확인 시 이 제한을 안내합니다. 데이터베이스와 파일을 함께 백업하고 검증한 뒤 수동으로 패키지를 업데이트하세요.

새 버전의 Artifacty가 기록한 스키마를 이전 빌드로 열면 안 됩니다. 기존 PostgreSQL 스키마에 구조 변경이 필요하다면 명시적으로 지원하는 마이그레이션 절차를 따라야 합니다. 버전 메타데이터를 바꿔 보호 장치를 우회하지 마세요. SQLite의 자동 사전 스냅샷은 PostgreSQL을 보호하지 않습니다.

Artifacty의 논리 JSON 내보내기·가져오기는 물리 스냅샷과 다른 형식이며, 위 절차에 따라 서로 다른 백엔드 사이의 이전을 지원합니다. 전체 백업에는 계정과 보안 데이터가 포함되므로 비밀 정보로 취급해야 합니다. SQLite 전용 절차는 [업데이트 백업과 복구](upgrade-backups.md)를, 논리 백업 명령은 [README 백업 안내](../../README.ko.md)를 참고하세요.
