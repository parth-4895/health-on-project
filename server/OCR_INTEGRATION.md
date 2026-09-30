# OCR integration

Lab-report extraction runs in one long-lived Python service,
`PaddleOCRFastAPI/` (based on neozhu/PaddleOCRFastAPI, vendored into this
repo). It serves the project's pipeline in `ocr/`: pdfplumber reads digital
PDFs directly, and PaddleOCR reads scans and photos. The models load once when
the service starts and stay in memory.

```
client ──► POST /api/lab-reports/upload (Express)
             ├─ store file in Supabase Storage
             ├─ POST {OCR_SERVICE_URL}/document/process ──► ocr/document_processor.py
             │                                               pdfplumber → PaddleOCR fallback
             └─ standardize metrics, save lab_reports + lab_report_metrics
```

## Running it

```bash
# 1. OCR service (from PaddleOCRFastAPI/)
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # or .venv/bin/pip
.venv/Scripts/python -m uvicorn main:app --port 8000

# or with Docker, from PaddleOCRFastAPI/
docker compose up --build

# 2. API server (from server/)
npm run dev
```

`GET {OCR_SERVICE_URL}/health` returns `{"status": "ok", "ocr_models": ...}`.
`ocr_models` is `pending` while the models load after startup (and, on first
run, download), then `ready`. Digital PDFs are served before that.

## Express endpoints

- `POST /api/lab-reports/upload` is the main flow: multipart `file` (PDF, PNG,
  JPG/JPEG). The upload is always recorded. If extraction fails or the OCR
  service is down, the report is saved with `ocr_status = failed` and no
  metrics, so a clinician can review it by hand.
- `GET /api/ocr/health` checks whether the OCR service is reachable. No auth.
- `POST /api/ocr/recognize` (auth required) returns raw recognized text lines,
  scores and boxes for an image (JPEG, PNG, BMP, TIFF, up to 10 MB). It does
  not create a lab report.

## How results are graded

| `ocr_status` | when |
| --- | --- |
| `success` | test rows were recognized with good confidence |
| `partial` | low mean OCR confidence (< 0.85), some garbled PDF pages, or **no test rows recognized at all** |
| `failed` | no text could be read, or the OCR service could not be reached |

A metric goes to review (`needs_review`) when its value is not a plain
number, is a bound such as `<0.5`, has a unit that cannot be converted, or
falls below `OCR_CONFIDENCE_REVIEW_THRESHOLD`.

## Configuration

Express (`server/.env`): `OCR_SERVICE_URL`, `OCR_TIMEOUT_MS` (default 180000),
`OCR_CONFIDENCE_REVIEW_THRESHOLD`.

OCR service (environment):

| variable | default | purpose |
| --- | --- | --- |
| `OCR_DET_MODEL` / `OCR_REC_MODEL` | `PP-OCRv6_small_det` / `_rec` | use `*_medium_*` on a GPU host |
| `OCR_DEVICE` | auto | `cpu` forces CPU |
| `OCR_DOC_ORIENTATION` / `OCR_DOC_UNWARPING` | off | enable for rotated or curled phone photos (slow) |
| `OCR_WARMUP` | on | load models at startup |
| `OCR_MAX_UPLOAD_BYTES` | 64 MB | upload cap |
| `CORS_ALLOW_ORIGINS` | none | browsers are not expected to call the service |
| `ENABLE_REMOTE_FETCH` | off | re-enables the upstream `predict-by-path` / `predict-by-url` endpoints, which can read server files and fetch arbitrary URLs |

Run one worker per container: each worker process loads its own models.
Keep the service off the public internet (the compose file binds to
127.0.0.1).

## Tests

```bash
npm test                                            # unit + route tests, OCR mocked
OCR_SERVICE_URL=http://localhost:8000 npm run test:e2e   # against a running OCR service
cd ../ocr && python -m unittest discover -s tests   # pipeline tests, no engines needed
node scripts/ocrSmoke.js path/to/report.pdf         # one file, printed
```
