# SmorX AutoBalloon API — production image (Python 3.11 + Tesseract OCR)
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-eng \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p /app/data/jobs /app/data/uploads

ENV PYTHONUNBUFFERED=1
ENV UVICORN_WORKERS=2
# Hosts like Render pass the port to listen on in $PORT; 9686 otherwise.
ENV PORT=9686

EXPOSE 9686

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % __import__('os').environ.get('PORT', '9686'), timeout=5)" || exit 1

# 2 workers handles ~10–50 concurrent users; increase on larger EC2 if needed
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --workers ${UVICORN_WORKERS} --timeout-keep-alive 120"]
