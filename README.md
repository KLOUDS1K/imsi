# KLOUD Photo Platform

`kloud.photography` 원본 사진 아카이브와 Lightroom 스타일의 KLOUD Studio를 한 프로젝트로 통합했습니다. 갤러리·관리·업로드는 기존 Cloudflare Worker/D1/R2 구조를 그대로 사용하고, 편집은 브라우저 안(WebGL2, Web Worker, IndexedDB)에서 비파괴 방식으로 처리합니다.

- `/` 및 `/f/<id>`: 기존 사진 아카이브
- `/studio`: KLOUD Studio
- 사진 뷰어의 **Edit**: 서명된 원본을 Studio에 자동으로 불러와 Develop 화면으로 이동
- Studio의 **← Photos**: 기존 사진 화면으로 복귀

Studio는 라우트 단위로 지연 로딩되므로 일반 방문자는 편집기 코드와 LibRaw WASM을 내려받지 않습니다. 원본 사진은 같은 출처에서 브라우저로 전달되며 편집을 위해 별도 서버에 재전송되지 않습니다.

## 실행

```bash
npm install
npm run dev        # 클라이언트: http://localhost:5173
npm run preview    # 빌드 후 Cloudflare Worker 로컬 실행
npm run build      # Cloudflare Assets용 dist/client 생성
npm run deploy     # 기존 kloudphoto Worker로 배포
npm run typecheck  # 앱, 설정 파일, 테스트 코드까지 전부 검사
npm test           # 단위 테스트 (vitest)
npx playwright install chromium # 최초 1회, 테스트용 브라우저 설치
npx playwright test  # 헤드리스 Chromium e2e (포트 변경: PW_PORT=5302)
```

사진이 없어도 라이브러리의 **Add sample photos**를 누르면 데모 사진 3장으로 바로 써볼 수 있습니다.

## 내보내기 개선

- **출력 크기 미리보기**: 크롭·회전과 리사이즈를 반영한 실제 픽셀 수, 메가픽셀, 비트 깊이를 표시합니다. `{width}` / `{height}` 파일명도 출력 크기를 사용합니다. 여러 장이면 첫 사진 기준입니다.
- **개인 내보내기 프리셋**: `Export → Save preset…`에서 크기·품질·색 공간·워터마크·파일명을 이름 붙여 저장합니다. 같은 브라우저에서 다시 사용할 수 있습니다.
- **중단**: 내보내기 중 `Stop export` 또는 창 닫기로 중단합니다. 진행 중인 단계가 끝나면 멈추며 중단한 작업에서는 다운로드하지 않습니다. 작업 중에는 설정이 고정됩니다.
- **너비/높이 입력 수정**: `Width` / `Height` 입력값이 실제 내보내기에 적용됩니다. `Fit W × H`는 비율을 유지하며 지정한 상자에 맞춥니다. 정확한 비율은 Develop에서 크롭하세요.
- **RAW 대체 이미지 해상도 수정**: 내장 JPEG를 사용하면 작은 썸네일과 큰 미리보기를 구분해 내보낼 때 가장 큰 이미지를 다시 읽습니다. 상태 표시줄의 `RAW JPEG preview`는 센서 RAW 현상이 아닌 내장 JPEG 편집이라는 뜻입니다.
- **자동 저장 실패 재시도**: 다른 사진으로 이동하더라도 저장에 실패한 사진의 편집값을 유지하고 다음 저장 때 재시도합니다. 탭을 닫기 전 저장 성공 여부를 확인하세요.

GitHub의 `Editor checks` 워크플로가 타입 검사, 단위 테스트, 빌드와 주요 브라우저 흐름을 검사합니다. `PW_CHROMIUM`을 지정하면 별도 Chromium 실행 파일로 테스트할 수 있습니다.

## 주요 기능 위치

- **오른쪽 패널 상단 도구줄**: 편집 / 자르기 / 힐·제거 / 마스크 / AI. 오른쪽 끝 **…** 메뉴에서 전체 초기화, 설정 복사·붙여넣기, 편집 파일(`.kloud.json`)과 Lightroom XMP 사이드카 저장·불러오기, 스냅샷 만들기를 할 수 있습니다.
- **왼쪽 패널**: 내비게이터, 프리셋(마우스를 올리면 미리보기, **+**로 새 프리셋: 포함할 설정 그룹, 카메라·렌즈·ISO 조건, 자동 적용), 스냅샷, 히스토리.
- **AI 패널**: AI 자동 편집(장면 분석 후 톤·색·디테일·마스크 설정, 야경은 어두운 분위기 유지), 분석 리포트, KLOUD Style(원본+보정본 쌍이나 내 보정으로 개인 스타일 학습).
- **보기**: `\` 전후 비교, `Y` 비교 레이아웃 전환(분할, 나란히, 기준 사진), `Z` 100% 확대(확대하면 원본 해상도로 다시 렌더링), `J` 클리핑 경고, `?` 단축키 목록.
- **성능**: 조작 중에는 저해상도 초안으로 먼저 그리고, 손을 떼면 고화질로 다시 그립니다. 앞 단계(현상, 디테일, 마스크) 결과를 캐시해서 효과나 자르기만 바꿀 때는 뒷부분만 다시 계산합니다.

## 원본 사이트 통합 구조

- `gallery/src`: 기존 KLOUD.PHOTOGRAPHY 클라이언트
- `worker`, `migrations`, `wrangler.jsonc`: 기존 Cloudflare 백엔드
- `src/app`, `src/editor`, `src/ui`: KLOUD Studio
- `gallery/src/app/studio.ts`: 갤러리와 Studio 사이의 라우트·원본 전달 브리지

`.wrangler/`, `.dev.vars`, `.setup-key.txt`, 로컬 D1/R2 데이터는 Git에서 제외됩니다.

## 다른 화면에 편집기 붙이기

편집기는 특정 프레임워크에 묶여 있지 않습니다. DOM 요소 하나에 마운트합니다.

```ts
import { mountKloudEditor } from './src/app';

