# 로컬 모델과 의미 검색

[English](../embeddings.md) | 한국어

<!-- 문장·의미 대조: 2026-10-21, 영문 동시 개정본 기준 -->

의미 검색은 검색어와 다른 표현을 쓴 아티팩트를 찾는 데 도움이 됩니다. 예를 들어 서버 메모리 부족에 관한 질문으로 Java OOM 조사 문서를 찾을 수 있습니다. 저장된 아티팩트의 순위를 정하는 기능이며, 답변을 생성하거나 채팅 모델을 실행하지는 않습니다.

이 안내의 기본 포함 모델과 `artifacty embeddings` 명령은 다음 릴리스용 변경 사항이며, npm의 `0.16.1`에는 아직 포함되지 않았습니다.

## 기본 모델과 데이터 처리

Artifacty에는 `intfloat/multilingual-e5-small`의 INT8 ONNX 가중치와 토크나이저가 포함됩니다. 원본 리비전은 `614241f622f53c4eeff9890bdc4f31cfecc418b3`으로 고정합니다. 가중치는 118,346,824바이트이며, 토크나이저와 WebAssembly 실행 라이브러리가 추가 공간을 사용합니다. 가중치는 여러 파일로 나누어 배포합니다. 로컬 추론은 서버의 Node.js 워커에서 단일 스레드 CPU WebAssembly로 실행하며, 모델을 내려받거나 문서 내용·검색어를 외부 서버로 보내지 않습니다. 오프라인 설치를 따로 준비하지 않았다면 패키지 설치 시에는 레지스트리에 접근해야 합니다.

실행에는 `onnxruntime-web`의 WASM 백엔드를 사용합니다. 브라우저에서 추론하는 기능이 아니며, GPU·CUDA나 네이티브 Node.js 애드온이 필요하지 않습니다. 실행 파일은 npm 패키지에 포함되어 있어 추론 시 추가 다운로드가 없습니다.

원본 모델과 ONNX Runtime은 MIT, Hugging Face Tokenizers는 Apache-2.0 라이선스를 사용합니다. 필요한 고지는 패키지에 포함되며, [서드파티 고지(영문)](../../THIRD_PARTY_NOTICES.md)에서 확인할 수 있습니다. 이 조건이 교체 모델에도 적용되는 것은 아닙니다. 다른 모델의 가중치·토크나이저·실행 라이브러리와 재배포 조건은 별도로 확인하세요.

로컬 제공자는 처음 추론할 때 모델을 불러옵니다. 첫 요청은 이후 요청보다 오래 걸릴 수 있습니다. CPU 사용량과 메모리는 장비와 문서 길이에 따라 달라집니다. 모델 파일 크기가 최대 메모리 사용량을 뜻하지는 않습니다. 로컬 추론 워커는 요청이 없는 상태로 60초가 지나면 종료되어 모델 메모리를 반환합니다. 다음 검색에서는 모델을 다시 불러옵니다.

색인에는 제목, 태그, 메타데이터와 지원되는 텍스트 본문을 사용합니다. `ARTIFACTY_EMBEDDINGS_MAX_CHARS`는 기본적으로 본문을 8,000자로 제한하며, 모델의 토큰 제한도 적용됩니다. 긴 문서는 잘리므로 모든 문단을 검색에 반영하지는 않습니다. 벡터는 SQLite 저장소에 남습니다. 로컬 추론은 저장소 암호화나 접근 제어를 대신하지 않습니다.

## 기존 저장소 확인과 색인

아래 명령은 Node 24에서 실행하는 것을 권장합니다. Node 22.12에서는 Artifacty의 SQLite 모듈을 불러오려면 `NODE_OPTIONS=--experimental-sqlite` 설정이 필요합니다.

서버와 같은 환경 설정 및 `ARTIFACTY_HOME`으로 다음 명령을 실행하세요.

```bash
artifacty embeddings info
artifacty embeddings check
artifacty index rebuild --embeddings
```

