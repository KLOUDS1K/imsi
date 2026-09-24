# KLOUD Studio

kloud.photography용 웹 사진 편집기 프로토타입입니다. Lightroom처럼 원본을 건드리지 않는 비파괴 편집 방식입니다. 모든 처리는 브라우저 안(WebGL2, Web Worker, IndexedDB)에서 이루어지고, 사진이 서버로 전송되지 않습니다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ — 어느 하위 경로에 올려도 동작 (base: './')
npm run typecheck
npm test           # 단위 테스트 (vitest)
```

사진이 없어도 라이브러리의 **Add sample photos**를 누르면 데모 사진 3장으로 바로 써볼 수 있습니다.

## 사이트에 붙이기

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
- **테스트**는 사용량 한도 때문에 마지막 단계를 가볍게 끝냈습니다. 라이브러리 → 편집 → 노출 조정 흐름은 헤드리스 Chromium에서 확인했지만, 기능별 세부 테스트는 더 필요합니다.
