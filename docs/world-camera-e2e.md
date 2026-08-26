# World 카메라와 ModelEngine E2E

## 구현 범위

- visual launch/prepare에서 framebuffer, GUI scale, FOV 지정과 실제 state 확인
- 시스템 마우스 없는 yaw/pitch 절대·상대 회전
- 1인칭, 3인칭 후면·전면 전환
- 1.21.11 TextDisplay 문구, 위치, scale, seeThrough, viewRange와 화면 pixel 경계 계산
- TextDisplay 문구 조준·우클릭, pixel 크기와 angular miss 제한, Dialog 개방 대기
- 두 Microsoft visual 세션의 actor/observer 병렬 framebuffer 캡처
- session-only 리소스팩 UUID/SHA-256/active 확인과 stop·실패 시 원복
- control-mod source/JAR freshness 검사와 protocol 2 협상; 구형 라우트의 404 HTML을 명시적 stale/route 오류로 변환
- 1.21.11 Dialog layout 재귀 탐색, 사용자 버튼 우선 action 목록과 실제 `onPress` callback 호출

## 자체 검증

- TypeScript build 통과
- 세 지원 버전 adapter를 공식 매핑 JAR로 직접 Java 컴파일 통과
- world-camera mock bridge에서 state, 회전, 시점, TextDisplay 필터/선택과 capability 실패 통과
- 가짜 MultiMC instance에서 리소스팩 설치, options 활성화, stop 원복 통과
- Arvella World/ModelEngine 시나리오 4종 Scenario v2 dry-run 통과

Fabric Loom으로 1.20.1, 1.21.4, 1.21.11 adapter의 정식 `build`와 `remapJar`를 확인했습니다. CI에서도 같은 세 빌드를 독립 실행합니다.

실제 Arvella 화면 판정은 서버가 준비된 뒤 [fixture 안내](../fixtures/scenarios/arvella-world/README.md)의 변수만 바인딩해 실행합니다. Arvella 소스와 ServerPack은 이 작업에서 수정하지 않았습니다.
