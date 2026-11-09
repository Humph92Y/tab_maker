# PDF 악보 인식: 구조와 회귀 검사 규칙

이 문서는 PDF 인식을 고칠 때 지키는 규칙과, 그 규칙을 받쳐 주는 도구를 설명해요.
목표는 두 가지예요. 인식이 **조금씩 쌓이며 좋아지는 것**, 그리고 **한 악보를 고치다가 다른 악보를 망가뜨리지 않는 것**.

## 1. 인식 순서 (js/pdfimport.js)

| 단계 | 하는 일 | 함수 |
|---|---|---|
| ① 꺼내기 | PDF에서 글자·선·도형을 꺼냄 | `readPage` |
| ② 오선 찾기 | 6줄 = 타브, 5줄 = 오선보 | `findStaves` |
| ③ 기호 후보 | 음표머리·기둥·빔·점·쉼표·빗금·박자표 숫자 후보 | `readRhythm`, `slashHeads`, `vecTimeSig` … |
| ④ 기호 판단 | 후보가 무엇인지 결정 (지금은 규칙) | 각 함수 안의 규칙 + `classify()` 연결점 |
| ⑤ 조립 | 박·마디·박자표·템포·튜닝으로 묶음 | `parseSystem`, `importPdf` |
| ⑥ 검증 | 박자 합 확인. 원본에서 읽은 길이는 바꾸지 않고 ⚠ 표시 | `fitMeasure` |

## 2. 출처별 규칙 (source profiles)

특정 프로그램이 그린 PDF에서만 검증된 규칙은 `PROFILES` 에서 그 출처에만 켜요.

| 규칙 | generic | guitarpro | musescore | akbonara |
|---|---|---|---|---|
| 그림 박자표 숫자 읽기 (`vectorTimeSig`) | 끔 | 켬 | 끔 | 끔 |
| 타브 안 빗금 (`tabSlashes`) | 끔 | 켬 | 끔 | 끔 |
| 템포 음표 도형 읽기 (`tempoGlyph`) | 끔 | 켬 | 끔 | 끔 |
| 끊긴 타브 줄 인정 (`gappyTabLines`) | 끔 | 켬 | 끔 | 끔 |

- 출처는 PDF 정보(Creator/Producer)로 정해요 (`detectSource`). 확실하지 않으면 generic이에요.
- 새 규칙은 먼저 검증한 출처에만 켜요. 다른 출처에서도 회귀 검사로 나빠지지 않는 것을 확인한 뒤에만 generic으로 옮겨요.
- 오선보 빗금, SMuFL 글꼴 기호처럼 표준 기보법에 해당하는 규칙은 모든 출처에 적용돼요.
- 악보나라 PDF는 아직 시험 자료가 없어요. 받으면 정답을 만든 뒤 akbonara 프로필에서 규칙을 하나씩 켜요.

## 3. 정답 파일 (ground truth)

형식: `tabmaker-gt/1`. 자세한 설명은 `tests/regress/evaluate.js` 맨 위에 있어요.

- 음·쉼표마다 시작점(on), 길이(dur, 4분음표 = 480), 기호 종류(note/rest/slash/tie/grace), 음표 값·점·잇단음, 줄:프렛, 주법을 적어요.
- `status`:
  - `verified`: 원본과 눈으로 대조했거나, 정답을 알고 만든 시험 악보예요. **정확도는 이것만 셈.**
  - `snapshot`: 아직 확인하지 않은 지금 결과예요. 정확도에는 넣지 않고, 바뀌었는지만 봐요.
  - `review`: 사용자 수정 기록에서 온 후보예요. 대조한 뒤 verified로 바꿔요.
- `fields`: 그 정답에서 확인한 항목이에요. 이 항목만 채점해요 (예: 주법을 확인하지 않았으면 `tech`를 넣지 않음).

### 말뭉치(corpus)

| 위치 | 내용 | 저장소에 넣나 |
|---|---|---|
| `tests/fixtures/` | Verovio로 그린 합성 시험 악보 (MuseScore와 비슷한 오선보) | 넣음 |
| `tests/fixtures-scan/` | 위 악보를 그림으로 바꾼 스캔 시험 악보 (지금은 못 읽음 = 재현율 0%) | 넣음 |
| `TAB_REGRESS_DIR` | 실제 악보 PDF + 정답 (Guitar Pro 2개, 출처를 모르는 악보 2개) | **안 넣음** (저작권) |

