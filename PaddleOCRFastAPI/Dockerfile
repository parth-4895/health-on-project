# Build from the repository root so the lab-report pipeline (../ocr) is in the
# build context:   docker build -f PaddleOCRFastAPI/Dockerfile .
# (docker-compose.yml in this folder already does that.)
FROM python:3.12-slim-bookworm

EXPOSE 8000

WORKDIR /app

ENV PADDLE_PDX_MODEL_SOURCE=BOS \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    OCR_PIPELINE_DIR=/app/pipeline \
    PYTHONUNBUFFERED=1

COPY PaddleOCRFastAPI/requirements.txt /app/requirements.txt

# 安装系统依赖
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libgl1 \
        libgomp1 \
        libglib2.0-0 \
        libsm6 \
        libxrender1 \
        libxext6 \
        ccache && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# 安装 Python 依赖
RUN python3 -m pip install --upgrade pip && \
    pip3 install -r requirements.txt

COPY PaddleOCRFastAPI/ /app
COPY ocr/*.py /app/pipeline/

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"

# One worker: each worker process loads its own copy of the OCR models.
# Scale with more containers rather than more workers per container.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
