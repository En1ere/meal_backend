# Local OCR resources

rus/eng models: [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), Apache-2.0. Exact checked-in bytes are recorded in models.manifest.json. Models are loaded locally; application runtime does not download them. Preserve these assets when splitting or deploying the project.

Browser worker/core files (front only) are copied from the exact tesseract.js and tesseract.js-core packages in package-lock.json. They are static runtime assets, not application sources. Fetch only the required core variant on demand.
