FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV ALTEN_EMS_DATA_DIR=/data

ARG BUILD_VERSION=0.1.0
ARG BUILD_ARCH=amd64

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="app" \
  io.hass.arch="${BUILD_ARCH}" \
  org.opencontainers.image.title="Alten EMS Backend" \
  org.opencontainers.image.description="FastAPI backend for BESS EMS optimization and dispatch" \
  org.opencontainers.image.source="https://github.com/Vladislav-lb/Alten" \
  org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY . /app/
RUN chmod +x /app/run.sh

EXPOSE 8000
CMD ["/app/run.sh"]