`info`는 추론 없이 선택한 설정을 표시합니다. `check`는 실제 추론을 실행하고 반환된 벡터를 확인합니다. 검사 성공은 해당 장비에서 제공자가 작동한다는 뜻이며, 사용자 문서에 대한 검색 품질까지 평가하지는 않습니다. `index rebuild --embeddings`는 기존 아티팩트의 벡터를 만들거나 갱신합니다. 새로 만들거나 수정한 아티팩트는 백그라운드에서 색인하므로 의미 검색 결과에 즉시 나타나지 않을 수 있습니다.

서비스 환경 설정을 바꾸면 서버를 다시 시작하세요. 셸에서 `export`를 실행해도 이미 실행 중인 systemd·launchd 등의 서비스 환경은 바뀌지 않습니다. 같은 저장소를 사용하는 로컬 CLI와 stdio MCP에도 같은 제공자 설정을 적용하세요. 브리지 MCP 클라이언트는 서버 설정을 사용합니다.

## 검색과 결과 확인

![예제 아티팩트를 검색한 영어 로컬 의미 검색 화면](../assets/screenshots/manual-local-search.png)

스크린샷은 격리된 예제 저장소의 검색 결과입니다. **Artifacts**를 열고 **Search artifacts**에 검색어를 입력한 뒤 **Search**를 선택하세요. 검색어가 있으면 기본적으로 키워드·의미 검색 순위를 합치는 하이브리드 검색을 사용합니다. 기존 공개 범위, 접근 권한과 필터도 그대로 적용됩니다.

CLI에서 검색 방식을 지정할 수 있습니다.

```bash
artifacty list --query "server memory investigation" --mode semantic
artifacty list --query "server memory investigation" --mode hybrid
artifacty list --query "OOM" --mode keyword
```

HTTP API는 `GET /api/artifacts?q=...&mode=semantic`, MCP의 `artifacty_list`는 `query`와 `mode`를 받습니다. 제공자 실행에 실패하거나 임베딩을 끄면 의미·하이브리드 검색은 키워드 검색으로 전환하며, `search.fallback: true`를 표시합니다. 벡터가 없다고 아티팩트까지 없는 것은 아닙니다. 임베딩 색인을 다시 만들고 키워드 검색 결과와 비교하세요.

## 제공자 선택

| 설정 | 동작 |
| --- | --- |
| 제공자·명령·URL을 모두 설정하지 않음 | 기본 포함 ONNX 모델 사용 |
| `ARTIFACTY_EMBEDDINGS_PROVIDER=local` | 기본 모델 또는 `ARTIFACTY_EMBEDDINGS_LOCAL_PATH` 디렉터리 사용 |
| `ARTIFACTY_EMBEDDINGS_PROVIDER=command` | `ARTIFACTY_EMBEDDINGS_COMMAND`에 지정한 실행 파일 사용 |
| `ARTIFACTY_EMBEDDINGS_PROVIDER=openai-compatible` | `ARTIFACTY_EMBEDDINGS_URL`에 지정한 API 사용 |
| `ARTIFACTY_EMBEDDINGS_PROVIDER=disabled` | 키워드 검색만 사용 |

`ARTIFACTY_EMBEDDINGS_PROVIDER`를 지정하지 않으면 명령 설정을 URL 설정보다 우선 적용합니다. 둘 다 없을 때 기본 모델을 사용하므로 기존 외부 연동 설정을 유지할 수 있습니다. 이전 명령·URL 설정이 있어도 로컬 모델을 사용하려면 `ARTIFACTY_EMBEDDINGS_PROVIDER=local`을 명시하세요.

외부 API 설정 예시입니다.

```bash
export ARTIFACTY_EMBEDDINGS_PROVIDER=openai-compatible
export ARTIFACTY_EMBEDDINGS_URL=https://api.openai.com/v1
export ARTIFACTY_EMBEDDINGS_MODEL=text-embedding-3-small
# ARTIFACTY_EMBEDDINGS_API_KEY는 서비스 환경에 안전하게 설정하세요.
artifacty embeddings check
```

Artifacty는 기본 URL 뒤에 `/embeddings`를 붙입니다. 외부 제공자는 색인 대상 텍스트와 검색어를 받으므로 데이터 처리 조건과 요금을 확인한 뒤 사용하세요. `ARTIFACTY_EMBEDDINGS_MODEL`은 외부 API나 명령 제공자의 모델을 선택하며, 로컬 모델을 내려받는 설정이 아닙니다.