const editor = await mountKloudEditor(document.getElementById('editor')!, {
  embedded: true, // 단축키를 편집기 영역 안으로 한정
});
// editor.destroy();
```

Next.js / React에서는 클라이언트 전용으로 불러옵니다.

```tsx
'use client';
import { useEffect, useRef } from 'react';

export default function Editor() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let handle: { destroy(): void } | undefined;
    import('@/kloud-studio/app').then(async ({ mountKloudEditor }) => {
      if (ref.current) handle = await mountKloudEditor(ref.current, { embedded: true });
    });
    return () => handle?.destroy();
  }, []);
  return <div ref={ref} style={{ height: '100dvh' }} />;
}
```

`npm run build` 결과물(`dist/`)을 `/editor/` 같은 경로에 그대로 올려도 됩니다.

## 테마

색, 글꼴, 크기 값은 전부 **`src/theme/tokens.css`**의 `--k-*` 변수에 있습니다. kloud.photography 스크린샷을 기준으로 맞췄습니다: Finder 스타일, 라이트/다크, 폴더 노란색 포인트, `KLOUD.PHOTOGRAPHY` 워드마크. 사이트 프로젝트에 붙일 때는 이 변수들을 사이트 변수에 연결만 하면 됩니다. 테마 전환은 `<html data-theme="light|dark">`이고, 속성이 없으면 OS 설정을 따릅니다.

## 구조

전체 설계는 [ARCHITECTURE.md](ARCHITECTURE.md), 모듈 간 연결 규칙은 `src/editor/contracts.ts`, 데이터 타입은 `src/editor/types.ts`에 있습니다.

| 경로 | 내용 |
| --- | --- |
| `src/editor/engine` | WebGL2 렌더러: 파이프라인, 표시(확대, 전후 비교, 클리핑 경고, 마스크 오버레이), 내보내기 렌더 |
| `src/editor/engine/color`, `fx` | 현상 셰이더 (톤, 커브, HSL, 그레이딩, 캘리브레이션, 디헤이즈, 기하 변환, 노이즈 감소, 샤프닝, 효과) |
| `src/editor/io`, `lens` | JPEG/PNG(16bit)/WebP/TIFF/RAW(LibRaw WASM) 디코딩, EXIF, 썸네일, 렌즈 프로파일 |
| `src/editor/state`, `presets` | 편집 상태, 실행 취소, 히스토리, 스냅샷, Lightroom XMP 호환, KLOUD 프리셋 |
| `src/editor/analysis` | 히스토그램과 스코프, 자동 톤/화이트밸런스, 장면 분석, AI 자동 편집, 수평 보정, 먼지 검출 |
| `src/editor/masks`, `ai/segment` | 마스크 합성, 영역 인식 (피사체, 하늘, 인물 등) |
| `src/editor/ai/inpaint`, `ai/style` | PatchMatch 개체 제거와 힐, KLOUD Style 개인 스타일 학습 |
| `src/editor/export`, `watermark` | JPEG/PNG/WebP/TIFF/DNG 인코딩, ICC, EXIF, 워터마크, zip 일괄 내보내기 |
| `src/editor/storage`, `library` | IndexedDB, 자동 저장과 충돌 복구, 라이브러리, 일괄 동기화 |
| `src/ui/*`, `src/app` | UI 부품, 패널, 뷰어, 라이브러리 화면, 앱 셸 |

## 알아둘 점 (프로토타입 한계)

- **AI 기능**(영역 인식, 생성형 지우기, 깊이 추정)은 학습된 모델 대신 기기 안에서 도는 알고리즘(휴리스틱, PatchMatch)으로 구현했습니다. 앱 화면에도 그렇게 표시됩니다. 나중에 ML 모델(MediaPipe 등)을 넣을 자리는 `src/editor/ai/segment`의 `enableMlBackend`입니다.
- **렌즈 프로파일**은 대표 렌즈 15종 정도의 근사값이고, 실측 보정 데이터가 아닙니다.
- **RAW**는 LibRaw WASM으로 디코딩합니다. 브라우저나 보안 정책 때문에 실패하면 RAW 파일 안에 들어 있는 JPEG 미리보기로 대신합니다.
- **DNG 내보내기**는 편집 결과를 담은 선형 DNG이고, 원본 센서 데이터가 아닙니다.
- **렌더링**은 WebGL2로 하고, WebGPU는 지원 여부만 확인합니다.
- **테스트**: 단위 테스트 346개와 e2e 87개(가져오기, 편집, 마스크, 힐·제거, 자르기, 스냅샷, XMP, 일괄 동기화, 내보내기 형식별 헤더 검사, 확대 렌더링 등)가 헤드리스 Chromium(SwiftShader)에서 통과합니다. 실제 GPU나 모바일 Safari에서는 아직 확인하지 않았습니다.
