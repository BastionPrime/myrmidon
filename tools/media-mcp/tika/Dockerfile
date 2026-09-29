# Apache Tika Server "full" (with Tesseract) plus the Russian OCR model.
# The upstream full image ships eng ita fra spa deu jpn only, and OCR here is rus+eng.
# The base is pinned by digest (3.3.1.0-full); bump it deliberately.
FROM apache/tika@sha256:d8e6ed96260ad89307a93195a1b856102987a818ac648502f8efbaf313d32470
USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tesseract-ocr-rus \
 && rm -rf /var/lib/apt/lists/* \
 && tesseract --list-langs | grep -qx rus
USER 35002:35002