명령 제공자는 표준 입력에서 텍스트마다 `{ "text": "..." }` JSON 한 줄을 읽고, 표준 출력으로 벡터마다 `{ "embedding": [0.1, 0.2] }` 한 줄을 반환해야 합니다. Artifacty 프로세스 권한으로 실행되므로 신뢰하는 실행 파일만 지정하세요.

## 로컬 모델 변경

`ARTIFACTY_EMBEDDINGS_PROVIDER=local`을 설정하고, `embedding-model.json`과 호환되는 ONNX 가중치·토크나이저 파일이 있는 디렉터리를 `ARTIFACTY_EMBEDDINGS_LOCAL_PATH`로 지정하세요. 관리자가 운영 환경 변수로 설정하는 기능이며, 관리자 화면의 모델 선택 메뉴는 아닙니다. 채팅 모델이나 임의의 ONNX 그래프가 모두 호환되는 것은 아닙니다.

준비된 모델 디렉터리를 다음과 같이 지정하세요.

```bash
export ARTIFACTY_EMBEDDINGS_PROVIDER=local
export ARTIFACTY_EMBEDDINGS_LOCAL_PATH=/path/to/model-directory
artifacty embeddings check
artifacty index rebuild --embeddings
```

로컬 모델 식별자에는 매니페스트 해시가 포함됩니다. 모델 파일이나 설정을 바꾼 뒤에는 새 설정으로 검사와 색인 재생성 명령을 실행하세요. 이전 벡터는 남겨두지만, 서로 다른 로컬 모델 식별자의 벡터끼리는 비교하지 않습니다. 새 색인을 만드는 동안에도 키워드 검색을 사용할 수 있으나, 색인이 끝나기 전에는 의미 검색 대상이 일부에 그칩니다. 되돌리려면 이전 모델 설정을 복원하고 서버를 다시 시작하세요. 일반적인 모델 교체 과정에서 이전 벡터를 삭제하지 마세요.

교체 모델의 매니페스트는 다음 조건을 따라야 합니다.

- `schemaVersion`은 `1`이며, `id`와 `license`는 비어 있지 않은 문자열입니다. 원본 출처와 리비전 정보도 번들에 보관하세요.
- `dimensions`는 출력 벡터 길이(1~8,192), `maxTokens`는 입력 토큰 제한(2~8,192)입니다. 기본 모델은 384차원과 512토큰을 사용합니다.
- `pooling`은 `mean`, `cls`, `sentence` 중 하나이며, `normalize`는 `true`여야 합니다. `queryPrefix`와 `documentPrefix`는 문자열로 지정하며, 접두사가 필요 없는 모델은 빈 문자열을 사용합니다. E5는 각각 `query: `와 `passage: `를 사용합니다.
- `files`에는 토크나이저 파일을 나열합니다. 최소한 `tokenizer.json`과 `tokenizer_config.json`이 있어야 합니다. 각 항목에는 `path`, 바이트 단위의 `size`, 소문자 16진수 `sha256`을 지정합니다.
- `model.parts`에는 가중치 파일을 합칠 순서대로 나열하고, 같은 파일 항목 필드를 사용합니다. `model.size`와 `model.sha256`은 합친 전체 ONNX 파일의 값입니다. 단일 파일 모델도 항목 하나인 `parts` 배열이 필요합니다.
- 파일 이름은 중복되지 않아야 하며 영문자, 숫자, `_`, `-`, `.`만 사용할 수 있습니다. 하위 경로를 넣거나 경로·심볼릭 링크로 모델 디렉터리 밖을 참조할 수 없습니다. 파일을 바꾸면 매니페스트와 체크섬도 갱신하세요. 값이 다르면 무결성 검사에서 거부합니다.

설치된 `models/multilingual-e5-small/embedding-model.json`을 구조 참고 자료로 사용하세요. 다른 모델의 이름만 바꾸거나 기본 번들에 가중치만 복사해서는 안 됩니다. 토크나이저 동작, 그래프 입출력, 풀링, 차원과 접두사를 해당 모델에 맞춘 뒤 `artifacty embeddings check`를 실행하세요. 운영에 적용하기 전에는 대표적인 한국어·영어 검색 결과도 확인하세요.
