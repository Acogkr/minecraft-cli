# Architecture

## 범위

`minecraft-cli`는 사용자가 실행한 Minecraft 서버에 offline 또는 Microsoft 인증 클라이언트로 접속합니다. Paper 서버 설치·실행·중지는 담당하지 않습니다.

## 구성

```text
AI 또는 사용자
  -> minecraft-cli
    -> JSON scenario runner + failure capsule
    -> localhost daemon
      -> Mineflayer 세션
      -> 외부 Minecraft 서버
      -> 선택형 localhost Paper Probe (격리 테스트 서버만)
    -> MultiMC 버전별 슬롯
      -> Fabric 제어 모드
      -> 실제 렌더링과 PNG
```

### Mineflayer

채팅, 명령, 이동, 엔티티·블록 상호작용, 인벤토리, GUI 슬롯, 이벤트와 상태를 빠르게 검사합니다. 결과는 AI가 읽기 쉬운 compact JSON으로 제공합니다.

이벤트에는 세션 수명 동안 증가하는 sequence를 붙입니다. 호출자는 마지막 `nextSequence` 이후의 이벤트만 요청할 수 있습니다. Mineflayer의 문자열 채팅 별칭과 의미 이벤트로 이미 변환된 원본 UI 패킷은 중복 저장하지 않습니다.

### Local daemon

짧은 CLI 호출 사이에서 여러 Mineflayer 세션을 유지합니다. 세션은 이름별로 독립적이며 상태와 이벤트를 각 프로젝트의 `.minecraft-cli/sessions`에 저장합니다.

### Scenario runner

Version 2는 JSON selector capture, 변수 치환, assertion, retry/repeat와 소규모 parallel group을 지원합니다. 각 단계는 별도 프로세스로 격리하고 전체 응답은 `.minecraft-cli/runs`에 저장합니다. 실패 시 전후 diff, 관련 이벤트 구간, 데몬·Probe 상태를 비밀값이 제거된 capsule 하나로 남깁니다. Version 1 형식도 그대로 실행합니다.

### Microsoft 인증

`auth login`은 Mineflayer용 장치 코드 로그인입니다. 검증된 Microsoft HTTPS 주소만 기본 브라우저로 열어 코드를 미리 채우고, 같은 코드를 Windows 클립보드에도 복사합니다. 브라우저와 클립보드는 `--no-browser`, `--no-clipboard`로 각각 비활성화할 수 있습니다. 최초 계정 승인이 끝나야 명령이 성공하며, 갱신 토큰은 프로젝트 밖의 사용자 `LocalAppData`에 저장합니다. 세션과 결과 JSON에는 인증 방식과 로컬 계정 별칭만 기록합니다.

MultiMC 화면 세션은 이 Mineflayer 인증 캐시를 공유하지 않습니다. MultiMC의 활성 계정을 그대로 사용하며, 필요할 때만 `--profile`로 MultiMC에 이미 등록된 다른 계정을 선택합니다.

### MultiMC와 Fabric

실제 GUI, Lore, 채팅 hover, 타이틀, 액션바, 보스바, 스코어보드, 토스트와 다이얼로그를 렌더링합니다. 일반 위젯은 표시 문구와 경계를 JSON으로 읽어 문구로 hover/click하고, 문구가 없는 커스텀 화면은 GUI 좌표를 사용합니다. 가상 커서, 텍스트 입력, 키보드 탐색과 스크롤은 Minecraft 내부 이벤트로 전달되어 사용자의 Windows 포커스와 입력 장치를 사용하지 않습니다. 각 시각 세션은 별도 제어 포트와 무작위 토큰을 사용합니다.

네이티브 데이터 기반 다이얼로그는 Minecraft 1.21.6 이후 기능이므로 지원 버전 중 1.21.11 어댑터에서 처리합니다. 1.20.1과 1.21.4는 플러그인 인벤토리와 해당 버전의 일반 화면을 동일한 제어 계층으로 검사합니다.

`actor` 계층은 NPC 역할 기반 상호작용과 화면 action을 하나의 이름으로 묶습니다. 렌더링 세션이 있으면 이를 우선하고 NPC 상호작용만 가능한 headless 세션으로 제한적으로 대체합니다. 네이티브 Dialog처럼 특정 transport가 필요한 기능은 capability와 사유를 명시합니다.

visual adapter는 세션별 framebuffer, GUI scale과 FOV를 MultiMC 설정에 기록하고 실제 적용값을 `/state`에서 다시 읽습니다. 절대·상대 회전과 1·3인칭 전환은 Minecraft client thread에 직접 전달합니다. 1.21.11 adapter는 TextDisplay의 렌더 상태와 실제 카메라 투영을 조합해 pixel 경계, angular miss와 selection cone을 계산합니다.

session-only 리소스팩은 관리형 instance에 고유 파일로 복사하고 기존 options를 restore manifest에 저장합니다. 정상 stop과 launch 실패가 모두 원복 경로를 호출합니다. 두 Microsoft visual 세션의 actor/observer 캡처는 framebuffer 요청을 병렬로 보내며 요청 시각 차이를 결과에 기록합니다.

프레임버퍼 PNG에는 SHA-256과 이전 캡처 대비 변화량을 계산합니다. GUI, tooltip, chat, dialog, HUD 관심 영역과 실제 변화 bounding box를 교차해 crop을 만들고 무변화 프레임은 crop을 만들지 않습니다.

### Paper Probe

Probe는 `.minecraft-cli` 아래 격리 테스트 서버에만 선택 설치하는 assertion용 관측기입니다. 서버 이벤트, 명령·권한 결과와 제한된 플레이어 상태 복원을 제공하며 운영 제어 API나 DB 접근은 하지 않습니다. 미설치 서버에서는 `available: false`로 정상 저하되어 기본 black-box 테스트를 유지합니다.

MultiMC 슬롯은 실제 동시 실행 수만큼만 만들고 버전마다 최대 8개까지 허용합니다. 종료된 슬롯을 먼저 재사용하므로 실행 횟수에 따라 인스턴스가 증가하지 않습니다. 할당은 MultiMC 루트의 잠금 파일로 직렬화합니다.

## 지원 버전

- `1.20.1`: Java 17 런타임 자동 준비
- `1.21.4`: Java 21
- `1.21.11`: Java 21

지원하지 않는 버전은 `VISUAL_VERSION_UNSUPPORTED`로 실패합니다.

## 증거와 성능

- 일반 동작: Mineflayer와 필요한 JSON 조각만 사용
- 반복 흐름: scenario 요약만 반환하고 전체 단계 응답은 파일로 지연 제공
- 시각 확인: 필요한 시점에만 MultiMC 실행
- 증거: 세션별 JSON, 이벤트 로그, PNG
- 종료: `visual stop`과 `cleanup`
- 보존: `artifacts status`와 명시적 `artifacts prune --apply`

시각 클라이언트 시작이 실패하면 해당 슬롯의 프로세스를 자동 종료합니다.

보존 정리는 세션 디렉터리 자체를 지우지 않습니다. 지정한 기간보다 오래되고 최신 보존 개수를 넘어선 스크린샷, 타임스탬프 JSON, 시나리오 보고서만 대상으로 하며 metadata, latest 상태, 이벤트 로그, 런타임과 다운로드는 보호합니다.