실제 악보는 프로젝트 공유 폴더 `/mnt/project-files/regression/` 에 있어요.

## 4. 인식 코드를 바꿀 때마다 하는 일

```
node --test tests/*.test.js                                   # 단위 테스트 + 회귀 테스트 전체
TAB_REGRESS_DIR=/mnt/project-files/regression node tools/regress.js   # 악보별 표
```

1. **전체**를 돌려요. 지금 고치는 버그와 관련된 테스트만 돌리지 않아요.
2. 악보마다 쉼표 정밀도·재현율, 시작점 정밀도·재현율, 정확한 길이 비율을 봐요.
3. 좋아진 것(✅)과 나빠진 것(❌)을 **악보마다 따로** 보고해요.
4. 전에 맞던 마디가 틀리면(❌ 전에 맞던 마디) 원인을 찾아요. 나빠진 채로 기준을 덮어쓰지 않아요.
5. 확인 안 된 마디(snapshot)가 바뀌면 원본과 대조해서 좋아졌는지 나빠졌는지 확인하고, 확인한 마디는 verified로 올려요.
6. 도형 크기 기준값을 한 악보에 맞춰 바꾸지 않아요. 바꿔야 하면 여러 출처의 정답으로 확인해요.
7. 나빠진 것이 없을 때만 `node tools/regress.js --update` 로 기준을 저장해요.

새 악보를 넣을 때: `node tools/make-gt.js 악보.pdf --out 이름.gt.json --id 이름 --source 출처` → 마디를 원본과 대조해 verified로 바꿈 → `--update`.

다른 버전과 비교할 때: `TAB_ENGINE_ROOT=다른/폴더 node tools/regress.js` (그 폴더의 인식 코드로 채점).

## 5. 사용자 수정 기록 (js/corrections.js)

- 도움말 탭 → "수정 기록 남기기 (이 기기에만)". **기본은 꺼짐.**
- 켜면 PDF를 불러온 직후의 인식 결과를 브라우저 저장소에만 적어요. 곡 제목·파일 이름은 적지 않고 PDF 지문(SHA-256)만 적어요.
- [📤 수정 기록 내보내기] = 처음 인식 결과와 지금 악보가 다른 마디만 파일로 만들어요. 사용자가 직접 전달할 때만 밖으로 나가요.
- `node tools/corrections-to-gt.js 수정기록.json 정답.gt.json --pdf 원본.pdf` → 정답 파일에 review 마디로 들어가요.
- **앱은 이 기록으로 스스로 배우지 않아요.** 학습과 모델 갱신 기능은 없어요. 기록은 시험 자료와 앞으로의 학습 자료 후보일 뿐이에요.

## 6. 앞으로: 규칙 + 학습 분류기 (hybrid OMR)

지금은 규칙만으로 판단해요. 나중에 학습된 기호 분류기를 넣을 때도 앱 전체를 바꾸지 않도록 연결점을 만들어 뒀어요.

- `PdfImport.registerClassifier(kind, fn, minConfidence)`
  - kind: `'rest'`, `'slash'` (필요한 곳에 하나씩 추가)
  - `fn(features)` → `{ label, confidence }`. 확신도가 기준(기본 0.9) 이상이고 규칙과 다를 때만 규칙 판단을 대신해요.
  - 등록된 분류기가 없으면 동작은 지금과 똑같아요.
- 입력 특징: `symbolFeatures(shape, sp)` = 오선 간격으로 나눈 크기, 꼭짓점 수, 곡선 여부, 칠한 비율, 갈고리 수.
- 스캔 PDF는 그림에서 같은 모양의 기호 후보(③)를 만들어 내는 앞단을 따로 만들고, ④~⑥은 그대로 쓰는 방향이에요.
- 분류기를 넣을 때도 같은 회귀 검사를 통과해야 해요. 출처별로 켜고 끌 수 있게 프로필에 넣어요.
