import { Module } from '@nestjs/common';
import { DisabledOcrProvider, OCR_PROVIDER } from '../../modules/ocr-infrastructure/public.js';

@Module({
    imports: [],
    controllers: [],
    providers: [DisabledOcrProvider, { provide: OCR_PROVIDER, useExisting: DisabledOcrProvider }],
    exports: [],
})
export class OcrCapabilityModule {}
